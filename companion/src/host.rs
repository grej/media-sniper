use crate::framing::{read_envelope, write_envelope};
use crate::jobs::{
    cleanup_stale_jobs, EventSink, FallbackRegistry, JobExecutor, JobSpec, OutputRegistry,
};
use crate::probe::{probe, ProbeCache};
use crate::protocol::{
    CancelJobRequest, CapabilitySet, Envelope, ErrorCode, HelloRequest, HelloResult, HostError,
    JobFailed, JobQueued, JobState, OutputActionRequest, ProbeRequest, StartClipRequest,
    StartDownloadRequest, PROTOCOL_VERSION,
};
use crate::runner::ProcessRunner;
use crate::security::{create_private_dir, redact_diagnostic};
use crate::tools::{discover_brave_profiles, ToolManager};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Clone)]
pub struct CompanionConfig {
    pub app_root: PathBuf,
    pub user_home: PathBuf,
    pub temp_root: PathBuf,
    pub output_root: PathBuf,
    pub developer_mode: bool,
    pub developer_tool_dir: Option<PathBuf>,
    pub probe_timeout: Duration,
}

impl CompanionConfig {
    pub fn discover() -> Result<Self, HostError> {
        let user_home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
            HostError::new(
                ErrorCode::Internal,
                "The user home directory is unavailable",
            )
        })?;
        let app_root = if cfg!(target_os = "macos") {
            user_home.join("Library/Application Support/Media Sniper")
        } else if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| user_home.join("AppData/Local"))
                .join("Media Sniper")
        } else {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| user_home.join(".local/share"))
                .join("media-sniper")
        };
        let developer_mode = std::env::var("MEDIA_SNIPER_DEVELOPER_MODE").as_deref() == Ok("1");
        let developer_tool_dir = developer_mode
            .then(|| std::env::var_os("MEDIA_SNIPER_DEV_TOOL_DIR").map(PathBuf::from))
            .flatten();
        Ok(Self {
            temp_root: app_root.join("jobs"),
            output_root: user_home.join("Downloads/Media Sniper"),
            app_root,
            user_home,
            developer_mode,
            developer_tool_dir,
            probe_timeout: Duration::from_secs(75),
        })
    }

    fn prepare(&self) -> Result<(), HostError> {
        ensure_private_directory(&self.app_root)?;
        ensure_private_directory(&self.temp_root)?;
        ensure_private_directory(&self.app_root.join("runtime-home"))?;
        let _ = cleanup_stale_jobs(&self.temp_root, Duration::from_secs(24 * 60 * 60))?;
        Ok(())
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), HostError> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        create_private_dir(path)?;
    }
    if !path.is_dir() {
        return Err(HostError::new(
            ErrorCode::Internal,
            "A companion data directory is invalid",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

struct QueuedJob {
    request_id: String,
    spec: JobSpec,
    cancelled: Arc<AtomicBool>,
}

pub struct Host {
    config: CompanionConfig,
    tools: ToolManager,
    probes: Mutex<ProbeCache>,
    outputs: OutputRegistry,
    fallbacks: FallbackRegistry,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    port_closed: Arc<AtomicBool>,
    queued_count: Arc<AtomicUsize>,
    queue: Option<mpsc::Sender<QueuedJob>>,
    worker: Option<JoinHandle<()>>,
    sink: EventSink,
}

impl Host {
    pub fn new(config: CompanionConfig, sink: EventSink) -> Result<Self, HostError> {
        config.prepare()?;
        let tools = ToolManager::new(
            config.app_root.join("tools"),
            config.developer_tool_dir.clone(),
        );
        let outputs = OutputRegistry::new(
            config.app_root.join("output-receipts"),
            config.output_root.clone(),
        )?;
        let fallbacks = FallbackRegistry::default();
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let port_closed = Arc::new(AtomicBool::new(false));
        let queued_count = Arc::new(AtomicUsize::new(0));
        let mut queue = None;
        let mut worker = None;
        if let Ok(paths) = tools.resolve_active_paths() {
            let runner = ProcessRunner::new(
                paths,
                config.app_root.join("runtime-home"),
                config.user_home.clone(),
            );
            let profiles = discover_brave_profiles(&config.user_home);
            let profile_ids = profiles.into_iter().map(|profile| profile.id).collect();
            let executor = JobExecutor::new(
                runner,
                config.temp_root.clone(),
                config.output_root.clone(),
                profile_ids,
                config.developer_mode,
                outputs.clone(),
                fallbacks.clone(),
                sink.clone(),
            );
            let (sender, receiver) = mpsc::channel::<QueuedJob>();
            let worker_cancellations = cancellations.clone();
            let worker_queued = queued_count.clone();
            let worker_sink = sink.clone();
            worker = Some(thread::spawn(move || {
                while let Ok(job) = receiver.recv() {
                    worker_queued.fetch_sub(1, Ordering::AcqRel);
                    let job_id = job.spec.job_id().to_owned();
                    let result = executor.execute(&job.request_id, job.spec, job.cancelled);
                    match result {
                        Ok(Some(completed)) => {
                            emit(&worker_sink, &job.request_id, "job_completed", completed)
                        }
                        Ok(None) => {}
                        Err(error) if error.code == ErrorCode::Cancelled => emit(
                            &worker_sink,
                            &job.request_id,
                            "job_cancelled",
                            JobState {
                                job_id: job_id.clone(),
                            },
                        ),
                        Err(error) if error.code == ErrorCode::AuthRequired => emit(
                            &worker_sink,
                            &job.request_id,
                            "auth_required",
                            JobFailed::from_error(Some(job_id.clone()), &error),
                        ),
                        Err(error) => emit(
                            &worker_sink,
                            &job.request_id,
                            "job_failed",
                            JobFailed::from_error(Some(job_id.clone()), &error),
                        ),
                    }
                    worker_cancellations.lock().unwrap().remove(&job_id);
                }
            }));
            queue = Some(sender);
        }
        Ok(Self {
            config,
            tools,
            probes: Mutex::new(ProbeCache::default()),
            outputs,
            fallbacks,
            cancellations,
            port_closed,
            queued_count,
            queue,
            worker,
            sink,
        })
    }

    pub fn run_stdio(config: CompanionConfig) -> Result<(), HostError> {
        let output = Arc::new(Mutex::new(std::io::stdout()));
        let sink: EventSink = {
            let output = output.clone();
            Arc::new(move |envelope| {
                if let Err(error) = write_envelope(&mut *output.lock().unwrap(), &envelope) {
                    eprintln!("media-sniper-companion: {}", error.safe_message());
                }
            })
        };
        let host = Host::new(config, sink)?;
        let cancellations = host.cancellations.clone();
        let port_closed = host.port_closed.clone();
        let (sender, receiver) = mpsc::channel();
        let dispatch = thread::spawn(move || {
            let mut host = host;
            while let Ok(envelope) = receiver.recv() {
                host.handle(envelope);
            }
            host.shutdown();
        });

        let mut input = std::io::stdin();
        loop {
            match read_envelope(&mut input) {
                Ok(Some(envelope)) => {
                    if sender.send(envelope).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    eprintln!("media-sniper-companion: {}", error.safe_message());
                    break;
                }
            }
        }
        port_closed.store(true, Ordering::Release);
        cancel_all(&cancellations);
        drop(sender);
        dispatch.join().map_err(|_| {
            HostError::new(
                ErrorCode::Internal,
                "The companion dispatcher stopped unexpectedly",
            )
        })?;
        Ok(())
    }

    pub fn run_reader(mut self, reader: &mut impl Read) -> Result<(), HostError> {
        while let Some(envelope) = read_envelope(reader)? {
            self.handle(envelope);
        }
        self.shutdown();
        Ok(())
    }

    pub fn handle(&mut self, envelope: Envelope) {
        if self.port_closed.load(Ordering::Acquire) {
            return;
        }
        if envelope.protocol_version != PROTOCOL_VERSION {
            self.emit_error(
                &envelope.request_id,
                None,
                HostError::new(
                    ErrorCode::ProtocolMismatch,
                    "The extension and companion protocol versions do not match",
                ),
            );
            return;
        }
        let result = match envelope.message_type.as_str() {
            "hello" => self.handle_hello(&envelope),
            "probe" => self.handle_probe(&envelope),
            "start_download" => self.handle_download(&envelope),
            "start_clip" => self.handle_clip(&envelope),
            "cancel_job" => self.handle_cancel(&envelope),
            "reveal_output" => self.handle_output_action(&envelope, true),
            "open_output" => self.handle_output_action(&envelope, false),
            "install_tools" | "update_tools" => self.handle_tool_action(&envelope),
            _ => Err(HostError::new(
                ErrorCode::InvalidRequest,
                "The extension sent an unsupported companion message",
            )),
        };
        if let Err(error) = result {
            let message_type = if error.code == ErrorCode::AuthRequired {
                "auth_required"
            } else {
                "job_failed"
            };
            let payload = JobFailed::from_error(None, &error);
            emit(&self.sink, &envelope.request_id, message_type, payload);
        }
    }

    fn handle_hello(&self, envelope: &Envelope) -> Result<(), HostError> {
        let request: HelloRequest = envelope.parse_payload()?;
        if request.extension_version.is_empty() || request.extension_version.len() > 64 {
            return Err(HostError::new(
                ErrorCode::InvalidRequest,
                "The extension version was invalid",
            ));
        }
        let health = self.tools.health();
        let healthy = health.healthy();
        let profiles = discover_brave_profiles(&self.config.user_home);
        emit(
            &self.sink,
            &envelope.request_id,
            "hello_result",
            HelloResult {
                protocol_version: PROTOCOL_VERSION,
                companion_version: env!("CARGO_PKG_VERSION").to_owned(),
                browser_target: request.browser_target,
                platform: platform_name().to_owned(),
                yt_dlp_version: health.yt_dlp_version,
                ffmpeg_version: health.ffmpeg_version,
                ffprobe_version: health.ffprobe_version,
                js_runtime: health.js_runtime,
                healthy,
                issues: health.issues,
                capabilities: CapabilitySet {
                    probe: healthy,
                    download: healthy,
                    section_download: healthy,
                    exact_clip: healthy,
                    current_tab_cookies: true,
                    brave_profile_cookies: !profiles.is_empty(),
                    reveal_output: true,
                },
                brave_profiles: profiles,
            },
        );
        Ok(())
    }

    fn handle_probe(&mut self, envelope: &Envelope) -> Result<(), HostError> {
        let request: ProbeRequest = envelope.parse_payload()?;
        let paths = self.tools.resolve_active_paths()?;
        let runner = ProcessRunner::new(
            paths,
            self.config.app_root.join("runtime-home"),
            self.config.user_home.clone(),
        );
        let profiles = discover_brave_profiles(&self.config.user_home);
        let ids = profiles
            .into_iter()
            .map(|profile| profile.id)
            .collect::<Vec<_>>();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_key = format!("probe:{}", envelope.request_id);
        self.cancellations
            .lock()
            .unwrap()
            .insert(cancel_key.clone(), cancelled.clone());
        let result = probe(
            &request,
            &runner,
            &self.config.temp_root,
            &ids,
            self.config.developer_mode,
            &cancelled,
            self.config.probe_timeout,
        );
        self.cancellations.lock().unwrap().remove(&cancel_key);
        let (summary, record) = result?;
        let mut probes = self.probes.lock().unwrap();
        probes.invalidate_page(&record.requested_page_url);
        probes.insert(record);
        emit(&self.sink, &envelope.request_id, "probe_result", summary);
        Ok(())
    }

    fn handle_download(&mut self, envelope: &Envelope) -> Result<(), HostError> {
        let request: StartDownloadRequest = envelope.parse_payload()?;
        validate_job_id(&request.job_id)?;
        let probe = self.probes.lock().unwrap().get(&request.probe_token)?;
        probe.selection(&request.selection_key)?;
        self.enqueue(
            envelope.request_id.clone(),
            JobSpec::Download { request, probe },
        )
    }

    fn handle_clip(&mut self, envelope: &Envelope) -> Result<(), HostError> {
        let request: StartClipRequest = envelope.parse_payload()?;
        validate_job_id(&request.job_id)?;
        if request.allow_full_download_fallback {
            self.fallbacks.validate_resume(&request)?;
        }
        let probe = self.probes.lock().unwrap().get(&request.probe_token)?;
        probe.selection(&request.selection_key)?;
        self.enqueue(
            envelope.request_id.clone(),
            JobSpec::Clip { request, probe },
        )
    }

    fn enqueue(&mut self, request_id: String, spec: JobSpec) -> Result<(), HostError> {
        let sender = self.queue.as_ref().ok_or_else(|| {
            HostError::new(
                ErrorCode::ToolsMissing,
                "Install the managed yt-dlp and FFmpeg tools to continue",
            )
        })?;
        let job_id = spec.job_id().to_owned();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut cancellations = self.cancellations.lock().unwrap();
            if cancellations.contains_key(&job_id) {
                return Err(HostError::new(
                    ErrorCode::InvalidRequest,
                    "A companion job with this identity is already active",
                ));
            }
            cancellations.insert(job_id.clone(), cancelled.clone());
        }
        let position = self.queued_count.fetch_add(1, Ordering::AcqRel) + 1;
        if sender
            .send(QueuedJob {
                request_id: request_id.clone(),
                spec,
                cancelled,
            })
            .is_err()
        {
            self.queued_count.fetch_sub(1, Ordering::AcqRel);
            self.cancellations.lock().unwrap().remove(&job_id);
            return Err(HostError::new(
                ErrorCode::JobInterrupted,
                "The companion job queue is unavailable",
            ));
        }
        emit(
            &self.sink,
            &request_id,
            "job_queued",
            JobQueued { job_id, position },
        );
        Ok(())
    }

    fn handle_cancel(&self, envelope: &Envelope) -> Result<(), HostError> {
        let request: CancelJobRequest = envelope.parse_payload()?;
        validate_job_id(&request.job_id)?;
        if self.fallbacks.cancel_pending(&request.job_id) {
            if let Some(flag) = self
                .cancellations
                .lock()
                .unwrap()
                .get(&request.job_id)
                .cloned()
            {
                flag.store(true, Ordering::Release);
            }
            emit(
                &self.sink,
                &envelope.request_id,
                "job_cancelled",
                JobState {
                    job_id: request.job_id,
                },
            );
            return Ok(());
        }
        let flag = self
            .cancellations
            .lock()
            .unwrap()
            .get(&request.job_id)
            .cloned();
        if let Some(flag) = flag {
            flag.store(true, Ordering::Release);
            return Ok(());
        }
        Err(HostError::new(
            ErrorCode::InvalidRequest,
            "The companion job is not active",
        ))
    }

    fn handle_output_action(&self, envelope: &Envelope, reveal: bool) -> Result<(), HostError> {
        let request: OutputActionRequest = envelope.parse_payload()?;
        let path = self.outputs.resolve(&request.output_token)?;
        platform_output_action(&path, reveal)
    }

    fn handle_tool_action(&self, envelope: &Envelope) -> Result<(), HostError> {
        if envelope.payload != json!({}) {
            return Err(HostError::new(
                ErrorCode::InvalidRequest,
                "Tool actions do not accept extension-provided settings or paths",
            ));
        }
        emit(
            &self.sink,
            &envelope.request_id,
            "tool_progress",
            json!({
                "stage": "installer-required",
                "detail": "Use the signed Media Sniper graphical installer to install or update managed tools"
            }),
        );
        Err(HostError::new(
            ErrorCode::ToolsInstallUnavailable,
            "Managed tool payload is not available in this companion package",
        ))
    }

    fn emit_error(&self, request_id: &str, job_id: Option<String>, error: HostError) {
        emit(
            &self.sink,
            request_id,
            "job_failed",
            JobFailed::from_error(job_id, &error),
        );
    }

    fn shutdown(&mut self) {
        self.port_closed.store(true, Ordering::Release);
        cancel_all(&self.cancellations);
        self.queue.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn emit<T: serde::Serialize>(sink: &EventSink, request_id: &str, message_type: &str, payload: T) {
    match Envelope::response(request_id, message_type, payload) {
        Ok(envelope) => sink(envelope),
        Err(error) => eprintln!("media-sniper-companion: {}", error.safe_message()),
    }
}

fn cancel_all(cancellations: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>) {
    for cancellation in cancellations.lock().unwrap().values() {
        cancellation.store(true, Ordering::Release);
    }
}

fn validate_job_id(job_id: &str) -> Result<(), HostError> {
    if job_id.is_empty()
        || job_id.len() > 128
        || job_id.starts_with('-')
        || !job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "The companion job identity is invalid",
        ));
    }
    Ok(())
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn platform_output_action(path: &Path, reveal: bool) -> Result<(), HostError> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("/usr/bin/open");
        if reveal {
            command.arg("-R");
        }
        command.arg(path);
        command
    } else if cfg!(windows) {
        let mut command = Command::new("explorer.exe");
        if reveal {
            command.arg(format!("/select,{}", path.to_string_lossy()));
        } else {
            command.arg(path);
        }
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(if reveal {
            path.parent().unwrap_or(path)
        } else {
            path
        });
        command
    };
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .status()
        .map_err(|error| {
            HostError::new(
                ErrorCode::OutputUnavailable,
                format!("The operating system could not open the output: {error}"),
            )
        })?;
    if !status.success() {
        return Err(HostError::new(
            ErrorCode::OutputUnavailable,
            "The operating system could not open the completed output",
        ));
    }
    Ok(())
}

pub fn redacted_host_diagnostic(error: &HostError) -> String {
    redact_diagnostic(&error.safe_message())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn job_ids_cannot_be_paths_or_options() {
        for id in ["../job", "/tmp/job", "--exec", "job with spaces", ""] {
            assert!(validate_job_id(id).is_err(), "{id}");
        }
        assert!(validate_job_id("0f2a-job_id").is_ok());
    }

    #[test]
    fn startup_cleanup_is_scoped_to_job_root() {
        let root = tempdir().unwrap();
        let outside = root.path().join("outside");
        let jobs = root.path().join("jobs");
        fs::create_dir_all(jobs.join("stale")).unwrap();
        fs::write(&outside, b"keep").unwrap();
        cleanup_stale_jobs(&jobs, Duration::ZERO).unwrap();
        assert!(outside.exists());
        assert!(!jobs.join("stale").exists());
    }
}
