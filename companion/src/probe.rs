use crate::auth::{redact_auth_diagnostic, PreparedAuth};
use crate::protocol::{
    AuthRequest, ErrorCode, HostError, MediaSummary, ProbeRequest, SelectionOption,
};
use crate::runner::{ManagedTool, ProcessRunner, RunPolicy};
use crate::security::{
    bounded_text, create_private_dir, opaque_token, validate_public_page_url,
    validate_resolved_public_page_url,
};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROBE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_RAW_PROBE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CachedSelection {
    pub key: String,
    pub label: String,
    pub selector: String,
    pub estimated_bytes: Option<u64>,
    pub expected_container: Option<String>,
    pub audio_only: bool,
}

#[derive(Debug, Clone)]
pub struct ProbeRecord {
    pub token: String,
    /// Original active-page identity, preserving its query and omitting only the fragment.
    pub requested_page_url: String,
    /// Extractor-canonical URL used for yt-dlp execution and output identity.
    pub page_url: String,
    pub extractor_key: String,
    pub media_id: String,
    pub title: String,
    pub duration_ms: Option<u64>,
    pub is_live: bool,
    pub is_drm: bool,
    pub selections: HashMap<String, CachedSelection>,
    pub(crate) created: SystemTime,
}

impl ProbeRecord {
    pub fn selection(&self, key: &str) -> Result<&CachedSelection, HostError> {
        self.selections.get(key).ok_or_else(|| {
            HostError::new(
                ErrorCode::FormatUnavailable,
                "The selected format is no longer available; analyze the page again",
            )
        })
    }
}

#[derive(Default)]
pub struct ProbeCache {
    records: HashMap<String, ProbeRecord>,
}

impl ProbeCache {
    pub fn insert(&mut self, record: ProbeRecord) {
        self.purge_expired();
        self.records.insert(record.token.clone(), record);
    }

    pub fn get(&mut self, token: &str) -> Result<ProbeRecord, HostError> {
        self.purge_expired();
        self.records.get(token).cloned().ok_or_else(|| {
            HostError::new(
                ErrorCode::ProbeExpired,
                "The page analysis expired; analyze the page again",
            )
        })
    }

    pub fn invalidate_page(&mut self, page_url: &str) {
        self.records
            .retain(|_, record| record.requested_page_url == page_url);
    }

    fn purge_expired(&mut self) {
        self.records.retain(|_, record| {
            record
                .created
                .elapsed()
                .map(|elapsed| elapsed < PROBE_TTL)
                .unwrap_or(false)
        });
    }
}

