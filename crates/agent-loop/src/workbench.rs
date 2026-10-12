//! Selects tool-result bodies to archive without changing the call/result protocol.

use std::collections::{HashMap, HashSet};

use denia_core::message::ChatRole;
use denia_core::session::{SessionEnvelope, SessionEvent, SurfaceMessage};
use serde_json::Value;

const ARCHIVED: &str = "[工作集归档]";
const CLEARED: &str = "[旧工具结果内容已清理]";
// Reserve room for the archive locator and replacement explanation.
const REPLACEMENT_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selection {
    pub seq: u64,
    pub call_id: String,
    pub reason: String,
}

struct Observation<'a> {
    seq: u64,
    call_id: &'a str,
    name: &'a str,
    arguments: &'a str,
    meta: Option<&'a Value>,
    is_error: bool,
}

fn observations(events: &[SessionEnvelope]) -> HashMap<u64, Observation<'_>> {
    let mut calls = HashMap::new();
    let mut results = HashMap::new();
    for envelope in events {
        match &envelope.event {
            SessionEvent::ToolCall {
                call_id,
                name,
                arguments,
                ..
            } => {
                calls.insert(call_id.as_str(), (name.as_str(), arguments.as_str()));
            }
            SessionEvent::ToolResult {
                call_id,
                meta,
                is_error,
                error,
                error_identity,
                ..
            } => {
                if let Some(&(name, arguments)) = calls.get(call_id.as_str()) {
                    results.insert(
                        envelope.seq,
                        Observation {
                            seq: envelope.seq,
                            call_id,
                            name,
                            arguments,
                            meta: meta.as_ref(),
                            is_error: *is_error || error.is_some() || error_identity.is_some(),
                        },
                    );
                }
            }
            _ => {}
        }
    }
    results
}

fn successful(observation: &Observation<'_>) -> bool {
    if observation.is_error {
        return false;
    }
    if observation.name == "bash" {
        return observation.meta.is_some_and(|meta| {
            meta["exit_code"].as_i64() == Some(0)
                && meta["end_reason"].as_str() == Some("completed")
        });
    }
    !observation.meta.is_some_and(|meta| {
        meta.get("end_reason")
            .is_some_and(|reason| reason.as_str() != Some("completed"))
            || meta
                .get("exit_code")
                .is_some_and(|code| code.as_i64() != Some(0))
    })
}

