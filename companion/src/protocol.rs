use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: Value,
}

impl Envelope {
    pub fn response<T: Serialize>(
        request_id: impl Into<String>,
        message_type: impl Into<String>,
        payload: T,
    ) -> Result<Self, HostError> {
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            message_type: message_type.into(),
            payload: serde_json::to_value(payload).map_err(HostError::from)?,
        })
    }

    pub fn parse_payload<T: for<'de> Deserialize<'de>>(&self) -> Result<T, HostError> {
        serde_json::from_value(self.payload.clone())
            .map_err(|_| HostError::new(ErrorCode::InvalidRequest, "Invalid message payload"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    ProtocolMismatch,
    UrlUnsupported,
    PlaylistUnsupported,
    LiveUnsupported,
    DrmUnsupported,
    AuthRequired,
    AuthScopeInsufficient,
    FormatUnavailable,
    ProbeExpired,
    ToolsMissing,
    ToolsIncompatible,
    /// Internal distinction used for recovery routing; serialized as the
    /// stable public TOOLS_INCOMPATIBLE code.
    #[serde(rename = "TOOLS_INCOMPATIBLE")]
    ToolsOutdated,
    ToolsInstallUnavailable,
    SectionUnsupported,
    ExactClipUnsupported,
    DiskFull,
    JobInterrupted,
    Cancelled,
    OutputUnavailable,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::ProtocolMismatch => "PROTOCOL_MISMATCH",
            Self::UrlUnsupported => "URL_UNSUPPORTED",
            Self::PlaylistUnsupported => "PLAYLIST_UNSUPPORTED",
            Self::LiveUnsupported => "LIVE_UNSUPPORTED",
            Self::DrmUnsupported => "DRM_UNSUPPORTED",
            Self::AuthRequired => "AUTH_REQUIRED",
            Self::AuthScopeInsufficient => "AUTH_SCOPE_INSUFFICIENT",
            Self::FormatUnavailable => "FORMAT_UNAVAILABLE",
            Self::ProbeExpired => "FORMAT_UNAVAILABLE",
            Self::ToolsMissing => "TOOLS_MISSING",
            Self::ToolsIncompatible => "TOOLS_INCOMPATIBLE",
            Self::ToolsOutdated => "TOOLS_INCOMPATIBLE",
            Self::ToolsInstallUnavailable => "TOOLS_MISSING",
            Self::SectionUnsupported => "SECTION_UNSUPPORTED",
            Self::ExactClipUnsupported => "EXACT_CLIP_UNSUPPORTED",
            Self::DiskFull => "DISK_FULL",
            Self::JobInterrupted => "JOB_INTERRUPTED",
            Self::Cancelled => "CANCELLED",
            Self::OutputUnavailable => "INTERNAL_ERROR",
            Self::Internal => "INTERNAL_ERROR",
        }
    }
}

#[derive(Debug)]
pub struct HostError {
    pub code: ErrorCode,
    detail: String,
}

impl HostError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn safe_message(&self) -> String {
        crate::security::redact_diagnostic(&self.detail)
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.safe_message())
    }
}

impl std::error::Error for HostError {}

impl From<std::io::Error> for HostError {
    fn from(error: std::io::Error) -> Self {
        let code = if error.raw_os_error() == Some(28) {
            ErrorCode::DiskFull
        } else {
            ErrorCode::Internal
        };
        Self::new(code, error.to_string())
    }
}