pub fn probe(
    request: &ProbeRequest,
    runner: &ProcessRunner,
    temp_root: &Path,
    brave_profiles: &[String],
    developer_mode: bool,
    cancelled: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<(MediaSummary, ProbeRecord), HostError> {
    let page_url = validate_public_page_url(&request.page_url, developer_mode)?;
    validate_auth_page(&request.auth, page_url.as_str(), developer_mode)?;
    let temp = ProbeTemp::create(temp_root)?;
    let prepared_auth =
        PreparedAuth::prepare(&request.auth, temp.path(), brave_profiles, developer_mode)?;
    let mut args = vec![
        "--ignore-config".to_owned(),
        "--no-plugin-dirs".to_owned(),
        "--no-js-runtimes".to_owned(),
        "--js-runtimes".to_owned(),
        managed_js_runtime_arg(runner)?,
        "--no-remote-components".to_owned(),
        "--no-playlist".to_owned(),
        "--no-write-info-json".to_owned(),
        "--no-write-playlist-metafiles".to_owned(),
        "--no-write-thumbnail".to_owned(),
        "--skip-download".to_owned(),
        "--dump-single-json".to_owned(),
        "--cache-dir".to_owned(),
        temp.path().join("cache").to_string_lossy().into_owned(),
    ];
    args.extend(prepared_auth.args.iter().cloned());
    args.push("--".to_owned());
    args.push(page_url.to_string());
    validate_resolved_public_page_url(&page_url, developer_mode)?;
    let output = runner.run(
        ManagedTool::YtDlp,
        &args,
        temp.path(),
        RunPolicy::probe(
            matches!(request.auth, AuthRequest::BraveProfile { .. }),
            timeout,
        ),
        cancelled,
        |_| {},
    )?;
    if !output.status.success() {
        return Err(classify_probe_failure(&request.auth, &output.stderr));
    }
    let raw = output.stdout_lines.join("\n");
    if raw.len() > MAX_RAW_PROBE_BYTES {
        return Err(HostError::new(
            ErrorCode::ToolsIncompatible,
            "yt-dlp returned an oversized page analysis",
        ));
    }
    let mut value: Value = serde_json::from_str(&raw).map_err(|_| {
        HostError::new(
            ErrorCode::ToolsIncompatible,
            "yt-dlp returned an invalid structured page analysis",
        )
    })?;
    if value.get("_type").and_then(Value::as_str) == Some("playlist")
        || value.get("entries").is_some()
    {
        let entries = value
            .get_mut("entries")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                HostError::new(
                    ErrorCode::PlaylistUnsupported,
                    "Playlist workflows are not supported in this version",
                )
            })?;
        if entries.len() != 1 {
            return Err(HostError::new(
                ErrorCode::PlaylistUnsupported,
                "Playlist workflows are not supported in this version",
            ));
        }
        value = entries.pop().unwrap();
    }
    normalize_probe(value, canonical_page_identity(&page_url), developer_mode)
}

fn managed_js_runtime_arg(runner: &ProcessRunner) -> Result<String, HostError> {
    let path = runner.paths().js_runtime.as_ref().ok_or_else(|| {
        HostError::new(
            ErrorCode::ToolsIncompatible,
            "The managed JavaScript runtime is missing",
        )
    })?;
    let runtime = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| matches!(*name, "deno" | "node"))
        .ok_or_else(|| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "The managed JavaScript runtime is incompatible",
            )
        })?;
    Ok(format!("{runtime}:{}", path.to_string_lossy()))
}

fn normalize_probe(
    value: Value,
    requested_url: String,
    developer_mode: bool,
) -> Result<(MediaSummary, ProbeRecord), HostError> {
    let object = value.as_object().ok_or_else(|| {
        HostError::new(
            ErrorCode::ToolsIncompatible,
            "yt-dlp page analysis was not a media object",
        )
    })?;
    let extractor_key = bounded_text(
        object
            .get("extractor_key")
            .or_else(|| object.get("extractor"))
            .and_then(Value::as_str),
        "Generic",
        128,
    );
    let media_id = bounded_text(object.get("id").and_then(Value::as_str), "media", 256);
    let title = bounded_text(
        object.get("title").and_then(Value::as_str),
        "Untitled media",
        512,
    );
    let webpage_url = object
        .get("webpage_url")
        .and_then(Value::as_str)
        .and_then(|url| validate_public_page_url(url, developer_mode).ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| requested_url.clone());
    let duration_ms = finite_nonnegative(object.get("duration"))
        .map(|duration| (duration * 1000.0).round())
        .filter(|duration| *duration <= u64::MAX as f64)
        .map(|duration| duration as u64);
    let is_live = object
        .get("is_live")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || object.get("live_status").and_then(Value::as_str) == Some("is_live");
    let is_drm = object
        .get("_has_drm")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || object
            .get("has_drm")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let estimate = object
        .get("filesize_approx")
        .or_else(|| object.get("filesize"))
        .and_then(Value::as_u64)
        .or_else(|| estimate_from_formats(object.get("formats")));
    let selections = build_selections(estimate);
    let token = opaque_token("probe")?;
    let probed_at = now_ms();
    let thumbnail_url = object
        .get("thumbnail")
        .and_then(Value::as_str)
        .and_then(|input| validate_public_page_url(input, developer_mode).ok())
        .map(|mut url| {
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        });
    let uploader = object
        .get("uploader")
        .and_then(Value::as_str)
        .map(|value| bounded_text(Some(value), "", 256))
        .filter(|value| !value.is_empty());
    let options = selections
        .values()
        .map(|selection| SelectionOption::Preset {
            key: selection.key.clone(),
            label: selection.label.clone(),
            estimated_bytes: selection.estimated_bytes,
            expected_container: selection.expected_container.clone(),
        })
        .collect();
    let summary = MediaSummary {
        extractor_key: extractor_key.clone(),
        media_id: media_id.clone(),
        webpage_url: webpage_url.clone(),
        title: title.clone(),
        duration_ms,
        thumbnail_url,
        uploader,
        is_live,
        is_drm,
        selections: options,
        probe_token: token.clone(),
        probed_at,
    };
    let record = ProbeRecord {
        token,
        requested_page_url: requested_url,
        page_url: webpage_url,
        extractor_key,
        media_id,
        title,
        duration_ms,
        is_live,
        is_drm,
        selections,
        created: SystemTime::now(),
    };
    Ok((summary, record))
}

