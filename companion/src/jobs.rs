use crate::auth::{redact_auth_diagnostic, PreparedAuth};
use crate::probe::{validate_auth_page, CachedSelection, ProbeRecord};
use crate::protocol::{
    AuthRequest, ClipMode, ClipSpec, Envelope, ErrorCode, FallbackRequired, HostError,
    JobCompleted, JobProgress, StartClipRequest, StartDownloadRequest,
};
use crate::runner::{ManagedTool, ProcessOutput, ProcessRunner, RunPolicy};
use crate::security::{
    create_private_dir, diagnostic_requests_tool_update, opaque_token, redact_diagnostic,
    safe_filename_component, validate_public_page_url, validate_resolved_public_page_url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

const YTDLP_FILE_MARKER: &str = "MEDIA_SNIPER_FILE:";
const YTDLP_PROGRESS_MARKER: &str = "MEDIA_SNIPER_PROGRESS:";

pub type EventSink = Arc<dyn Fn(Envelope) + Send + Sync>;

#[derive(Clone)]
pub enum JobSpec {
    Download {
        request: StartDownloadRequest,
        probe: ProbeRecord,
    },
    Clip {
        request: StartClipRequest,
        probe: ProbeRecord,
    },
}

impl JobSpec {
    pub fn job_id(&self) -> &str {
        match self {
            Self::Download { request, .. } => &request.job_id,
            Self::Clip { request, .. } => &request.job_id,
        }
    }
}

#[derive(Clone)]
pub struct OutputRegistry {
    paths: Arc<Mutex<HashMap<String, PathBuf>>>,
    receipt_root: PathBuf,
    output_root: PathBuf,
}

#[derive(Clone, Default)]
pub struct FallbackRegistry {
    pending: Arc<Mutex<HashMap<String, FallbackFingerprint>>>,
}

#[derive(Clone, PartialEq, Eq)]
struct FallbackFingerprint {
    probe_token: String,
    selection_key: String,
    start_ms: u64,
    end_ms: u64,
    mode: ClipMode,
}

impl FallbackRegistry {
    fn authorize(&self, request: &StartClipRequest) {
        self.pending
            .lock()
            .unwrap()
            .insert(request.job_id.clone(), FallbackFingerprint::from(request));
    }

    fn consume(&self, request: &StartClipRequest) -> Result<(), HostError> {
        let expected = FallbackFingerprint::from(request);
        let actual = self.pending.lock().unwrap().remove(&request.job_id);
        if actual.as_ref() != Some(&expected) {
            return Err(HostError::new(
                ErrorCode::InvalidRequest,
                "Full-download fallback was not authorized by a matching prior clip attempt",
            ));
        }
        Ok(())
    }

    pub fn validate_resume(&self, request: &StartClipRequest) -> Result<(), HostError> {
        let expected = FallbackFingerprint::from(request);
        if self.pending.lock().unwrap().get(&request.job_id) != Some(&expected) {
            return Err(HostError::new(
                ErrorCode::InvalidRequest,
                "Full-download fallback was not authorized by a matching prior clip attempt",
            ));
        }
        Ok(())
    }

    pub fn cancel_pending(&self, job_id: &str) -> bool {
        self.pending.lock().unwrap().remove(job_id).is_some()
    }
}

impl From<&StartClipRequest> for FallbackFingerprint {
    fn from(request: &StartClipRequest) -> Self {
        Self {
            probe_token: request.probe_token.clone(),
            selection_key: request.selection_key.clone(),
            start_ms: request.clip.start_ms,
            end_ms: request.clip.end_ms,
            mode: request.clip.mode,
        }
    }
}

impl OutputRegistry {
    pub fn new(receipt_root: PathBuf, output_root: PathBuf) -> Result<Self, HostError> {
        if !receipt_root.exists() {
            if let Some(parent) = receipt_root.parent() {
                fs::create_dir_all(parent)?;
            }
            create_private_dir(&receipt_root)?;
        }
        Ok(Self {
            paths: Arc::new(Mutex::new(HashMap::new())),
            receipt_root,
            output_root,
        })
    }

    pub fn register(&self, path: PathBuf) -> Result<String, HostError> {
        let path = self.validate_output_path(&path)?;
        let token = opaque_token("output")?;
        let bytes = serde_json::to_vec(&OutputReceipt {
            version: 1,
            path: path.to_string_lossy().into_owned(),
        })?;
        let temporary = self.receipt_root.join(format!(".{token}.next"));
        write_private(&temporary, &bytes)?;
        fs::rename(&temporary, self.receipt_path(&token)?)?;
        self.paths.lock().unwrap().insert(token.clone(), path);
        Ok(token)
    }

    pub fn resolve(&self, token: &str) -> Result<PathBuf, HostError> {
        validate_output_token(token)?;
        if let Some(path) = self.paths.lock().unwrap().get(token).cloned() {
            return self.validate_output_path(&path);
        }
        let bytes = fs::read(self.receipt_path(token)?).map_err(|_| {
            HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output receipt is no longer available",
            )
        })?;
        if bytes.len() > 16 * 1024 {
            return Err(HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output receipt was invalid",
            ));
        }
        let receipt: OutputReceipt = serde_json::from_slice(&bytes).map_err(|_| {
            HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output receipt was invalid",
            )
        })?;
        if receipt.version != 1 {
            return Err(HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output receipt version is incompatible",
            ));
        }
        let path = self.validate_output_path(Path::new(&receipt.path))?;
        self.paths
            .lock()
            .unwrap()
            .insert(token.to_owned(), path.clone());
        Ok(path)
    }

    fn receipt_path(&self, token: &str) -> Result<PathBuf, HostError> {
        validate_output_token(token)?;
        Ok(self.receipt_root.join(format!("{token}.json")))
    }

    fn validate_output_path(&self, path: &Path) -> Result<PathBuf, HostError> {
        let root = fs::canonicalize(&self.output_root).map_err(|_| {
            HostError::new(
                ErrorCode::OutputUnavailable,
                "The Media Sniper output directory is unavailable",
            )
        })?;
        let metadata = fs::symlink_metadata(path).map_err(|_| {
            HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output is no longer available",
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output is not a regular Media Sniper file",
            ));
        }
        let path = fs::canonicalize(path)?;
        if path.parent() != Some(root.as_path()) {
            return Err(HostError::new(
                ErrorCode::OutputUnavailable,
                "The completed output receipt escaped the Media Sniper output directory",
            ));
        }
        Ok(path)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct OutputReceipt {
    version: u32,
    path: String,
}

