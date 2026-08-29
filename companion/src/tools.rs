use crate::protocol::{BraveProfile, ErrorCode, HealthIssue, HostError, JsRuntime};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const RELEASE_PUBLIC_KEY_B64: &str = "QPWXTEbqWGBY7xqwO+TVA1809E28kK0HcDf0QpuWQtM=";

#[derive(Debug, Clone)]
pub struct ToolPaths {
    pub yt_dlp: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub js_runtime: Option<PathBuf>,
    pub bin_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ToolManager {
    root: PathBuf,
    developer_tool_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub struct ToolHealth {
    pub paths: Option<ToolPaths>,
    pub yt_dlp_version: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_version: Option<String>,
    pub js_runtime: Option<JsRuntime>,
    pub issues: Vec<HealthIssue>,
}

impl ToolHealth {
    pub fn healthy(&self) -> bool {
        self.paths.is_some() && self.issues.is_empty()
    }
}

impl ToolManager {
    pub fn new(root: PathBuf, developer_tool_dir: Option<PathBuf>) -> Self {
        Self {
            root,
            developer_tool_dir,
        }
    }

    pub fn health(&self) -> ToolHealth {
        let paths = match self.resolve_active_paths() {
            Ok(paths) => paths,
            Err(error) => {
                return ToolHealth {
                    paths: None,
                    yt_dlp_version: None,
                    ffmpeg_version: None,
                    ffprobe_version: None,
                    js_runtime: None,
                    issues: vec![HealthIssue {
                        code: error.code.as_str().to_owned(),
                        message: error.safe_message(),
                        recoverable: true,
                    }],
                }
            }
        };

        let yt_dlp_version = tool_version(&paths.yt_dlp, &["--version"]);
        let ffmpeg_version = tool_version(&paths.ffmpeg, &["-version"]);
        let ffprobe_version = tool_version(&paths.ffprobe, &["-version"]);
        let js_runtime = paths.js_runtime.as_ref().and_then(|path| {
            tool_version(path, &["--version"]).map(|version| JsRuntime {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                version,
            })
        });
        let mut issues = Vec::new();
        if yt_dlp_version
            .as_deref()
            .is_some_and(yt_dlp_version_is_stale)
        {
            issues.push(HealthIssue {
                code: ErrorCode::ToolsOutdated.as_str().to_owned(),
                message:
                    "Media Sniper's media tools need an update to keep up with supported sites"
                        .to_owned(),
                recoverable: true,
            });
        }
        if yt_dlp_version.is_none()
            || ffmpeg_version.is_none()
            || ffprobe_version.is_none()
            || js_runtime
                .as_ref()
                .is_none_or(|runtime| !js_runtime_supported(&runtime.name, &runtime.version))
        {
            issues.push(HealthIssue {
                code: ErrorCode::ToolsIncompatible.as_str().to_owned(),
                message: "One or more managed tools or the pinned JavaScript runtime failed their health check".to_owned(),
                recoverable: true,
            });
        }
        ToolHealth {
            paths: Some(paths),
            yt_dlp_version,
            ffmpeg_version,
            ffprobe_version,
            js_runtime,
            issues,
        }
    }

    pub fn resolve_active_paths(&self) -> Result<ToolPaths, HostError> {
        let bin_dir = if let Some(developer) = &self.developer_tool_dir {
            developer.clone()
        } else {
            let version = fs::read_to_string(self.root.join("active-version")).map_err(|_| {
                HostError::new(
                    ErrorCode::ToolsMissing,
                    "The managed yt-dlp and FFmpeg tools are not installed",
                )
            })?;
            let version = version.trim();
            validate_version(version)?;
            self.root.join("versions").join(version).join("bin")
        };
        let canonical_root = fs::canonicalize(&bin_dir).map_err(|_| {
            HostError::new(
                ErrorCode::ToolsMissing,
                "The active managed-tool directory is missing",
            )
        })?;
        if self.developer_tool_dir.is_none() {
            let canonical_versions =
                fs::canonicalize(self.root.join("versions")).map_err(|_| {
                    HostError::new(ErrorCode::ToolsMissing, "The managed-tool store is missing")
                })?;
            if !canonical_root.starts_with(canonical_versions) {
                return Err(HostError::new(
                    ErrorCode::ToolsIncompatible,
                    "The active managed-tool directory escaped its trusted root",
                ));
            }
        }

        let executable = |name: &str| -> Result<PathBuf, HostError> {
            let path = canonical_root.join(platform_executable(name));
            let canonical = fs::canonicalize(&path).map_err(|_| {
                HostError::new(
                    ErrorCode::ToolsMissing,
                    format!("The managed {name} executable is missing"),
                )
            })?;
            if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
                return Err(HostError::new(
                    ErrorCode::ToolsIncompatible,
                    format!("The managed {name} executable is invalid"),
                ));
            }
            Ok(canonical)
        };
        let js_runtime = ["deno", "node"]
            .iter()
            .find_map(|name| executable(name).ok());
        Ok(ToolPaths {
            yt_dlp: executable("yt-dlp")?,
            ffmpeg: executable("ffmpeg")?,
            ffprobe: executable("ffprobe")?,
            js_runtime,
            bin_dir: canonical_root,
        })
    }

    /// Verifies a release-produced bundle before atomically selecting it. Network download and
    /// graphical consent are installer responsibilities; protocol callers cannot provide paths.
    pub fn activate_verified_bundle(
        &self,
        staged_bundle: &Path,
        manifest_bytes: &[u8],
        signature_b64: &str,
    ) -> Result<String, HostError> {
        let release_key = BASE64.decode(RELEASE_PUBLIC_KEY_B64).map_err(|_| {
            HostError::new(ErrorCode::Internal, "Invalid embedded release key encoding")
        })?;
        let release_key: [u8; 32] = release_key.try_into().map_err(|_| {
            HostError::new(ErrorCode::Internal, "Invalid embedded release key length")
        })?;
        let key = VerifyingKey::from_bytes(&release_key).map_err(|_| {
            HostError::new(ErrorCode::ToolsIncompatible, "Invalid embedded release key")
        })?;
        let signature_bytes = BASE64.decode(signature_b64).map_err(|_| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "Invalid tool-manifest signature",
            )
        })?;
        let signature = Signature::from_slice(&signature_bytes).map_err(|_| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "Invalid tool-manifest signature",
            )
        })?;
        key.verify(manifest_bytes, &signature).map_err(|_| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "The managed-tool manifest signature did not verify",
            )
        })?;
        let manifest: ToolManifest = serde_json::from_slice(manifest_bytes).map_err(|_| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "Invalid managed-tool manifest",
            )
        })?;
        validate_version(&manifest.version)?;
        if manifest.files.is_empty() || manifest.files.len() > 64 {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "Managed-tool manifest contained an invalid file list",
            ));
        }
        let mut seen = HashSet::new();
        for file in &manifest.files {
            validate_bundle_path(&file.path)?;
            if !seen.insert(file.path.clone()) {
                return Err(HostError::new(
                    ErrorCode::ToolsIncompatible,
                    "Managed-tool manifest contained a duplicate file",
                ));
            }
            let bytes = fs::read(staged_bundle.join(&file.path))?;
            let actual = hex::encode(Sha256::digest(bytes));
            if !actual.eq_ignore_ascii_case(&file.sha256) {
                return Err(HostError::new(
                    ErrorCode::ToolsIncompatible,
                    "A managed-tool payload failed its cryptographic hash check",
                ));
            }
        }
        let actual_files = collect_bundle_files(staged_bundle)?;
        if actual_files != seen {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "The managed-tool bundle did not exactly match its signed file list",
            ));
        }
        let required = [
            format!("bin/{}", platform_executable("yt-dlp")),
            format!("bin/{}", platform_executable("ffmpeg")),
            format!("bin/{}", platform_executable("ffprobe")),
            format!("bin/{}", platform_executable("deno")),
        ];
        if required.iter().any(|path| !seen.contains(path)) {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "The signed bundle omitted a required managed tool",
            ));
        }
        let staged_bin = staged_bundle.join("bin");
        if required.iter().any(|relative| {
            let metadata = fs::symlink_metadata(staged_bundle.join(relative));
            !matches!(metadata, Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink())
        }) {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "A required managed tool was not a regular signed file",
            ));
        }
        let staged_paths = ToolPaths {
            yt_dlp: staged_bundle.join(&required[0]),
            ffmpeg: staged_bundle.join(&required[1]),
            ffprobe: staged_bundle.join(&required[2]),
            js_runtime: Some(staged_bundle.join(&required[3])),
            bin_dir: staged_bin,
        };
        if tool_version(&staged_paths.yt_dlp, &["--version"]).is_none()
            || tool_version(&staged_paths.ffmpeg, &["-version"]).is_none()
            || tool_version(&staged_paths.ffprobe, &["-version"]).is_none()
            || staged_paths
                .js_runtime
                .as_ref()
                .and_then(|path| tool_version(path, &["--version"]))
                .is_none_or(|version| !js_runtime_supported("deno", &version))
        {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "The signed managed tools failed their pre-activation health check",
            ));
        }
        let destination = self.root.join("versions").join(&manifest.version);
        if destination.exists() {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "The managed-tool version is already installed",
            ));
        }
        fs::create_dir_all(destination.parent().unwrap())?;
        fs::rename(staged_bundle, &destination)?;
        if let Ok(active) = fs::read_to_string(self.root.join("active-version")) {
            let active = active.trim();
            if validate_version(active).is_ok() && active != manifest.version {
                let previous_temp = self.root.join("previous-version.next");
                fs::write(&previous_temp, format!("{active}\n"))?;
                fs::rename(previous_temp, self.root.join("previous-version"))?;
            }
        }
        let marker_temp = self.root.join("active-version.next");
        fs::write(&marker_temp, format!("{}\n", manifest.version))?;
        fs::rename(marker_temp, self.root.join("active-version"))?;
        Ok(manifest.version)
    }

    pub fn rollback(&self) -> Result<String, HostError> {
        let previous = fs::read_to_string(self.root.join("previous-version")).map_err(|_| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "No known-good managed-tool version is available for rollback",
            )
        })?;
        let previous = previous.trim();
        validate_version(previous)?;
        let previous_bin = self.root.join("versions").join(previous).join("bin");
        if !previous_bin.is_dir() {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "The previous managed-tool version is missing",
            ));
        }
        let active = fs::read_to_string(self.root.join("active-version"))
            .unwrap_or_default()
            .trim()
            .to_owned();
        let active_temp = self.root.join("active-version.next");
        fs::write(&active_temp, format!("{previous}\n"))?;
        fs::rename(active_temp, self.root.join("active-version"))?;
        if validate_version(&active).is_ok() {
            let previous_temp = self.root.join("previous-version.next");
            fs::write(&previous_temp, format!("{active}\n"))?;
            fs::rename(previous_temp, self.root.join("previous-version"))?;
        }
        Ok(previous.to_owned())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolManifest {
    version: String,
    files: Vec<ToolManifestFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolManifestFile {
    path: String,
    sha256: String,
}

fn validate_version(version: &str) -> Result<(), HostError> {
    if version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(HostError::new(
            ErrorCode::ToolsIncompatible,
            "The managed-tool version identifier is invalid",
        ));
    }
    Ok(())
}