fn build_selections(estimate: Option<u64>) -> HashMap<String, CachedSelection> {
    [
        (
            "best",
            "Best available",
            "bestvideo*+bestaudio/best",
            None,
            false,
        ),
        (
            "best-mp4",
            "Best MP4-compatible",
            "bestvideo*[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            Some("mp4"),
            false,
        ),
        (
            "up-to-1080p",
            "Up to 1080p",
            "bestvideo*[height<=1080]+bestaudio/best[height<=1080]/best",
            None,
            false,
        ),
        (
            "up-to-720p",
            "Up to 720p",
            "bestvideo*[height<=720]+bestaudio/best[height<=720]/best",
            None,
            false,
        ),
        ("audio-only", "Audio only", "bestaudio/best", None, true),
    ]
    .into_iter()
    .map(|(key, label, selector, container, audio_only)| {
        (
            key.to_owned(),
            CachedSelection {
                key: key.to_owned(),
                label: label.to_owned(),
                selector: selector.to_owned(),
                estimated_bytes: estimate,
                expected_container: container.map(str::to_owned),
                audio_only,
            },
        )
    })
    .collect()
}

fn estimate_from_formats(formats: Option<&Value>) -> Option<u64> {
    formats
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|format| {
            format
                .get("filesize")
                .or_else(|| format.get("filesize_approx"))
                .and_then(Value::as_u64)
        })
        .max()
}

fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn classify_probe_failure(auth: &AuthRequest, diagnostic: &str) -> HostError {
    let diagnostic = redact_auth_diagnostic(auth, diagnostic);
    let lower = diagnostic.to_ascii_lowercase();
    let auth_failure = ["sign in", "login", "authentication", "cookies"]
        .iter()
        .any(|needle| lower.contains(needle));
    match (auth, auth_failure) {
        (AuthRequest::Anonymous, true) => HostError::new(
            ErrorCode::AuthRequired,
            "This page requires an authenticated browser session",
        ),
        (AuthRequest::CurrentTab { .. }, true) => HostError::new(
            ErrorCode::AuthScopeInsufficient,
            "The scoped current-tab session was insufficient; advanced Brave profile access may be required",
        ),
        _ => HostError::new(
                ErrorCode::UrlUnsupported,
                if diagnostic.is_empty() {
                    "yt-dlp could not analyze this page"
                } else {
                    &diagnostic
                },
            ),
    }
}

pub fn validate_auth_page(
    auth: &AuthRequest,
    expected_page: &str,
    developer_mode: bool,
) -> Result<(), HostError> {
    if let AuthRequest::CurrentTab { page_url, .. } = auth {
        let auth_page = validate_public_page_url(page_url, developer_mode)?;
        let expected = validate_public_page_url(expected_page, developer_mode)?;
        if canonical_page_identity(&auth_page) != canonical_page_identity(&expected) {
            return Err(HostError::new(
                ErrorCode::InvalidRequest,
                "Current-tab authentication did not match the analyzed page",
            ));
        }
    }
    Ok(())
}