fn validate_output_token(token: &str) -> Result<(), HostError> {
    let suffix = token.strip_prefix("output-").unwrap_or_default();
    if suffix.len() != 48 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "The companion output token is invalid",
        ));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), HostError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub struct JobExecutor {
    runner: ProcessRunner,
    temp_root: PathBuf,
    output_root: PathBuf,
    brave_profiles: Vec<String>,
    developer_mode: bool,
    outputs: OutputRegistry,
    fallbacks: FallbackRegistry,
    sink: EventSink,
}

impl JobExecutor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        runner: ProcessRunner,
        temp_root: PathBuf,
        output_root: PathBuf,
        brave_profiles: Vec<String>,
        developer_mode: bool,
        outputs: OutputRegistry,
        fallbacks: FallbackRegistry,
        sink: EventSink,
    ) -> Self {
        Self {
            runner,
            temp_root,
            output_root,
            brave_profiles,
            developer_mode,
            outputs,
            fallbacks,
            sink,
        }
    }

    pub fn execute(
        &self,
        request_id: &str,
        spec: JobSpec,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Option<JobCompleted>, HostError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(HostError::new(ErrorCode::Cancelled, "Operation cancelled"));
        }
        match spec {
            JobSpec::Download { request, probe } => self
                .download(request_id, &request, &probe, &cancelled)
                .map(Some),
            JobSpec::Clip { request, probe } => self.clip(request_id, &request, &probe, &cancelled),
        }
    }

    fn download(
        &self,
        request_id: &str,
        request: &StartDownloadRequest,
        probe: &ProbeRecord,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<JobCompleted, HostError> {
        reject_unsupported_probe(probe)?;
        validate_auth_page(
            &request.auth,
            &probe.requested_page_url,
            self.developer_mode,
        )?;
        let selection = probe.selection(&request.selection_key)?;
        let context = prepare_job_context_with_resolver(
            &request.auth,
            &probe.page_url,
            &self.temp_root,
            &self.brave_profiles,
            self.developer_mode,
            validate_resolved_public_page_url,
        )?;
        self.emit_progress(request_id, &request.job_id, "planning", None, None);
        let source = self.run_ytdlp(
            request_id,
            &request.job_id,
            probe,
            selection,
            &request.auth,
            &context.auth,
            context.path(),
            None,
            cancelled,
        )?;
        self.emit_progress(request_id, &request.job_id, "saving", None, None);
        let metrics = probe_media(&self.runner, &source, context.path(), cancelled).ok();
        let saved = save_output(
            &source,
            &self.output_root,
            &probe.title,
            &probe.media_id,
            None,
        )?;
        self.completed_receipt(request.job_id.clone(), probe, saved, metrics, None)
    }

    fn clip(
        &self,
        request_id: &str,
        request: &StartClipRequest,
        probe: &ProbeRecord,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<Option<JobCompleted>, HostError> {
        reject_unsupported_probe(probe)?;
        validate_clip(&request.clip, probe.duration_ms)?;
        validate_auth_page(
            &request.auth,
            &probe.requested_page_url,
            self.developer_mode,
        )?;
        let selection = probe.selection(&request.selection_key)?;
        if request.allow_full_download_fallback {
            self.fallbacks.consume(request)?;
        }
        let context = prepare_job_context_with_resolver(
            &request.auth,
            &probe.page_url,
            &self.temp_root,
            &self.brave_profiles,
            self.developer_mode,
            validate_resolved_public_page_url,
        )?;
        self.emit_progress(request_id, &request.job_id, "planning", None, None);
        if request.allow_full_download_fallback {
            return self
                .fallback_clip(request_id, request, probe, selection, &context, cancelled)
                .map(Some);
        }
        let direct = self.run_ytdlp(
            request_id,
            &request.job_id,
            probe,
            selection,
            &request.auth,
            &context.auth,
            context.path(),
            Some(&request.clip),
            cancelled,
        );
        match direct.and_then(|path| {
            let metrics = probe_media(&self.runner, &path, context.path(), cancelled)?;
            validate_clip_output(&metrics, &request.clip, selection.audio_only)?;
            Ok((path, metrics))
        }) {
            Ok((path, metrics)) => {
                self.emit_progress(request_id, &request.job_id, "saving", None, None);
                let saved = save_output(
                    &path,
                    &self.output_root,
                    &probe.title,
                    &probe.media_id,
                    Some(&request.clip),
                )?;
                let accuracy = match request.clip.mode {
                    ClipMode::Fast => "keyframe-aligned",
                    ClipMode::Exact => "exact",
                };
                self.completed_receipt(
                    request.job_id.clone(),
                    probe,
                    saved,
                    Some(metrics),
                    Some(accuracy.to_owned()),
                )
                .map(Some)
            }
            Err(error) if error.code == ErrorCode::Cancelled => Err(error),
            Err(error) if fallback_reason(&error).is_some() => {
                let reason = fallback_reason(&error).unwrap();
                self.fallbacks.authorize(request);
                self.emit(
                    request_id,
                    "fallback_required",
                    FallbackRequired {
                        job_id: request.job_id.clone(),
                        reason: reason.to_owned(),
                        estimated_bytes: selection.estimated_bytes,
                    },
                )?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn fallback_clip(
        &self,
        request_id: &str,
        request: &StartClipRequest,
        probe: &ProbeRecord,
        selection: &CachedSelection,
        context: &PreparedJobContext,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<JobCompleted, HostError> {
        self.emit_progress(
            request_id,
            &request.job_id,
            "downloading",
            Some("Downloading the complete source for the approved clip fallback"),
            None,
        );
        let source = self.run_ytdlp(
            request_id,
            &request.job_id,
            probe,
            selection,
            &request.auth,
            &context.auth,
            context.path(),
            None,
            cancelled,
        )?;
        self.emit_progress(
            request_id,
            &request.job_id,
            "processing",
            Some("Creating clip locally"),
            None,
        );
        let output = context.path().join(match request.clip.mode {
            ClipMode::Fast => "fallback-clip.mkv",
            ClipMode::Exact => "fallback-clip.mp4",
        });
        let args = ffmpeg_clip_args(&source, &output, &request.clip, selection.audio_only);
        let process = self.runner.run(
            ManagedTool::Ffmpeg,
            &args,
            context.path(),
            RunPolicy::standard(false),
            cancelled,
            |_| {},
        )?;
        if !process.status.success() {
            let diagnostic = if process.stderr.is_empty() {
                "FFmpeg could not create the approved fallback clip".to_owned()
            } else {
                redact_diagnostic(&process.stderr)
            };
            return Err(HostError::new(
                match request.clip.mode {
                    ClipMode::Fast => ErrorCode::SectionUnsupported,
                    ClipMode::Exact => ErrorCode::ExactClipUnsupported,
                },
                diagnostic,
            ));
        }
        let metrics = probe_media(&self.runner, &output, context.path(), cancelled)?;
        validate_clip_output(&metrics, &request.clip, selection.audio_only).map_err(|_| {
            HostError::new(
                if request.clip.mode == ClipMode::Exact {
                    ErrorCode::ExactClipUnsupported
                } else {
                    ErrorCode::SectionUnsupported
                },
                "The fallback clip did not pass media validation",
            )
        })?;
        self.emit_progress(request_id, &request.job_id, "saving", None, None);
        let saved = save_output(
            &output,
            &self.output_root,
            &probe.title,
            &probe.media_id,
            Some(&request.clip),
        )?;
        let accuracy = match request.clip.mode {
            ClipMode::Fast => "keyframe-aligned",
            ClipMode::Exact => "exact",
        };
        self.completed_receipt(
            request.job_id.clone(),
            probe,
            saved,
            Some(metrics),
            Some(accuracy.to_owned()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn run_ytdlp(
        &self,
        request_id: &str,
        job_id: &str,
        probe: &ProbeRecord,
        selection: &CachedSelection,
        auth: &AuthRequest,
        prepared_auth: &PreparedAuth,
        job_dir: &Path,
        clip: Option<&ClipSpec>,
        cancelled: &Arc<AtomicBool>,
    ) -> Result<PathBuf, HostError> {
        let mut args = yt_dlp_download_args(
            probe,
            selection,
            job_dir,
            &self.runner.paths().bin_dir,
            self.runner.paths().js_runtime.as_deref().ok_or_else(|| {
                HostError::new(
                    ErrorCode::ToolsIncompatible,
                    "The managed JavaScript runtime is missing",
                )
            })?,
            clip,
        );
        let url_index = args.len() - 1;
        args.splice(
            url_index - 1..url_index - 1,
            prepared_auth.args.iter().cloned(),
        );
        let mut file = None;
        let process = self.runner.run(
            ManagedTool::YtDlp,
            &args,
            job_dir,
            RunPolicy::standard(matches!(auth, AuthRequest::BraveProfile { .. })),
            cancelled,
            |line| {
                if let Some(path) = parse_file_marker(line) {
                    file = Some(path);
                } else if let Some(progress) = parse_progress_marker(job_id, line) {
                    let _ = self.emit(request_id, "job_progress", progress);
                }
            },
        )?;
        if !process.status.success() {
            let mut error = classify_download_failure(&process, auth);
            if clip.is_some() && error.code == ErrorCode::FormatUnavailable {
                error = HostError::new(
                    ErrorCode::SectionUnsupported,
                    "The source does not support direct section downloading",
                );
            }
            return Err(error);
        }
        let file = file.ok_or_else(|| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                "yt-dlp completed without a structured final-path marker",
            )
        })?;
        validate_job_output(job_dir, &file)
    }

    fn completed_receipt(
        &self,
        job_id: String,
        probe: &ProbeRecord,
        saved: SavedOutput,
        metrics: Option<MediaMetrics>,
        accuracy: Option<String>,
    ) -> Result<JobCompleted, HostError> {
        let output_token = self.outputs.register(saved.path.clone())?;
        Ok(JobCompleted {
            job_id,
            output_token,
            final_path: saved.path.to_string_lossy().into_owned(),
            filename: saved.filename,
            byte_size: saved.byte_size,
            container: saved.container,
            duration_ms: metrics.and_then(|metrics| metrics.duration_ms),
            accuracy,
            extractor_key: probe.extractor_key.clone(),
            media_id: probe.media_id.clone(),
        })
    }

    fn emit_progress(
        &self,
        request_id: &str,
        job_id: &str,
        stage: &str,
        detail: Option<&str>,
        percentage: Option<f64>,
    ) {
        let _ = self.emit(
            request_id,
            "job_progress",
            JobProgress {
                job_id: job_id.to_owned(),
                stage: stage.to_owned(),
                detail: detail.map(str::to_owned),
                downloaded_bytes: None,
                total_bytes: None,
                percentage,
                speed_bytes_per_second: None,
                eta_seconds: None,
            },
        );
    }

    fn emit<T: serde::Serialize>(
        &self,
        request_id: &str,
        message_type: &str,
        payload: T,
    ) -> Result<(), HostError> {
        (self.sink)(Envelope::response(request_id, message_type, payload)?);
        Ok(())
    }
}

fn prepare_job_context_with_resolver<F>(
    auth: &AuthRequest,
    page_url: &str,
    temp_root: &Path,
    brave_profiles: &[String],
    developer_mode: bool,
    resolve_page: F,
) -> Result<PreparedJobContext, HostError>
where
    F: FnOnce(&url::Url, bool) -> Result<(), HostError>,
{
    let execution_url = validate_public_page_url(page_url, developer_mode)?;
    // Resolve before either the job directory or current-tab authentication
    // can be materialized on disk.
    resolve_page(&execution_url, developer_mode)?;
    let temp = JobTemp::create(temp_root)?;
    let auth = PreparedAuth::prepare(auth, temp.path(), brave_profiles, developer_mode)?;
    Ok(PreparedJobContext { temp, auth })
}

fn fallback_reason(error: &HostError) -> Option<&'static str> {
    match error.code {
        ErrorCode::SectionUnsupported | ErrorCode::FormatUnavailable => Some("section-unsupported"),
        ErrorCode::ExactClipUnsupported => Some("exact-validation-failed"),
        ErrorCode::ToolsIncompatible => Some("section-invalid"),
        _ => None,
    }
}

fn reject_unsupported_probe(probe: &ProbeRecord) -> Result<(), HostError> {
    if probe.is_live {
        return Err(HostError::new(
            ErrorCode::LiveUnsupported,
            "Live companion downloads and clips are not supported in this version",
        ));
    }
    if probe.is_drm {
        return Err(HostError::new(
            ErrorCode::DrmUnsupported,
            "DRM-protected media cannot be processed by the companion",
        ));
    }
    Ok(())
}

fn validate_clip(clip: &ClipSpec, duration_ms: Option<u64>) -> Result<(), HostError> {
    if clip.end_ms <= clip.start_ms || clip.end_ms - clip.start_ms > 24 * 60 * 60 * 1000 {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "The clip boundaries were invalid",
        ));
    }
    if duration_ms.is_some_and(|duration| clip.end_ms > duration.saturating_add(100)) {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "The clip ends after the analyzed media",
        ));
    }
    Ok(())
}

pub fn yt_dlp_download_args(
    probe: &ProbeRecord,
    selection: &CachedSelection,
    job_dir: &Path,
    ffmpeg_dir: &Path,
    js_runtime: &Path,
    clip: Option<&ClipSpec>,
) -> Vec<String> {
    let js_name = js_runtime
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| matches!(*name, "deno" | "node"))
        .unwrap_or("deno");
    let mut args = vec![
        "--ignore-config".to_owned(),
        "--no-plugin-dirs".to_owned(),
        "--no-js-runtimes".to_owned(),
        "--js-runtimes".to_owned(),
        format!("{js_name}:{}", js_runtime.to_string_lossy()),
        "--no-remote-components".to_owned(),
        "--no-playlist".to_owned(),
        "--no-write-info-json".to_owned(),
        "--no-write-playlist-metafiles".to_owned(),
        "--no-write-thumbnail".to_owned(),
        "--no-keep-video".to_owned(),
        "--newline".to_owned(),
        "--progress".to_owned(),
        "--progress-template".to_owned(),
        format!("download:{YTDLP_PROGRESS_MARKER}%(progress)j"),
        "--print".to_owned(),
        format!("after_move:{YTDLP_FILE_MARKER}%(filepath)j"),
        "--cache-dir".to_owned(),
        job_dir.join("cache").to_string_lossy().into_owned(),
        "--paths".to_owned(),
        format!("home:{}", job_dir.to_string_lossy()),
        "--paths".to_owned(),
        format!("temp:{}", job_dir.to_string_lossy()),
        "--output".to_owned(),
        "%(title).180B [%(id).80B].%(ext)s".to_owned(),
        "--ffmpeg-location".to_owned(),
        ffmpeg_dir.to_string_lossy().into_owned(),
        "--format".to_owned(),
        selection.selector.clone(),
    ];
    if selection.audio_only {
        args.extend([
            "--extract-audio".to_owned(),
            "--audio-format".to_owned(),
            "best".to_owned(),
        ]);
    }
    if let Some(clip) = clip {
        args.extend([
            "--download-sections".to_owned(),
            format!(
                "*{}-{}",
                decimal_seconds(clip.start_ms),
                decimal_seconds(clip.end_ms)
            ),
        ]);
        if clip.mode == ClipMode::Exact {
            args.push("--force-keyframes-at-cuts".to_owned());
        }
    }
    args.push("--".to_owned());
    args.push(probe.page_url.clone());
    args
}

