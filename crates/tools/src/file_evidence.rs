use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEvidence {
    pub path: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    pub fingerprint: FileFingerprint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    /// Completeness of the requested view, not whether the range covers the file.
    pub complete: bool,
    /// Metadata observations agree; this is not an atomic filesystem snapshot.
    pub snapshot_reliable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFingerprint {
    pub algorithm: String,
    pub value: String,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SnapshotStamp {
    size: u64,
    modified: Option<SystemTime>,
}

impl SnapshotStamp {
    pub(crate) fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_evidence_changed_snapshot_is_not_reliable() {
        let before = SnapshotStamp {
            size: 1,
            modified: Some(UNIX_EPOCH),
        };
        let after = SnapshotStamp {
            size: 2,
            modified: Some(UNIX_EPOCH),
        };
        let evidence = FileEvidence::read(
            Path::new("evidence"),
            Fingerprint::new(),
            Some(before),
            Some(after),
            true,
        );
        assert!(!evidence.snapshot_reliable);
        let missing =
            FileEvidence::read(Path::new("evidence"), Fingerprint::new(), None, None, true);
        assert!(!missing.snapshot_reliable);
    }

    #[test]
    fn file_evidence_fingerprint_is_streaming_and_stable() {
        let mut whole = Fingerprint::new();
        whole.update(b"hello");
        let mut chunks = Fingerprint::new();
        chunks.update(b"he");
        chunks.update(b"llo");
        assert_eq!(whole.0, chunks.0);
        assert_eq!(whole.0, 0xa430d84680aabd0b);
        let old: crate::ExecutionReport = serde_json::from_str("{}").unwrap();
        assert!(old.file_evidence.is_none());
        assert!(
            serde_json::to_value(old)
                .unwrap()
                .get("fileEvidence")
                .is_none()
        );
    }
}

pub(crate) struct Fingerprint(u64);

impl Fingerprint {
    pub(crate) fn new() -> Self {
        Self(0xcbf29ce484222325)
    }

    pub(crate) fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}

impl FileEvidence {
    pub(crate) fn read(
        path: &Path,
        fingerprint: Fingerprint,
        before: Option<SnapshotStamp>,
        after: Option<SnapshotStamp>,
        complete: bool,
    ) -> Self {
        let reliable = before.is_some()
            && before == after
            && after.as_ref().is_some_and(|stamp| stamp.modified.is_some());
        Self {
            path: crate::coordination::lock_key(path)
                .to_string_lossy()
                .into_owned(),
            operation: "read".into(),
            offset: None,
            limit: None,
            fingerprint: FileFingerprint {
                algorithm: "fnv1a64".into(),
                value: format!("{:016x}", fingerprint.0),
            },
            size_bytes: after.as_ref().map(|stamp| stamp.size),
            mtime_ms: after
                .and_then(|stamp| stamp.modified)
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as u64),
            complete,
            snapshot_reliable: reliable,
        }
    }

    pub(crate) fn written(path: &Path, operation: &str, bytes: &[u8]) -> Self {
        let stamp = SnapshotStamp::of(path);
        let mut fingerprint = Fingerprint::new();
        fingerprint.update(bytes);
        let mut evidence = Self::read(path, fingerprint, stamp.clone(), stamp, true);
        evidence.operation = operation.into();
        evidence.snapshot_reliable &= evidence.size_bytes == Some(bytes.len() as u64);
        evidence
    }

    pub(crate) fn report(self) -> crate::ExecutionReport {
        crate::ExecutionReport {
            file_evidence: Some(self),
            ..Default::default()
        }
    }
}