fn canonical_page_identity(url: &url::Url) -> String {
    let mut url = url.clone();
    url.set_fragment(None);
    url.to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

struct ProbeTemp {
    path: PathBuf,
}

impl ProbeTemp {
    fn create(root: &Path) -> Result<Self, HostError> {
        fs::create_dir_all(root)?;
        let path = root.join(opaque_token("probe-job")?);
        create_private_dir(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ProbeTemp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalized_summary_excludes_raw_urls_and_headers() {
        let raw = json!({
            "extractor_key": "Generic",
            "id": "fixture-1",
            "title": "Fixture",
            "webpage_url": "https://example.com/watch/1",
            "duration": 10.25,
            "thumbnail": "https://images.example.com/1.jpg?secret=yes",
            "http_headers": {"Authorization": "secret"},
            "formats": [{"format_id": "bad --exec", "url": "https://signed.test/v?token=secret", "filesize": 1000}]
        });
        let (summary, record) =
            normalize_probe(raw, "https://example.com/watch/1".into(), false).unwrap();
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(!serialized.contains("Authorization"));
        assert!(!serialized.contains("signed.test"));
        assert!(!serialized.contains("secret=yes"));
        assert!(!record
            .selections
            .values()
            .any(|selection| selection.selector.contains("exec")));
    }

    #[test]
    fn selection_is_resolved_only_from_cache() {
        let (_, record) = normalize_probe(
            json!({"id":"x","title":"x"}),
            "https://example.com/x".into(),
            false,
        )
        .unwrap();
        assert!(record.selection("best").is_ok());
        assert!(record.selection("best --exec touch /tmp/bad").is_err());
    }

    #[test]
    fn auth_page_must_match_probe_page() {
        let auth = AuthRequest::CurrentTab {
            page_url: "https://evil.example/watch".into(),
            referer: "https://evil.example/watch".into(),
            user_agent: "test".into(),
            cookie_store_id: "0".into(),
            incognito: false,
            cookies: vec![],
        };
        assert!(validate_auth_page(&auth, "https://good.example/watch", false).is_err());
    }

    #[test]
    fn extractor_canonical_url_cannot_pivot_to_private_network() {
        let (summary, record) = normalize_probe(
            json!({
                "id":"x", "title":"x",
                "webpage_url":"http://127.0.0.1/private",
                "thumbnail":"http://192.168.1.1/private.jpg"
            }),
            "https://example.com/public".into(),
            false,
        )
        .unwrap();
        assert_eq!(summary.webpage_url, "https://example.com/public");
        assert_eq!(record.page_url, "https://example.com/public");
        assert!(summary.thumbnail_url.is_none());
    }

    #[test]
    fn authentication_failures_have_mode_specific_recovery() {
        let diagnostic = "ERROR: Sign in or provide cookies";
        assert_eq!(
            classify_probe_failure(&AuthRequest::Anonymous, diagnostic).code,
            ErrorCode::AuthRequired
        );
        let current_tab = AuthRequest::CurrentTab {
            page_url: "https://example.com/watch".into(),
            referer: "https://example.com/watch".into(),
            user_agent: "Brave".into(),
            cookie_store_id: "0".into(),
            incognito: false,
            cookies: vec![],
        };
        assert_eq!(
            classify_probe_failure(&current_tab, diagnostic).code,
            ErrorCode::AuthScopeInsufficient
        );
        assert_eq!(
            classify_probe_failure(
                &AuthRequest::BraveProfile {
                    profile_id: "Default".into()
                },
                diagnostic
            )
            .code,
            ErrorCode::UrlUnsupported
        );
    }
}