fn decimal_seconds(milliseconds: u64) -> String {
    format!("{}.{:03}", milliseconds / 1000, milliseconds % 1000)
}

pub fn ffmpeg_clip_args(
    input: &Path,
    output: &Path,
    clip: &ClipSpec,
    audio_only: bool,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_owned(),
        "-nostdin".to_owned(),
        "-y".to_owned(),
        "-ss".to_owned(),
        decimal_seconds(clip.start_ms),
        "-i".to_owned(),
        input.to_string_lossy().into_owned(),
        "-t".to_owned(),
        decimal_seconds(clip.end_ms - clip.start_ms),
    ];
    if audio_only {
        args.extend(["-map".to_owned(), "0:a:0".to_owned()]);
    } else {
        args.extend([
            "-map".to_owned(),
            "0:v:0".to_owned(),
            "-map".to_owned(),
            "0:a:0".to_owned(),
        ]);
    }
    match clip.mode {
        ClipMode::Fast => args.extend(["-c".to_owned(), "copy".to_owned()]),
        ClipMode::Exact if audio_only => {
            args.extend(["-c:a".to_owned(), "aac".to_owned()]);
        }
        ClipMode::Exact => args.extend([
            "-c:v".to_owned(),
            "libx264".to_owned(),
            "-c:a".to_owned(),
            "aac".to_owned(),
            "-movflags".to_owned(),
            "+faststart".to_owned(),
        ]),
    }
    args.push(output.to_string_lossy().into_owned());
    args
}