impl From<serde_json::Error> for HostError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(ErrorCode::InvalidRequest, error.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

impl From<&HostError> for ErrorPayload {
    fn from(error: &HostError) -> Self {
        Self {
            code: error.code.as_str().to_owned(),
            message: error.safe_message(),
            recoverable: !matches!(error.code, ErrorCode::InvalidRequest),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserTarget {
    Brave,
    Chrome,
    Chromium,
    #[default]
    Unknown,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct HelloRequest {
    #[serde(default)]
    pub browser_target: BrowserTarget,
    pub extension_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet {
    pub probe: bool,
    pub download: bool,
    pub section_download: bool,
    pub exact_clip: bool,
    pub current_tab_cookies: bool,
    pub brave_profile_cookies: bool,
    pub reveal_output: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsRuntime {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BraveProfile {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct InstalledReleaseInfo {
    pub release_version: String,
    pub extension_version: String,
    pub companion_version: String,
    pub tool_release_id: String,
    pub installed_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol_version: u32,
    pub companion_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_release: Option<InstalledReleaseInfo>,
    pub browser_target: BrowserTarget,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yt_dlp_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffprobe_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub js_runtime: Option<JsRuntime>,
    pub healthy: bool,
    pub issues: Vec<HealthIssue>,
    pub capabilities: CapabilitySet,
    pub brave_profiles: Vec<BraveProfile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ProbeRequest {
    pub page_url: String,
    pub auth: AuthRequest,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
#[serde(rename_all_fields = "camelCase")]
pub enum AuthRequest {
    #[default]
    Anonymous,
    CurrentTab {
        page_url: String,
        referer: String,
        user_agent: String,
        cookie_store_id: String,
        incognito: bool,
        cookies: Vec<CookieRecord>,
    },
    BraveProfile {
        profile_id: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CookieRecord {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default = "default_cookie_path")]
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    pub same_site: CookieSameSite,
    #[serde(default)]
    pub host_only: bool,
    pub expiration_date: Option<f64>,
    pub session: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CookieSameSite {
    NoRestriction,
    Lax,
    Strict,
    Unspecified,
}

fn default_cookie_path() -> String {
    "/".to_owned()
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SelectionOption {
    #[serde(rename_all = "camelCase")]
    Preset {
        key: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        estimated_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_container: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummary {
    pub extractor_key: String,
    pub media_id: String,
    pub webpage_url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader: Option<String>,
    pub is_live: bool,
    pub is_drm: bool,
    pub selections: Vec<SelectionOption>,
    pub probe_token: String,
    pub probed_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StartDownloadRequest {
    pub job_id: String,
    pub probe_token: String,
    pub selection_key: String,
    pub auth: AuthRequest,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClipMode {
    Fast,
    Exact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ClipSpec {
    pub start_ms: u64,
    pub end_ms: u64,
    pub mode: ClipMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct StartClipRequest {
    pub job_id: String,
    pub probe_token: String,
    pub selection_key: String,
    pub clip: ClipSpec,
    pub auth: AuthRequest,
    pub allow_full_download_fallback: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CancelJobRequest {
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct OutputActionRequest {
    pub output_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobQueued {
    pub job_id: String,
    pub position: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackRequired {
    pub job_id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCompleted {
    pub job_id: String,
    pub output_token: String,
    pub final_path: String,
    pub filename: String,
    pub byte_size: u64,
    pub container: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<String>,
    pub extractor_key: String,
    pub media_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobState {
    pub job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailed {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

impl JobFailed {
    pub fn from_error(job_id: Option<String>, error: &HostError) -> Self {
        let payload = ErrorPayload::from(error);
        Self {
            job_id,
            code: payload.code,
            message: payload.message,
            recoverable: payload.recoverable,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputActionResult {
    pub output_token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_golden_envelopes_deserialize() {
        for fixture in [
            include_str!("../../protocol/fixtures/hello.json"),
            include_str!("../../protocol/fixtures/job-progress.json"),
            include_str!("../../protocol/fixtures/probe-result.json"),
        ] {
            let envelope: Envelope = serde_json::from_str(fixture).unwrap();
            assert_eq!(envelope.protocol_version, PROTOCOL_VERSION);
            assert!(!envelope.request_id.is_empty());
        }
        let hello: Envelope =
            serde_json::from_str(include_str!("../../protocol/fixtures/hello.json")).unwrap();
        let hello: HelloRequest = hello.parse_payload().unwrap();
        assert!(matches!(hello.browser_target, BrowserTarget::Brave));
        assert_eq!(hello.extension_version, "1.12.0");
    }

    #[test]
    fn auth_field_names_match_canonical_camel_case_contract() {
        let current_tab: AuthRequest = serde_json::from_value(json!({
            "mode": "current-tab",
            "pageUrl": "https://example.com/watch",
            "referer": "https://example.com/watch",
            "userAgent": "Brave fixture",
            "cookieStoreId": "1",
            "incognito": false,
            "cookies": [{
                "name": "session", "value": "secret", "domain": ".example.com",
                "path": "/", "secure": true, "httpOnly": true, "sameSite": "lax",
                "hostOnly": false, "session": true
            }]
        }))
        .unwrap();
        assert!(matches!(current_tab, AuthRequest::CurrentTab { .. }));

        let profile: AuthRequest = serde_json::from_value(json!({
            "mode": "brave-profile",
            "profileId": "Profile 2"
        }))
        .unwrap();
        assert!(
            matches!(profile, AuthRequest::BraveProfile { profile_id } if profile_id == "Profile 2")
        );
    }

    #[test]
    fn optional_response_fields_are_omitted_not_serialized_as_null() {
        let progress = JobProgress {
            job_id: "job".into(),
            stage: "planning".into(),
            detail: None,
            downloaded_bytes: None,
            total_bytes: None,
            percentage: None,
            speed_bytes_per_second: None,
            eta_seconds: None,
        };
        let value = serde_json::to_value(progress).unwrap();
        assert_eq!(value, json!({"jobId":"job","stage":"planning"}));
    }
}
