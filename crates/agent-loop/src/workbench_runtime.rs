//! Durable workbench transitions share the existing session projection and meter.

use denia_core::session::SessionEvent;
use serde_json::Value;

use crate::{SessionDriver, TurnState, append};

const CHANNEL: &str = "coding-workbench";

pub(crate) async fn prepare(driver: &SessionDriver, state: &TurnState, step: u32) {
    if !driver.features_for(&state.session).compaction || !state.settings.microcompact.enabled {
        return;
    }
    let surface = state.session.derive_surface();
    let events = state.session.with_model_events(|events| events.to_vec());
    let window = state.session.context_pressure().context_window.unwrap_or(128_000);
    let budget_chars = window.saturating_sub(state.output_budget).saturating_mul(4) / 4;
    let budget_chars = budget_chars.clamp(8_000, 48_000) as usize;
    let selections = crate::workbench::plan(&surface, &events, budget_chars);
    for selection in selections {
        let Some(envelope) = events.iter().find(|event| event.seq == selection.seq) else {
            continue;
        };
        let SessionEvent::ToolResult {
            call_id, content, is_error, error, error_identity, meta, truncation, ..
        } = &envelope.event else {
            continue;
        };
        if call_id != &selection.call_id {
            continue;
        }
        let mut fields = meta.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
        let existing = fields.get("outputArtifact").filter(|artifact| {
            artifact.get("complete").and_then(Value::as_bool) == Some(true)
                && artifact.get("output_id").and_then(Value::as_str).is_some()
        });
        if existing.is_none() {
            // Never evict the only recoverable copy when storage is unavailable/full.
            let Some(store) = &state.output_store else { continue };
            let capture = store.start(&["text"]).await;
            capture.append("text", content.as_bytes()).await;
            let artifact = capture.finish(true).await;
            if !artifact.complete { continue; }
            fields.insert("outputArtifact".into(), serde_json::to_value(artifact).unwrap());
        }
        let Some(output_id) = fields.get("outputArtifact")
            .and_then(|artifact| artifact.get("output_id"))
            .and_then(Value::as_str).map(str::to_owned) else { continue };
        fields.insert("workbench".into(), serde_json::json!({
            "reason": selection.reason, "sourceSeq": selection.seq, "archived": true
        }));
        let placeholder = format!(
            "[工作集归档] {}。原工具结果已保存，使用 read_tool_output(output_id=\"{}\") 按需回读。历史快照不代表当前文件；编辑前请 read_file 获取当前内容。",
            selection.reason, output_id
        );
        if append(&state.session, &state.emit, SessionEvent::ToolResult {
            turn: state.turn, step, call_id: call_id.clone(), content: placeholder,
            is_error: *is_error, error: error.clone(), error_identity: error_identity.clone(),
            meta: Some(Value::Object(fields)), truncation: truncation.clone(), replaces: Some(selection.seq),
        }).is_err() { break; }
        if let Ok(mut reads) = state.read_state.lock() {
            reads.invalidate_calls([call_id.as_str()]);
        }
    }
    refresh(state);
}

pub(crate) fn refresh(state: &TurnState) {
    let surface = state.session.derive_surface();
    let events = state.session.with_model_events(|events| events.to_vec());
    let text = crate::workbench::render_state(&surface, &events);
    if text.is_empty() || surface.iter().any(|item| {
        item.channel.as_deref() == Some(CHANNEL) && item.message.content == text
    }) { return; }
    let _ = append(&state.session, &state.emit, SessionEvent::UserMessage {
        text, injected: true, channel: Some(CHANNEL.into()), images: Vec::new(),
    });
}