fn parse_file_marker(line: &str) -> Option<PathBuf> {
    let payload = line.strip_prefix(YTDLP_FILE_MARKER)?;
    serde_json::from_str::<String>(payload)
        .ok()
        .map(PathBuf::from)
}

fn parse_progress_marker(job_id: &str, line: &str) -> Option<JobProgress> {
    let payload = line.strip_prefix(YTDLP_PROGRESS_MARKER)?;
    let value: Value = serde_json::from_str(payload).ok()?;
    let downloaded = json_u64(&value, "downloaded_bytes");
    let total =
        json_u64(&value, "total_bytes").or_else(|| json_u64(&value, "total_bytes_estimate"));
    let percentage = match (downloaded, total) {
        (Some(downloaded), Some(total)) if total > 0 => {
            Some((downloaded as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };
    Some(JobProgress {
        job_id: job_id.to_owned(),
        stage: "downloading".to_owned(),
        detail: None,
        downloaded_bytes: downloaded,
        total_bytes: total,
        percentage,
        speed_bytes_per_second: value
            .get("speed")
            .and_then(Value::as_f64)
            .filter(|v| *v >= 0.0),
        eta_seconds: value
            .get("eta")
            .and_then(Value::as_f64)
            .filter(|v| *v >= 0.0),
    })
}

fn json_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value as u64)
        })
    })
}

