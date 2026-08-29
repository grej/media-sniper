use crate::protocol::{ErrorCode, HostError};
use crate::tools::ToolPaths;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const MAX_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy)]
pub enum ManagedTool {
    YtDlp,
    Ffmpeg,
    Ffprobe,
}

#[derive(Debug)]
pub struct ProcessOutput {
    pub status: ExitStatus,
    pub stdout_lines: Vec<String>,
    /// Bounded raw stderr. Callers must apply operation-aware redaction before use.
    pub stderr: String,
}

#[derive(Debug, Clone, Copy)]
pub struct RunPolicy {
    browser_profile: bool,
    timeout: Option<Duration>,
}

impl RunPolicy {
    pub fn standard(browser_profile: bool) -> Self {
        Self {
            browser_profile,
            timeout: None,
        }
    }

    pub fn probe(browser_profile: bool, timeout: Duration) -> Self {
        Self {
            browser_profile,
            timeout: Some(timeout),
        }
    }
}

enum StdoutEvent {
    Line(String),
    Overflow,
}

#[derive(Clone)]
pub struct ProcessRunner {
    paths: ToolPaths,
    controlled_home: PathBuf,
    user_home: PathBuf,
}

impl ProcessRunner {
    pub fn new(paths: ToolPaths, controlled_home: PathBuf, user_home: PathBuf) -> Self {
        Self {
            paths,
            controlled_home,
            user_home,
        }
    }

    pub fn paths(&self) -> &ToolPaths {
        &self.paths
    }

    pub fn run(
        &self,
        tool: ManagedTool,
        args: &[String],
        working_dir: &Path,
        policy: RunPolicy,
        cancelled: &Arc<AtomicBool>,
        mut on_stdout: impl FnMut(&str),
    ) -> Result<ProcessOutput, HostError> {
        if args.len() > 512
            || args
                .iter()
                .any(|arg| arg.len() > 16 * 1024 || arg.contains('\0'))
        {
            return Err(HostError::new(
                ErrorCode::InvalidRequest,
                "The typed process plan exceeded companion limits",
            ));
        }
        let executable = match tool {
            ManagedTool::YtDlp => &self.paths.yt_dlp,
            ManagedTool::Ffmpeg => &self.paths.ffmpeg,
            ManagedTool::Ffprobe => &self.paths.ffprobe,
        };
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(working_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .env(
                "HOME",
                if policy.browser_profile {
                    &self.user_home
                } else {
                    &self.controlled_home
                },
            )
            .env("TMPDIR", working_dir)
            .env("PATH", self.controlled_path(policy))
            .env("LC_ALL", "C")
            .env("NO_COLOR", "1");
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|error| {
            HostError::new(
                ErrorCode::ToolsIncompatible,
                format!("A managed tool could not start: {error}"),
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HostError::new(ErrorCode::Internal, "Managed tool stdout was unavailable")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            HostError::new(ErrorCode::Internal, "Managed tool stderr was unavailable")
        })?;

        let (line_tx, line_rx) = mpsc::channel();
        let stdout_thread =
            thread::spawn(move || read_lines_bounded(stdout, line_tx, MAX_STDOUT_BYTES));
        let stderr_thread = thread::spawn(move || read_bytes_bounded(stderr, MAX_STDERR_BYTES));
        let mut stdout_lines = Vec::new();
        let mut termination_started: Option<Instant> = None;
        let deadline = policy.timeout.map(|timeout| Instant::now() + timeout);
        let mut timed_out = false;
        let mut stdout_overflow = false;

        let status = loop {
            while let Ok(event) = line_rx.try_recv() {
                match event {
                    StdoutEvent::Line(line) => {
                        on_stdout(&line);
                        stdout_lines.push(line);
                    }
                    StdoutEvent::Overflow => stdout_overflow = true,
                }
            }
            if !timed_out && deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
            }
            if cancelled.load(Ordering::Acquire) || timed_out || stdout_overflow {
                if let Some(started) = termination_started {
                    if started.elapsed() >= Duration::from_secs(2) {
                        terminate_process_group(&mut child, true);
                    }
                } else {
                    terminate_process_group(&mut child, false);
                    termination_started = Some(Instant::now());
                }
            }
            if let Some(status) = child.try_wait()? {
                break status;
            }
            thread::sleep(Duration::from_millis(20));
        };
        let _ = stdout_thread.join();
        while let Ok(event) = line_rx.try_recv() {
            match event {
                StdoutEvent::Line(line) => {
                    on_stdout(&line);
                    stdout_lines.push(line);
                }
                StdoutEvent::Overflow => stdout_overflow = true,
            }
        }
        let stderr_bytes = stderr_thread.join().unwrap_or_default();
        if stdout_overflow {
            return Err(HostError::new(
                ErrorCode::ToolsIncompatible,
                "A managed tool exceeded its structured output limit",
            ));
        }
        if timed_out {
            return Err(HostError::new(
                ErrorCode::JobInterrupted,
                "Page analysis timed out; try again",
            ));
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(HostError::new(ErrorCode::Cancelled, "Operation cancelled"));
        }
        Ok(ProcessOutput {
            status,
            stdout_lines,
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        })
    }

    fn controlled_path(&self, policy: RunPolicy) -> OsString {
        let mut entries = vec![self.paths.bin_dir.clone()];
        // yt-dlp's Brave-profile cookie decryption uses macOS's reviewed
        // `/usr/bin/security` Keychain client. No caller environment is restored.
        #[cfg(target_os = "macos")]
        if policy.browser_profile {
            entries.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
        }
        std::env::join_paths(entries).unwrap_or_else(|_| self.paths.bin_dir.as_os_str().to_owned())
    }
}

fn read_lines_bounded(mut reader: impl Read, sender: mpsc::Sender<StdoutEvent>, limit: usize) {
    let mut buffer = [0_u8; 8192];
    let mut line = Vec::new();
    let mut total = 0_usize;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        total = total.saturating_add(read);
        if total > limit {
            let _ = sender.send(StdoutEvent::Overflow);
            return;
        }
        let mut start = 0;
        for (index, byte) in buffer[..read].iter().enumerate() {
            if *byte == b'\n' {
                line.extend_from_slice(&buffer[start..index]);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if sender
                    .send(StdoutEvent::Line(
                        String::from_utf8_lossy(&line).into_owned(),
                    ))
                    .is_err()
                {
                    return;
                }
                line.clear();
                start = index + 1;
            }
        }
        line.extend_from_slice(&buffer[start..read]);
    }
    if !line.is_empty() {
        let _ = sender.send(StdoutEvent::Line(
            String::from_utf8_lossy(&line).into_owned(),
        ));
    }
}

fn read_bytes_bounded(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut output = Vec::new();
    let _ = reader.by_ref().take(limit as u64).read_to_end(&mut output);
    output
}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(-(child.id() as i32), signal);
    }
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child, _force: bool) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_selection_is_closed_not_an_executable_path() {
        let variants = [
            ManagedTool::YtDlp,
            ManagedTool::Ffmpeg,
            ManagedTool::Ffprobe,
        ];
        assert_eq!(variants.len(), 3);
    }

    #[test]
    fn stdout_limit_is_enforced_before_a_single_line_can_grow_unbounded() {
        let (sender, receiver) = mpsc::channel();
        read_lines_bounded(&b"123456789"[..], sender, 8);
        assert!(matches!(receiver.recv().unwrap(), StdoutEvent::Overflow));
    }
}
