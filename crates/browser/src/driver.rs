//! 浏览器驱动:探测本机 Chromium 系浏览器(Chrome/Edge)、启动实例、
//! 建立 CDP 连接并看护生命周期。
//!
//! # 架构
//!
//! ```text
//! denia ──▶ chromiumoxide(CDP over WebSocket,纯 Rust)
//!              └─▶ 系统 Chrome/Edge(零下载、零打包,发布版自包含)
//! ```
//!
//! 与旧实现(playwright-rs + 官方 Node driver)的区别:
//! - 不再依赖 Node/Playwright driver:旧实现把 driver 目录的**构建机绝对
//!   路径**编译期钉进 exe,CI 构建出的发布版在用户机器上找不到该路径,
//!   浏览器工具直接不可用;现在 exe 只依赖系统浏览器;
//! - 不再需要首次下载数百 MB 的 Playwright 浏览器;
//! - 进程与 CDP 连接由本模块照看:连接断开(浏览器退出/被杀)即触发退出
//!   信号,上层清理会话并按需重新拉起。

use std::path::{Path, PathBuf};

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::handler::viewport::Viewport;
use chromiumoxide::Handler;
use futures::StreamExt;

/// 一个已就绪的浏览器会话。
pub struct Session {
    /// chromiumoxide 浏览器句柄(命令入口;进程由其托管,drop 时兜底 kill)。
    pub browser: Browser,
    /// 本实例代次:看护与清理只认这一代。
    pub generation: u64,
}

/// 会话退出信号:浏览器进程退出/连接断开时触发。
pub type SessionExit = tokio::sync::oneshot::Receiver<()>;

/// 启动参数。
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    /// profile 目录(持久化,存 cookie/localStorage)。
    pub profile_dir: PathBuf,
    /// 产物目录(下载等,预留)。
    pub artifacts_dir: PathBuf,
    /// 是否无头。denia 固定无窗口(headless)后台运行,
    /// 用户画面走控制台面板的 screencast,不弹浏览器窗口。
    pub headless: bool,
    /// 视口尺寸。
    pub viewport: (u32, u32),
    /// 附加 Chromium 启动参数。
    pub args: Vec<String>,
}

impl LaunchSpec {
    pub fn new(home: &Path) -> Self {
        let browser_home = home.join("browser");
        Self {
            profile_dir: browser_home.join("profile"),
            artifacts_dir: browser_home.join("artifacts"),
            headless: true,
            viewport: (1440, 900),
            args: Vec::new(),
        }
    }
}

/// 拉起浏览器并建立 CDP 连接,返回会话与退出信号。
pub async fn launch(spec: &LaunchSpec, generation: u64) -> Result<(Session, SessionExit), String> {
    std::fs::create_dir_all(&spec.profile_dir)
        .map_err(|error| format!("创建浏览器 profile 目录失败: {error}"))?;
    std::fs::create_dir_all(&spec.artifacts_dir)
        .map_err(|error| format!("创建浏览器产物目录失败: {error}"))?;

    let executable = detect_browser_executable()?;
    tracing::info!("使用本机浏览器: {}", executable.display());

    let viewport = Viewport {
        width: spec.viewport.0,
        height: spec.viewport.1,
        device_scale_factor: None,
        emulating_mobile: false,
        is_landscape: false,
        has_touch: false,
    };

    let mut builder = BrowserConfig::builder()
        .chrome_executable(&executable)
        .user_data_dir(&spec.profile_dir)
        .window_size(spec.viewport.0, spec.viewport.1)
        .viewport(Some(viewport))
        .arg("--no-first-run")
        .arg("--no-default-browser-check");
    builder = if spec.headless {
        builder.new_headless_mode()
    } else {
        builder.with_head()
    };
    for arg in &spec.args {
        builder = builder.arg(arg.clone());
    }
    let config = builder.build()?;

    let (browser, handler) = Browser::launch(config)
        .await
        .map_err(|error| format!("启动浏览器失败({}): {error}", executable.display()))?;

    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(drive_handler(handler, exit_tx));

    Ok((
        Session {
            browser,
            generation,
        },
        exit_rx,
    ))
}

/// 持续驱动 CDP 事件循环。
///
/// chromiumoxide 的命令/事件都依赖 handler 被持续 poll。连接级错误
/// (socket 断开等)会以 `Err` 冒出,此时提前触发退出信号;浏览器进程
/// 被杀时事件流可能只是静默停摆(不结束),那一路径由上层对
/// `Browser::try_wait` 的轮询兜底(见 manager.rs 的看护任务)。
async fn drive_handler(mut handler: Handler, exit: tokio::sync::oneshot::Sender<()>) {
    loop {
        match handler.next().await {
            Some(Ok(())) => continue,
            Some(Err(error)) => {
                tracing::info!("浏览器连接断开: {error}");
                break;
            }
            None => {
                tracing::info!("浏览器事件循环结束");
                break;
            }
        }
    }
    let _ = exit.send(());
}

/// 探测本机可用的 Chromium 系浏览器可执行文件。
///
/// 顺序:
/// 1. `DENIA_BROWSER_EXECUTABLE`(显式覆盖,测试/特殊环境用);
/// 2. `CHROME`(与 chromiumoxide 探测约定一致);
/// 3. 常见安装路径:Chrome(系统级/用户级)→ Edge(系统级/用户级);
/// 4. chromiumoxide 自带探测(含注册表/PATH)。
pub fn detect_browser_executable() -> Result<PathBuf, String> {
    if let Some(path) = env_executable("DENIA_BROWSER_EXECUTABLE") {
        return Ok(path);
    }
    if let Some(path) = env_executable("CHROME") {
        return Ok(path);
    }
    if let Some(path) = common_install_paths().into_iter().find(|path| path.is_file()) {
        return Ok(path);
    }
    chromiumoxide::detection::default_executable(chromiumoxide::detection::DetectionOptions {
        msedge: true,
        unstable: false,
    })
    .map_err(|error| {
        format!(
            "未找到可用的 Chrome/Edge 浏览器: {error}。\
             请安装 Chrome 或 Edge,或设置 DENIA_BROWSER_EXECUTABLE 指向浏览器可执行文件"
        )
    })
}

fn env_executable(name: &str) -> Option<PathBuf> {
    let value = std::env::var(name).ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_file().then_some(path)
}

/// 常见安装路径(Windows 优先 Chrome,再 Edge;其它平台交给 chromiumoxide 探测)。
fn common_install_paths() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut paths = Vec::new();
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
        let program_files_x86 = std::env::var("ProgramFiles(x86)")
            .unwrap_or_else(|_| r"C:\Program Files (x86)".to_string());
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        for path in [
            format!(r"{program_files}\Google\Chrome\Application\chrome.exe"),
            format!(r"{program_files_x86}\Google\Chrome\Application\chrome.exe"),
            format!(r"{local_app_data}\Google\Chrome\Application\chrome.exe"),
            format!(r"{program_files_x86}\Microsoft\Edge\Application\msedge.exe"),
            format!(r"{program_files}\Microsoft\Edge\Application\msedge.exe"),
            format!(r"{local_app_data}\Microsoft\Edge\Application\msedge.exe"),
        ] {
            paths.push(PathBuf::from(path));
        }
        paths
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}