fn classify_download_failure(output: &ProcessOutput, auth: &AuthRequest) -> HostError {
    classify_download_diagnostic(&output.stderr, auth)
}

fn classify_download_diagnostic(raw_diagnostic: &str, auth: &AuthRequest) -> HostError {
    let diagnostic = redact_auth_diagnostic(auth, raw_diagnostic);
    let lower = diagnostic.to_ascii_lowercase();
    if diagnostic_requests_tool_update(&diagnostic) {
        return HostError::new(
            ErrorCode::ToolsOutdated,
            "Media Sniper's media tools need an update to keep up with this site",
        );
    }
    let auth_failure = ["sign in", "login", "authentication", "cookies"]
        .iter()
        .any(|needle| lower.contains(needle));
    let code = if auth_failure {
        match auth {
            AuthRequest::Anonymous => ErrorCode::AuthRequired,
            AuthRequest::CurrentTab { .. } => ErrorCode::AuthScopeInsufficient,
            AuthRequest::BraveProfile { .. } => ErrorCode::FormatUnavailable,
        }
    } else if lower.contains("no space left") || lower.contains("disk full") {
        ErrorCode::DiskFull
    } else {
        ErrorCode::FormatUnavailable
    };
    let message = match code {
        ErrorCode::AuthRequired => "This media requires an authenticated browser session",
        ErrorCode::AuthScopeInsufficient => {
            "The scoped browser session was insufficient for this media"
        }
        ErrorCode::DiskFull => "There is not enough free space to save this media",
        _ => "The selected media format is no longer available; analyze the page again",
    };
    HostError::new(code, message)
}