fn validate_bundle_path(path: &str) -> Result<(), HostError> {
    let candidate = Path::new(path);
    if path.is_empty()
        || path.len() > 256
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(HostError::new(
            ErrorCode::ToolsIncompatible,
            "The managed-tool manifest contained an unsafe path",
        ));
    }
    Ok(())
}

fn collect_bundle_files(root: &Path) -> Result<HashSet<String>, HostError> {
    fn visit(root: &Path, current: &Path, output: &mut HashSet<String>) -> Result<(), HostError> {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                return Err(HostError::new(
                    ErrorCode::ToolsIncompatible,
                    "Managed-tool bundles cannot contain symbolic links",
                ));
            }
            if metadata.is_dir() {
                visit(root, &entry.path(), output)?;
            } else if metadata.is_file() {
                let entry_path = entry.path();
                let relative = entry_path.strip_prefix(root).map_err(|_| {
                    HostError::new(
                        ErrorCode::ToolsIncompatible,
                        "A managed-tool file escaped its staging root",
                    )
                })?;
                output.insert(relative.to_string_lossy().replace('\\', "/"));
            } else {
                return Err(HostError::new(
                    ErrorCode::ToolsIncompatible,
                    "Managed-tool bundles can contain only regular files",
                ));
            }
        }
        Ok(())
    }

    let mut files = HashSet::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn platform_executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn tool_version(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(128)
        .collect::<String>();
    (!line.is_empty()).then_some(line)
}