fn normalize_path(path: &str) -> String {
    let windows = path.contains('\\') || path.as_bytes().get(1) == Some(&b':');
    let path = path.replace('\\', "/");
    let prefix = if path.starts_with("//") {
        "//"
    } else if path.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts
                .last()
                .is_some_and(|last| *last != ".." && !last.ends_with(':')) =>
            {
                parts.pop();
            }
            ".." if !prefix.is_empty() || parts.last().is_some_and(|last| last.ends_with(':')) => {}
            _ => parts.push(part),
        }
    }
    let normalized = format!("{prefix}{}", parts.join("/"));
    if windows {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn observed_path(observation: &Observation<'_>) -> Option<String> {
    let explicit = observation
        .meta
        .and_then(|meta| {
            meta.pointer("/fileEvidence/path")
                .or_else(|| meta.get("path"))
        })
        .and_then(Value::as_str);
    if let Some(path) = explicit {
        return Some(normalize_path(path));
    }
    let arguments: Value = serde_json::from_str(observation.arguments).ok()?;
    arguments
        .get("path")
        .and_then(Value::as_str)
        .map(normalize_path)
}

fn archived(content: &str) -> bool {
    let content = content.trim_start();
    content.starts_with(ARCHIVED) || content.starts_with(CLEARED)
}

fn multimodal(
    item: &SurfaceMessage,
    observation: &Observation<'_>,
    image_paths: &HashSet<String>,
) -> bool {
    !item.message.images.is_empty()
        || observed_path(observation).is_some_and(|path| {
            image_paths.contains(&path)
                || (observation.name == "read_file"
                    && path.rsplit('.').next().is_some_and(|extension| {
                        matches!(extension.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
                    }))
        })
        || observation.meta.is_some_and(|meta| {
            ["images", "video", "audio", "attachments"]
                .iter()
                .any(|key| {
                    meta.get(*key).is_some_and(|value| {
                        !value.is_null() && value.as_array().is_none_or(|items| !items.is_empty())
                    })
                })
        })
}

pub(crate) fn plan(
    surface: &[SurfaceMessage],
    events: &[SessionEnvelope],
    budget_chars: usize,
) -> Vec<Selection> {
    let observations = observations(events);
    let groups: Vec<_> = surface
        .iter()
        .filter(|item| {
            item.message.role == ChatRole::Assistant && !item.message.tool_calls.is_empty()
        })
        .collect();
    let recent: HashSet<&str> = groups
        .iter()
        .rev()
        .take(2)
        .flat_map(|item| item.message.tool_calls.iter().map(|call| call.id.as_str()))
        .collect();
    let active_calls: HashMap<&str, &str> = groups
        .iter()
        .flat_map(|item| {
            item.message
                .tool_calls
                .iter()
                .map(|call| (call.id.as_str(), call.name.as_str()))
        })
        .collect();
    let image_paths: HashSet<String> = surface
        .iter()
        .flat_map(|item| &item.message.images)
        .filter_map(|image| image.path.as_deref().map(normalize_path))
        .collect();
    let writes: Vec<_> = observations
        .values()
        .filter(|observation| {
            matches!(observation.name, "edit" | "write_file") && successful(observation)
        })
        .filter_map(|observation| observed_path(observation).map(|path| (observation.seq, path)))
        .collect();
    let keywords: Vec<String> = surface
        .iter()
        .rev()
        .filter(|item| item.message.role == ChatRole::User && item.channel.is_none())
        .take(2)
        .flat_map(|item| {
            item.message.content.split(|c: char| {
                !c.is_alphanumeric() && c != '_' && c != '.' && c != '/' && c != '\\'
            })
        })
        .filter(|word| word.chars().count() >= 3)
        .take(64)
        .map(str::to_lowercase)
        .collect();
    let recent_paths: HashSet<_> = surface
        .iter()
        .rev()
        .filter_map(|item| observations.get(&item.seq))
        .filter(|observation| successful(observation))
        .filter_map(observed_path)
        .take(6)
        .collect();
    let mut remaining: usize = surface
        .iter()
        .map(|item| {
            item.message.content.chars().count()
                + item
                    .message
                    .reasoning_content
                    .as_deref()
                    .map_or(0, |text| text.chars().count())
                + item
                    .message
                    .tool_calls
                    .iter()
                    .map(|call| call.arguments.chars().count())
                    .sum::<usize>()
        })
        .sum();
    let mut selected = Vec::new();
    let mut candidates = Vec::new();
    for item in surface {
        if item.message.role != ChatRole::Tool || item.is_error || archived(&item.message.content) {
            continue;
        }
        let Some(observation) = observations.get(&item.seq) else {
            continue;
        };
        if item.message.tool_call_id.as_deref() != Some(observation.call_id)
            || active_calls.get(observation.call_id).copied() != Some(observation.name)
            || !successful(observation)
            || multimodal(item, observation, &image_paths)
        {
            continue;
        }
        let path = observed_path(observation);
        let savings = item
            .message
            .content
            .chars()
            .count()
            .saturating_sub(REPLACEMENT_CHARS);
        if observation.name == "read_file"
            && path.as_ref().is_some_and(|path| {
                writes
                    .iter()
                    .any(|(seq, written)| *seq > item.seq && written == path)
            })
        {
            selected.push(Selection {
                seq: item.seq,
                call_id: observation.call_id.into(),
                reason: "stale_file_read".into(),
            });
            remaining = remaining.saturating_sub(savings);
            continue;
        }
        if !matches!(
            observation.name,
            "read_file" | "grep" | "glob" | "ls" | "bash"
        ) || recent.contains(observation.call_id)
            || savings <= 512
            || !observation.meta.is_some_and(|meta| {
                meta.pointer("/outputArtifact/complete")
                    .and_then(Value::as_bool)
                    == Some(true)
            })
        {
            continue;
        }
        let searchable =
            format!("{} {}", observation.arguments, item.message.content).to_lowercase();
        let relevant = keywords.iter().any(|keyword| searchable.contains(keyword));
        let touched = path
            .as_ref()
            .is_some_and(|path| recent_paths.contains(path));
        candidates.push((relevant, touched, savings, item.seq, observation.call_id));
    }
    candidates.sort_by_key(|&(relevant, touched, savings, seq, _)| {
        (relevant, touched, std::cmp::Reverse(savings), seq)
    });
    for (_, _, savings, seq, call_id) in candidates {
        if remaining <= budget_chars {
            break;
        }
        selected.push(Selection {
            seq,
            call_id: call_id.into(),
            reason: "working_set_budget".into(),
        });
        remaining = remaining.saturating_sub(savings);
    }
    selected.sort_by_key(|selection| selection.seq);
    selected
}

/// Only facts still represented by the caller's history projection belong here.
pub(crate) fn render_state(surface: &[SurfaceMessage], events: &[SessionEnvelope]) -> String {
    let observations = observations(events);
    let mut paths = HashSet::new();
    let mut files = Vec::new();
    let mut executions = Vec::new();
    for item in surface.iter().rev() {
        if item.message.role != ChatRole::Tool {
            continue;
        }
        let Some(observation) = observations.get(&item.seq) else {
            continue;
        };
        if item.message.tool_call_id.as_deref() != Some(observation.call_id) {
            continue;
        }
        if observation.name == "bash" && executions.len() < 6 {
            if let Some(meta) = observation.meta {
                executions.push(serde_json::json!({
                    "seq": item.seq,
                    "exit_code": meta.get("exit_code"),
                    "end_reason": meta.get("end_reason"),
                }));
            }
        } else if !item.is_error && successful(observation) && files.len() < 12 {
            let Some(evidence) = observation.meta.and_then(|meta| meta.get("fileEvidence")) else {
                continue;
            };
            let Some(path) = observed_path(observation) else {
                continue;
            };
            if !paths.insert(path.clone()) {
                continue;
            }
            files.push(serde_json::json!({
                "path": path,
                "seq": item.seq,
                "operation": evidence.get("operation"),
                "snapshotReliable": evidence.get("snapshotReliable"),
            }));
        }
    }
    if files.is_empty() && executions.is_empty() {
        return String::new();
    }
    loop {
        let state = format!(
            "[工作集事实索引]\n{}",
            serde_json::json!({"files": files, "executions": executions})
        );
        if state.chars().count() <= 2500 {
            return state;
        }
        if files.pop().is_none() && executions.pop().is_none() {
            return String::new();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use denia_core::message::{ChatMessage, ImageData, ToolCallRef};
    use serde_json::json;

    #[derive(Default)]
    struct Fixture {
        surface: Vec<SurfaceMessage>,
        events: Vec<SessionEnvelope>,
    }

    impl Fixture {
        fn add(&mut self, name: &str, arguments: Value, content: &str, meta: Value) -> u64 {
            let seq = self.events.len() as u64 + 1;
            let call_id = format!("call_{seq}");
            let arguments = arguments.to_string();
            self.events.push(SessionEnvelope {
                seq,
                time: 0,
                event: SessionEvent::ToolCall {
                    turn: 1,
                    step: seq as u32,
                    call_id: call_id.clone(),
                    name: name.into(),
                    arguments: arguments.clone(),
                },
            });
            self.surface.push(SurfaceMessage {
                seq,
                is_error: false,
                channel: None,
                message: ChatMessage::assistant(
                    "",
                    None,
                    vec![ToolCallRef {
                        id: call_id.clone(),
                        name: name.into(),
                        arguments,
                    }],
                ),
            });
            self.events.push(SessionEnvelope {
                seq: seq + 1,
                time: 0,
                event: SessionEvent::ToolResult {
                    turn: 1,
                    step: seq as u32,
                    call_id: call_id.clone(),
                    content: content.into(),
                    is_error: false,
                    error: None,
                    error_identity: None,
                    meta: Some(meta),
                    truncation: None,
                    replaces: None,
                },
            });
            self.surface.push(SurfaceMessage {
                seq: seq + 1,
                is_error: false,
                channel: None,
                message: ChatMessage::tool_result(call_id, content),
            });
            seq + 1
        }
        fn tail(&mut self) {
            for _ in 0..2 {
                self.add("ls", json!({}), "small", json!({}));
            }
        }
        fn plan(&self, budget: usize) -> Vec<Selection> {
            plan(&self.surface, &self.events, budget)
        }
    }

    fn recoverable() -> Value {
        json!({"outputArtifact":{"complete":true}})
    }

    #[test]
    fn budget_keeps_recent_groups_and_requires_complete_artifact() {
        let mut f = Fixture::default();
        let old = f.add("grep", json!({}), &"x".repeat(2000), recoverable());
        f.add(
            "grep",
            json!({}),
            &"y".repeat(3000),
            json!({"outputArtifact":{"complete":false}}),
        );
        f.add("ls", json!({}), &"z".repeat(3000), recoverable());
        f.add("ls", json!({}), &"q".repeat(3000), recoverable());
        assert_eq!(
            f.plan(0).iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![old]
        );
        assert!(f.plan(usize::MAX).is_empty());
    }

    #[test]
    fn paginated_reads_are_not_duplicates() {
        let mut f = Fixture::default();
        f.add(
            "read_file",
            json!({"path":"a.rs","offset":1,"limit":20}),
            "first page",
            recoverable(),
        );
        f.add(
            "read_file",
            json!({"path":"a.rs","offset":21,"limit":20}),
            "second page",
            recoverable(),
        );
        f.tail();
        assert!(f.plan(0).is_empty());
    }

    #[test]
    fn stale_reads_override_recency_and_minimum_savings() {
        let mut f = Fixture::default();
        let read = f.add(
            "read_file",
            json!({"path":"wrong"}),
            "old",
            json!({"fileEvidence":{"path":"C:\\Repo\\src\\..\\A.rs"}}),
        );
        f.add("edit", json!({"path":"c:/repo/a.rs"}), "done", json!({}));
        let selections = f.plan(usize::MAX);
        assert_eq!(selections.len(), 1);
        assert_eq!(selections[0].seq, read);
        assert_eq!(selections[0].reason, "stale_file_read");
        f.surface[1].message.content = format!("{ARCHIVED} stored");
        assert!(f.plan(0).is_empty());
    }

    #[test]
    fn writes_outside_surface_still_invalidate_but_failed_writes_do_not() {
        let mut f = Fixture::default();
        f.add("read_file", json!({"path":"./src/a.rs"}), "old", json!({}));
        f.add(
            "write_file",
            json!({"path":"src/a.rs"}),
            "done",
            json!({"end_reason":"cancelled"}),
        );
        assert!(f.plan(0).is_empty());
        f.add("write_file", json!({"path":"src/a.rs"}), "done", json!({}));
        f.surface.truncate(2);
        assert_eq!(f.plan(usize::MAX).len(), 1);
    }

    #[test]
    fn protects_failed_bash_errors_multimodal_and_missing_sources() {
        let mut f = Fixture::default();
        for meta in [
            json!({"exit_code":1,"end_reason":"completed"}),
            json!({"exit_code":0,"end_reason":"timeout"}),
            json!({"exit_code":0}),
        ] {
            let mut meta = meta;
            meta["outputArtifact"] = json!({"complete":true});
            f.add("bash", json!({}), &"x".repeat(2000), meta);
        }
        f.add("grep", json!({}), &"x".repeat(2000), recoverable());
        f.surface.last_mut().unwrap().is_error = true;
        f.add(
            "read_file",
            json!({"path":"a.png"}),
            &"x".repeat(2000),
            recoverable(),
        );
        f.surface
            .last_mut()
            .unwrap()
            .message
            .images
            .push(ImageData {
                mime: "image/png".into(),
                data: "image".into(),
                path: None,
            });
        let missing = f.add("ls", json!({}), &"x".repeat(2000), recoverable());
        f.events.retain(|event| event.seq != missing);
        f.tail();
        assert!(f.plan(0).is_empty());
    }

    #[test]
    fn unloads_largest_irrelevant_body_first_and_stops_at_budget() {
        let mut f = Fixture::default();
        f.add("grep", json!({}), &"a".repeat(1000), recoverable());
        let largest = f.add("grep", json!({}), &"b".repeat(4000), recoverable());
        f.add("grep", json!({}), &"c".repeat(2000), recoverable());
        f.tail();
        assert_eq!(
            f.plan(4000).iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![largest]
        );
    }

    #[test]
    fn successful_bash_and_keyword_priority() {
        let mut f = Fixture::default();
        f.surface.push(SurfaceMessage {
            seq: 0,
            is_error: false,
            channel: None,
            message: ChatMessage::user("needle"),
        });
        f.add("grep", json!({}), &format!("needle{}", "x".repeat(4000)), recoverable());
        let bash = f.add("bash", json!({}), &"x".repeat(2000), json!({"exit_code":0,"end_reason":"completed","outputArtifact":{"complete":true}}));
        f.tail();
        assert_eq!(f.plan(5000).iter().map(|s| s.seq).collect::<Vec<_>>(), vec![bash]);
    }

    #[test]
    fn stale_image_and_cleared_results_are_never_selected() {
        let mut f = Fixture::default();
        f.add("read_file", json!({"path":"a.PNG"}), "image body", json!({}));
        f.add("write_file", json!({"path":"a.PNG"}), "done", json!({}));
        f.add("ls", json!({}), &format!("{CLEARED}{}", "x".repeat(2000)), recoverable());
        f.tail();
        assert!(f.plan(0).is_empty());
    }

    #[test]
    fn lexical_paths_do_not_conflate_distinct_roots() {
        assert_eq!(normalize_path("./src/x/../a.rs"), "src/a.rs");
        assert_eq!(normalize_path("C:\\Repo\\.\\A.rs"), "c:/repo/a.rs");
        assert_ne!(normalize_path("/a.rs"), normalize_path("a.rs"));
        assert_ne!(normalize_path("../a.rs"), normalize_path("a.rs"));
    }

    #[test]
    fn state_is_bounded_and_only_uses_projected_facts() {
        let mut f = Fixture::default();
        for index in 0..20 {
            f.add("read_file", json!({}), "body", json!({"fileEvidence":{"path":format!("file{index}.rs"),"operation":"read","snapshotReliable":true}}));
        }
        let state = render_state(&f.surface, &f.events);
        assert!(state.chars().count() <= 2500);
        let facts: Value = serde_json::from_str(state.split_once('\n').unwrap().1).unwrap();
        assert_eq!(facts["files"].as_array().unwrap().len(), 12);
        assert!(render_state(&[], &f.events).is_empty());
    }
}