fn validate_job_output(job_dir: &Path, path: &Path) -> Result<PathBuf, HostError> {
    let root = fs::canonicalize(job_dir)?;
    let path = fs::canonicalize(path).map_err(|_| {
        HostError::new(
            ErrorCode::ToolsIncompatible,
            "yt-dlp reported a final path that does not exist",
        )
    })?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(HostError::new(
            ErrorCode::ToolsIncompatible,
            "yt-dlp reported a final path outside its isolated job directory",
        ));
    }
    Ok(path)
}

#[derive(Debug)]
struct MediaMetrics {
    duration_ms: Option<u64>,
    video_start_ms: Option<i64>,
    audio_start_ms: Option<i64>,
    has_video: bool,
    has_audio: bool,
}

fn probe_media(
    runner: &ProcessRunner,
    path: &Path,
    job_dir: &Path,
    cancelled: &Arc<AtomicBool>,
) -> Result<MediaMetrics, HostError> {
    let args = vec![
        "-v".to_owned(),
        "error".to_owned(),
        "-show_entries".to_owned(),
        "format=duration:stream=codec_type,start_time".to_owned(),
        "-of".to_owned(),
        "json".to_owned(),
        path.to_string_lossy().into_owned(),
    ];
    let output = runner.run(
        ManagedTool::Ffprobe,
        &args,
        job_dir,
        RunPolicy::standard(false),
        cancelled,
        |_| {},
    )?;
    if !output.status.success() {
        return Err(HostError::new(
            ErrorCode::ToolsIncompatible,
            "ffprobe could not validate the media output",
        ));
    }
    let value: Value = serde_json::from_str(&output.stdout_lines.join("\n")).map_err(|_| {
        HostError::new(
            ErrorCode::ToolsIncompatible,
            "ffprobe returned invalid structured output",
        )
    })?;
    let duration_ms = value
        .pointer("/format/duration")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
                .or_else(|| value.as_f64())
        })
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (value * 1000.0).round() as u64);
    let mut metrics = MediaMetrics {
        duration_ms,
        video_start_ms: None,
        audio_start_ms: None,
        has_video: false,
        has_audio: false,
    };
    for stream in value
        .get("streams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = stream.get("codec_type").and_then(Value::as_str);
        let start = stream
            .get("start_time")
            .and_then(|value| {
                value
                    .as_str()
                    .and_then(|value| value.parse::<f64>().ok())
                    .or_else(|| value.as_f64())
            })
            .filter(|value| value.is_finite())
            .map(|value| (value * 1000.0).round() as i64);
        match kind {
            Some("video") => {
                metrics.has_video = true;
                metrics.video_start_ms.get_or_insert(start.unwrap_or(0));
            }
            Some("audio") => {
                metrics.has_audio = true;
                metrics.audio_start_ms.get_or_insert(start.unwrap_or(0));
            }
            _ => {}
        }
    }
    Ok(metrics)
}

fn validate_clip_output(
    metrics: &MediaMetrics,
    clip: &ClipSpec,
    audio_only: bool,
) -> Result<(), HostError> {
    let tracks_valid = if audio_only {
        metrics.has_audio
    } else {
        metrics.has_video && metrics.has_audio
    };
    if !tracks_valid {
        return Err(HostError::new(
            ErrorCode::SectionUnsupported,
            "The clip output did not contain the required media tracks",
        ));
    }
    if clip.mode == ClipMode::Exact {
        let expected = clip.end_ms - clip.start_ms;
        let actual = metrics.duration_ms.ok_or_else(|| {
            HostError::new(
                ErrorCode::ExactClipUnsupported,
                "The exact clip duration could not be verified",
            )
        })?;
        if expected.abs_diff(actual) > 100 {
            return Err(HostError::new(
                ErrorCode::ExactClipUnsupported,
                "The exact clip duration was outside the 100 ms tolerance",
            ));
        }
        if !audio_only {
            let difference =
                metrics.video_start_ms.unwrap_or(0) - metrics.audio_start_ms.unwrap_or(0);
            if difference.unsigned_abs() > 100 {
                return Err(HostError::new(
                    ErrorCode::ExactClipUnsupported,
                    "The exact clip audio/video start timestamps were not synchronized",
                ));
            }
        }
    }
    Ok(())
}