fn js_runtime_supported(name: &str, version: &str) -> bool {
    let numbers = version
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .find(|part| part.contains('.') && part.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or_default()
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();
    let major = numbers.first().copied().unwrap_or(0);
    let minor = numbers.get(1).copied().unwrap_or(0);
    match name.trim_end_matches(".exe") {
        "deno" => (major, minor) >= (2, 3),
        "node" => major >= 22,
        _ => false,
    }
}

fn yt_dlp_version_is_stale(version: &str) -> bool {
    let today = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| (duration.as_secs() / 86_400) as i64);
    today.is_some_and(|today| yt_dlp_version_is_stale_on(version, today))
}

fn yt_dlp_version_is_stale_on(version: &str, today: i64) -> bool {
    yt_dlp_release_day(version).is_some_and(|released| today.saturating_sub(released) > 90)
}

fn yt_dlp_release_day(version: &str) -> Option<i64> {
    let version = version.split_whitespace().next()?;
    let mut parts = version.split('.');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > month_days[(month - 1) as usize] {
        return None;
    }

    // Howard Hinnant's civil-date conversion, yielding Unix epoch days.
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

pub fn discover_brave_profiles(user_home: &Path) -> Vec<BraveProfile> {
    let root = if cfg!(target_os = "macos") {
        user_home.join("Library/Application Support/BraveSoftware/Brave-Browser")
    } else if cfg!(windows) {
        user_home.join("AppData/Local/BraveSoftware/Brave-Browser/User Data")
    } else {
        user_home.join(".config/BraveSoftware/Brave-Browser")
    };
    let names = fs::read(root.join("Local State"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|json| json.pointer("/profile/info_cache").cloned())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut profiles = Vec::new();
    for id in names.keys() {
        if validate_profile_id(id) && root.join(id).is_dir() {
            let name = names[id]
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(id);
            profiles.push(BraveProfile {
                id: id.clone(),
                name: crate::security::bounded_text(Some(name), id, 128),
            });
        }
    }
    if profiles.is_empty() && root.join("Default").is_dir() {
        profiles.push(BraveProfile {
            id: "Default".to_owned(),
            name: "Default".to_owned(),
        });
    }
    profiles.sort_by(|left, right| left.id.cmp(&right.id));
    profiles
}

fn validate_profile_id(id: &str) -> bool {
    id == "Default"
        || id.strip_prefix("Profile ").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn active_version_cannot_traverse_tool_store() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("active-version"), "../../escape").unwrap();
        let error = ToolManager::new(root.path().into(), None)
            .resolve_active_paths()
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ToolsIncompatible);
    }

    #[test]
    fn manifest_paths_are_relative_and_normalized() {
        for path in ["/bin/yt-dlp", "../bin/yt-dlp", "bin/../yt-dlp", ""] {
            assert!(validate_bundle_path(path).is_err(), "{path}");
        }
        assert!(validate_bundle_path("bin/yt-dlp").is_ok());
    }

    #[test]
    fn profile_ids_are_not_paths() {
        assert!(validate_profile_id("Default"));
        assert!(validate_profile_id("Profile 12"));
        assert!(!validate_profile_id("../../Default"));
        assert!(!validate_profile_id("System Profile"));
    }

    #[test]
    fn javascript_runtime_minimums_are_explicit() {
        assert!(js_runtime_supported("deno", "deno 2.6.1"));
        assert!(!js_runtime_supported("deno", "deno 2.2.9"));
        assert!(js_runtime_supported("node", "v22.4.0"));
        assert!(!js_runtime_supported("node", "v20.9.0"));
    }

    #[test]
    fn yt_dlp_versions_older_than_ninety_days_require_an_update() {
        let today = yt_dlp_release_day("2026.08.29").unwrap();
        assert!(yt_dlp_version_is_stale_on("2026.02.04", today));
        assert!(!yt_dlp_version_is_stale_on("2026.08.19", today));
        assert!(!yt_dlp_version_is_stale_on("unknown", today));
    }
}
