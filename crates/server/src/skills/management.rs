use super::{Skill, discover_all, parse, parse_from_str};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

static MUTATIONS: Mutex<()> = Mutex::new(());
const LIMIT: usize = 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkill {
    #[serde(flatten)]
    pub skill: Skill,
    pub enabled: bool,
    pub editable: bool,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    User,
    Project,
}

pub(super) fn identity(skill: &Skill) -> String {
    if skill.source == "bundled" {
        format!("bundled:{}", skill.name)
    } else {
        skill
            .path
            .canonicalize()
            .unwrap_or_else(|_| skill.path.clone())
            .to_string_lossy()
            .into_owned()
    }
}

pub(super) fn disabled(home: &Path) -> Result<BTreeSet<String>, String> {
    let _guard = MUTATIONS.lock().map_err(|e| e.to_string())?;
    read_disabled(home)
}
fn read_disabled(home: &Path) -> Result<BTreeSet<String>, String> {
    match fs::read(home.join("disabled-skills.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("技能启停配置无效：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn cwd(value: Option<String>) -> Result<Option<PathBuf>, String> {
    value
        .map(|value| {
            let path = PathBuf::from(value);
            if !path.is_absolute() || !path.is_dir() {
                return Err("cwd 必须是已存在的绝对目录路径".into());
            }
            path.canonicalize().map_err(|e| e.to_string())
        })
        .transpose()
}

pub fn list(home: &Path, cwd: Option<&Path>) -> Result<Vec<ManagedSkill>, String> {
    let disabled = disabled(home)?;
    Ok(discover_all(home, cwd)?
        .into_iter()
        .map(|skill| {
            let enabled = !disabled.contains(&identity(&skill));
            let editable = skill.source != "bundled" && safe_existing(&skill.path).is_ok();
            ManagedSkill {
                skill,
                enabled,
                editable,
            }
        })
        .collect())
}
fn find(home: &Path, cwd: Option<&Path>, name: &str) -> Result<Skill, String> {
    discover_all(home, cwd)?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("找不到技能：{name}"))
}
pub fn detail(home: &Path, cwd: Option<&Path>, name: &str) -> Result<serde_json::Value, String> {
    let item = list(home, cwd)?
        .into_iter()
        .find(|s| s.skill.name == name)
        .ok_or("找不到技能")?;
    let raw = if item.skill.source == "bundled" {
        super::BUILTIN_SKILLS
            .iter()
            .find(|(n, _)| *n == name)
            .ok_or("找不到内置技能")?
            .1
            .to_string()
    } else {
        fs::read_to_string(&item.skill.path).map_err(|e| e.to_string())?
    };
    let (_, body) = parse_from_str(&raw, &item.skill.path, &item.skill.source)?;
    Ok(serde_json::json!({"skill": item, "body": body, "raw": raw}))
}

// 拒绝路径链上所有链接（包括 Windows junction），而不是只检查末端文件。
fn safe_existing(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("技能路径不允许符号链接或目录联接".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("技能路径不允许符号链接".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn root(home: &Path, cwd: Option<&Path>, scope: Scope) -> Result<PathBuf, String> {
    let root = match scope {
        Scope::User => home.join("skills"),
        Scope::Project => {
            let cwd = cwd.ok_or("项目作用域需要 cwd")?;
            cwd.ancestors()
                .find(|p| p.join(".git").exists())
                .unwrap_or(cwd)
                .join(".denia/skills")
        }
    };
    safe_existing(&root)?;
    Ok(root)
}
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 100
        || !name.split('-').all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    {
        return Err("技能名称必须为不超过 100 字符的小写 kebab-case".into());
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_file_name(format!(".skills-{}.tmp", uuid::Uuid::new_v4()));
    write_new(&temporary, bytes)?;
    let result = fs::rename(&temporary, path).map_err(|e| e.to_string());
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn put(
    home: &Path,
    cwd: Option<&Path>,
    name: &str,
    content: &str,
    create: bool,
    scope: Scope,
) -> Result<(), String> {
    let _guard = MUTATIONS.lock().map_err(|e| e.to_string())?;
    validate_name(name)?;
    if content.len() > LIMIT {
        return Err("技能文件超过 1 MiB".into());
    }
    let path = if create {
        if discover_all(home, cwd)?.iter().any(|s| s.name == name) {
            return Err("同名技能已存在".into());
        }
        root(home, cwd, scope)?.join(name).join("SKILL.md")
    } else {
        let skill = find(home, cwd, name)?;
        if skill.source == "bundled" {
            return Err("内置技能不能编辑".into());
        }
        skill.path
    };
    safe_existing(&path)?;
    let (parsed, _) = parse_from_str(content, &path, "user-denia")?;
    if parsed.name != name {
        return Err("元数据 name 必须与技能名称一致".into());
    }
    if create {
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        write_new(&path, content.as_bytes())
    } else {
        replace(&path, content.as_bytes())
    }
}
pub fn set_enabled(
    home: &Path,
    cwd: Option<&Path>,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    let _guard = MUTATIONS.lock().map_err(|e| e.to_string())?;
    let skill = find(home, cwd, name)?;
    let mut disabled = read_disabled(home)?;
    if enabled {
        disabled.remove(&identity(&skill));
    } else {
        disabled.insert(identity(&skill));
    }
    let path = home.join("disabled-skills.json");
    safe_existing(&path)?;
    replace(
        &path,
        &serde_json::to_vec_pretty(&disabled).map_err(|e| e.to_string())?,
    )
}
pub fn delete(home: &Path, cwd: Option<&Path>, name: &str) -> Result<(), String> {
    let _guard = MUTATIONS.lock().map_err(|e| e.to_string())?;
    let skill = find(home, cwd, name)?;
    if skill.source == "bundled" {
        return Err("内置技能不能删除".into());
    }
    safe_existing(&skill.path)?;
    fs::remove_file(skill.path).map_err(|e| e.to_string())
}

fn collect_files(
    base: &Path,
    dir: &Path,
    files: &mut Vec<(PathBuf, Vec<u8>)>,
    total: &mut usize,
) -> Result<(), String> {
    if files.len() >= 2000 {
        return Err("导入文件过多".into());
    }
    if dir.components().count() - base.components().count() > 32 {
        return Err("导入目录嵌套过深".into());
    }
    safe_existing(dir)?;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        safe_existing(&path)?;
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            collect_files(base, &path, files, total)?;
        } else if meta.is_file() {
            if files.len() >= 2000 {
                return Err("导入文件过多".into());
            }
            if meta.len() > 16 * LIMIT as u64 {
                return Err("导入单文件超过 16 MiB".into());
            }
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            *total += bytes.len();
            if *total > 64 * LIMIT {
                return Err("导入总大小超过 64 MiB".into());
            }
            files.push((
                path.strip_prefix(base).map_err(|e| e.to_string())?.into(),
                bytes,
            ));
        } else {
            return Err("导入仅支持普通文件和目录".into());
        }
    }
    Ok(())
}
pub fn import(
    home: &Path,
    cwd: Option<&Path>,
    path: &Path,
    scope: Scope,
) -> Result<Vec<String>, String> {
    let _guard = MUTATIONS.lock().map_err(|e| e.to_string())?;
    if !path.is_absolute() || !path.is_dir() {
        return Err("导入路径必须是已存在的本地绝对目录".into());
    }
    safe_existing(path)?;
    let mut candidates = Vec::new();
    if path.join("SKILL.md").is_file() {
        candidates.push(path.to_path_buf());
    } else {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let candidate = entry.map_err(|e| e.to_string())?.path();
            safe_existing(&candidate)?;
            if candidate.is_dir() && candidate.join("SKILL.md").is_file() {
                candidates.push(candidate);
            }
        }
    }
    if candidates.is_empty() {
        return Err("目录中没有 SKILL.md 技能".into());
    }
    let destination = root(home, cwd, scope)?;
    let mut names: BTreeSet<String> = discover_all(home, cwd)?
        .into_iter()
        .map(|s| s.name)
        .collect();
    let mut staged = Vec::new();
    let mut total = 0;
    for candidate in candidates {
        safe_existing(&candidate.join("SKILL.md"))?;
        let (skill, _) = parse(&candidate.join("SKILL.md"), "user-denia")?;
        validate_name(&skill.name)?;
        let target = destination.join(&skill.name);
        if !names.insert(skill.name.clone()) || target.exists() {
            return Err(format!("同名技能或目录已存在：{}", skill.name));
        }
        let mut files = Vec::new();
        collect_files(&candidate, &candidate, &mut files, &mut total)?;
        staged.push((skill.name, target, files));
    }
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    for (name, target, files) in staged {
        let temporary = destination.join(format!(".import-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            fs::create_dir(&temporary).map_err(|e| e.to_string())?;
            for (relative, bytes) in files {
                let file = temporary.join(relative);
                fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
                write_new(&file, &bytes)?;
            }
            if target.exists() {
                return Err("目标技能目录已存在".into());
            }
            fs::rename(&temporary, &target).map_err(|e| e.to_string())
        })();
        if temporary.exists() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result?;
        imported.push(name);
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn home() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("denia-skill-management-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn management_and_runtime_policies_are_separate() {
        let home = home();
        let raw = "---\nname: private-skill\ndescription: Private\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody";
        put(&home, None, "private-skill", raw, true, Scope::User).unwrap();
        assert_eq!(detail(&home, None, "private-skill").unwrap()["raw"], raw);
        assert!(
            super::super::load(
                &super::super::discover(&home, &home).unwrap(),
                "private-skill",
                true
            )
            .is_err()
        );
        set_enabled(&home, None, "private-skill", false).unwrap();
        assert!(
            !super::super::discover(&home, &home)
                .unwrap()
                .iter()
                .any(|s| s.name == "private-skill")
        );
        assert!(
            !list(&home, None)
                .unwrap()
                .into_iter()
                .find(|s| s.skill.name == "private-skill")
                .unwrap()
                .enabled
        );
        set_enabled(&home, None, "private-skill", true).unwrap();
        assert!(
            super::super::discover(&home, &home)
                .unwrap()
                .iter()
                .any(|s| s.name == "private-skill")
        );
        set_enabled(&home, None, "denia-guide", false).unwrap();
        assert!(delete(&home, None, "denia-guide").is_err());
        assert!(put(&home, None, "../escape", "Body", true, Scope::User).is_err());
        fs::write(home.join("skills/private-skill/resource.txt"), "keep").unwrap();
        delete(&home, None, "private-skill").unwrap();
        assert!(home.join("skills/private-skill/resource.txt").exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn concurrent_toggles_preserve_both_changes_and_project_scope() {
        let home = home();
        let cwd = home.join("project");
        fs::create_dir_all(&cwd).unwrap();
        put(
            &home,
            Some(&cwd),
            "project-skill",
            "Project skill",
            true,
            Scope::Project,
        )
        .unwrap();
        put(
            &home,
            Some(&cwd),
            "project-skill",
            "Updated description",
            false,
            Scope::Project,
        )
        .unwrap();
        assert!(
            list(&home, None)
                .unwrap()
                .iter()
                .all(|s| s.skill.name != "project-skill")
        );
        assert_eq!(
            detail(&home, Some(&cwd), "project-skill").unwrap()["body"],
            "Updated description"
        );
        std::thread::scope(|scope| {
            scope.spawn(|| set_enabled(&home, None, "denia-guide", false).unwrap());
            scope.spawn(|| set_enabled(&home, None, "skill-creator", false).unwrap());
        });
        assert_eq!(
            list(&home, None)
                .unwrap()
                .iter()
                .filter(|s| !s.enabled)
                .count(),
            2
        );
        fs::remove_dir_all(home).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn import_rejects_symlink_resources() {
        let home = home();
        let source = home.join("source/example");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "Example skill").unwrap();
        std::os::unix::fs::symlink(&home, source.join("escape")).unwrap();
        assert!(import(&home, None, &source, Scope::User).is_err());
        assert!(!home.join("skills/example").exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn import_copies_resources_without_overwriting() {
        let home = home();
        let source = home.join("source/example");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"), "Example description").unwrap();
        fs::write(source.join("references/example.txt"), "resource").unwrap();
        assert_eq!(
            import(&home, None, &home.join("source"), Scope::User).unwrap(),
            vec!["example"]
        );
        assert_eq!(
            fs::read_to_string(home.join("skills/example/references/example.txt")).unwrap(),
            "resource"
        );
        assert!(import(&home, None, &source, Scope::User).is_err());
        assert!(
            put(
                &home,
                None,
                "example",
                "---\nname: changed\ndescription: Changed\n---\nBody",
                false,
                Scope::User
            )
            .is_err()
        );
        fs::remove_dir_all(home).unwrap();
    }
}