struct SavedOutput {
    path: PathBuf,
    filename: String,
    byte_size: u64,
    container: String,
}

fn save_output(
    source: &Path,
    output_root: &Path,
    title: &str,
    media_id: &str,
    clip: Option<&ClipSpec>,
) -> Result<SavedOutput, HostError> {
    ensure_output_root(output_root)?;
    let root = fs::canonicalize(output_root)?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| {
            !extension.is_empty()
                && extension.len() <= 16
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .unwrap_or("media")
        .to_ascii_lowercase();
    let title = safe_filename_component(title, 120);
    let media_id = safe_filename_component(media_id, 64);
    let clip_suffix = clip
        .map(|clip| {
            format!(
                " clip {}-{}",
                decimal_seconds(clip.start_ms),
                decimal_seconds(clip.end_ms)
            )
        })
        .unwrap_or_default();
    let base = format!("{title} [{media_id}]{clip_suffix}");
    let final_path = collision_safe_path(&root, &base, &extension)?;
    let staging = root.join(format!(".{}.partial", opaque_token("saving")?));
    copy_private(source, &staging)?;
    if let Err(error) = fs::hard_link(&staging, &final_path) {
        let _ = fs::remove_file(&staging);
        return Err(error.into());
    }
    fs::remove_file(&staging)?;
    let canonical = fs::canonicalize(&final_path)?;
    if canonical.parent() != Some(root.as_path()) {
        let _ = fs::remove_file(&canonical);
        return Err(HostError::new(
            ErrorCode::Internal,
            "The final output escaped the configured output directory",
        ));
    }
    let byte_size = fs::metadata(&canonical)?.len();
    Ok(SavedOutput {
        filename: canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: canonical,
        byte_size,
        container: extension,
    })
}

fn ensure_output_root(path: &Path) -> Result<(), HostError> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        create_private_dir(path)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(HostError::new(
            ErrorCode::OutputUnavailable,
            "The Media Sniper output directory is not a safe directory",
        ));
    }
    Ok(())
}

fn collision_safe_path(root: &Path, base: &str, extension: &str) -> Result<PathBuf, HostError> {
    for suffix in 0..10_000_u32 {
        let suffix = if suffix == 0 {
            String::new()
        } else {
            format!(" ({suffix})")
        };
        let candidate = root.join(format!("{base}{suffix}.{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(HostError::new(
        ErrorCode::OutputUnavailable,
        "No collision-safe output filename was available",
    ))
}

fn copy_private(source: &Path, destination: &Path) -> Result<(), HostError> {
    let mut source = File::open(source)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut destination = options.open(destination)?;
    io::copy(&mut source, &mut destination)?;
    destination.flush()?;
    destination.sync_all()?;
    Ok(())
}

struct JobTemp {
    path: PathBuf,
}

struct PreparedJobContext {
    temp: JobTemp,
    auth: PreparedAuth,
}

impl PreparedJobContext {
    fn path(&self) -> &Path {
        self.temp.path()
    }
}

impl JobTemp {
    fn create(root: &Path) -> Result<Self, HostError> {
        fs::create_dir_all(root)?;
        let path = root.join(opaque_token("job")?);
        create_private_dir(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for JobTemp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn cleanup_stale_jobs(
    root: &Path,
    older_than: std::time::Duration,
) -> Result<usize, HostError> {
    if !root.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if !metadata.is_dir() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed >= older_than);
        if stale {
            fs::remove_dir_all(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::ProbeRecord;
    use std::time::SystemTime;
    use tempfile::tempdir;

    fn record(url: &str) -> ProbeRecord {
        let selection = CachedSelection {
            key: "best".into(),
            label: "Best".into(),
            selector: "bestvideo*+bestaudio/best".into(),
            estimated_bytes: Some(10),
            expected_container: None,
            audio_only: false,
        };
        ProbeRecord {
            token: "probe".into(),
            requested_page_url: url.into(),
            page_url: url.into(),
            extractor_key: "Generic".into(),
            media_id: "id".into(),
            title: "title".into(),
            duration_ms: Some(10_000),
            is_live: false,
            is_drm: false,
            selections: [("best".into(), selection)].into_iter().collect(),
            created: SystemTime::now(),
        }
    }

    #[test]
    fn typed_ytdlp_plan_terminates_options_before_url() {
        let record = record("https://example.com/watch/--exec=bad");
        let selection = record.selection("best").unwrap();
        let args = yt_dlp_download_args(
            &record,
            selection,
            Path::new("/controlled/job"),
            Path::new("/controlled/tools"),
            Path::new("/controlled/tools/deno"),
            None,
        );
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), &record.page_url);
        assert!(args.contains(&"--ignore-config".to_owned()));
        assert!(args.contains(&"--no-plugin-dirs".to_owned()));
        assert!(args.contains(&"--no-js-runtimes".to_owned()));
        assert!(args.contains(&"--no-remote-components".to_owned()));
        assert!(args.contains(&"deno:/controlled/tools/deno".to_owned()));
        assert!(!args.iter().any(|arg| arg == "--exec"));
    }

    #[test]
    fn dns_validation_precedes_job_cookie_materialization() {
        let root = tempdir().unwrap();
        let temp_root = root.path().join("jobs");
        let url = "https://public-looking.example/watch";
        let auth = AuthRequest::CurrentTab {
            page_url: url.into(),
            referer: url.into(),
            user_agent: "Brave secret agent".into(),
            cookie_store_id: "store-1".into(),
            incognito: false,
            cookies: vec![crate::protocol::CookieRecord {
                name: "session".into(),
                value: "secret".into(),
                domain: ".example".into(),
                path: "/".into(),
                secure: true,
                http_only: true,
                same_site: crate::protocol::CookieSameSite::Lax,
                host_only: false,
                expiration_date: None,
                session: true,
            }],
        };
        let result =
            prepare_job_context_with_resolver(&auth, url, &temp_root, &[], false, |_, _| {
                assert!(!temp_root.exists());
                Err(HostError::new(
                    ErrorCode::UrlUnsupported,
                    "fixture DNS rejection",
                ))
            });
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("DNS rejection unexpectedly prepared authentication"),
        };
        assert_eq!(error.code, ErrorCode::UrlUnsupported);
        assert!(!temp_root.exists());
    }

    #[test]
    fn clip_boundaries_preserve_integer_milliseconds() {
        let record = record("https://example.com/watch");
        let clip = ClipSpec {
            start_ms: 1234,
            end_ms: 11234,
            mode: ClipMode::Exact,
        };
        let args = yt_dlp_download_args(
            &record,
            record.selection("best").unwrap(),
            Path::new("/controlled/job"),
            Path::new("/controlled/tools"),
            Path::new("/controlled/tools/deno"),
            Some(&clip),
        );
        assert!(args.contains(&"*1.234-11.234".to_owned()));
        assert!(args.contains(&"--force-keyframes-at-cuts".to_owned()));
    }

    #[test]
    fn final_output_cannot_follow_an_output_root_symlink() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let output = temp.path().join("output");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &output).unwrap();
            assert!(save_output(&source, &output, "../../title", "../id", None).is_err());
        }
    }

    #[test]
    fn progress_with_unknown_total_has_no_fake_percentage() {
        let progress =
            parse_progress_marker("job", "MEDIA_SNIPER_PROGRESS:{\"downloaded_bytes\":100}")
                .unwrap();
        assert_eq!(progress.downloaded_bytes, Some(100));
        assert_eq!(progress.percentage, None);
    }

    #[test]
    fn stale_download_failures_request_an_update_without_raw_diagnostics() {
        let error = classify_download_diagnostic(
            "WARNING: Your yt-dlp version is older than 90 days!\nERROR: HTTP Error 403: Forbidden",
            &AuthRequest::Anonymous,
        );
        assert_eq!(error.code, ErrorCode::ToolsOutdated);
        assert_eq!(error.code.as_str(), "TOOLS_INCOMPATIBLE");
        assert_eq!(
            error.safe_message(),
            "Media Sniper's media tools need an update to keep up with this site"
        );
        assert!(!error.safe_message().contains("403"));
    }

    #[test]
    fn output_receipt_resolves_after_registry_restart() {
        let root = tempdir().unwrap();
        let output = root.path().join("output");
        let receipts = root.path().join("receipts");
        fs::create_dir(&output).unwrap();
        let file = output.join("media.mp4");
        fs::write(&file, b"media").unwrap();
        let token = OutputRegistry::new(receipts.clone(), output.clone())
            .unwrap()
            .register(file.clone())
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let receipt = receipts.join(format!("{token}.json"));
            assert_eq!(
                fs::metadata(receipt).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let restarted = OutputRegistry::new(receipts, output).unwrap();
        assert_eq!(
            restarted.resolve(&token).unwrap(),
            fs::canonicalize(file).unwrap()
        );
    }

    #[test]
    fn output_receipt_rejects_token_traversal_and_path_escape() {
        let root = tempdir().unwrap();
        let output = root.path().join("output");
        let receipts = root.path().join("receipts");
        fs::create_dir(&output).unwrap();
        let outside = root.path().join("outside.mp4");
        fs::write(&outside, b"media").unwrap();
        let registry = OutputRegistry::new(receipts.clone(), output).unwrap();
        assert!(registry.resolve("../../outside").is_err());

        let token = format!("output-{}", "0".repeat(48));
        fs::write(
            receipts.join(format!("{token}.json")),
            serde_json::to_vec(&OutputReceipt {
                version: 1,
                path: outside.to_string_lossy().into_owned(),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(registry.resolve(&token).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn output_receipt_rejects_symlinked_final_file() {
        let root = tempdir().unwrap();
        let output = root.path().join("output");
        let receipts = root.path().join("receipts");
        fs::create_dir(&output).unwrap();
        let outside = root.path().join("outside.mp4");
        fs::write(&outside, b"media").unwrap();
        let link = output.join("media.mp4");
        std::os::unix::fs::symlink(outside, &link).unwrap();
        let registry = OutputRegistry::new(receipts, output).unwrap();
        assert!(registry.register(link).is_err());
    }
}
