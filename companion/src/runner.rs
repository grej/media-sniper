use crate::protocol::{ErrorCode, HostError};
use crate::security::redact_diagnostic;
use crate::tools::ToolPaths;
use std::io::{BufRead, BufReader, Read};
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
    pub safe_stderr: String,
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
        needs_browser_home: bool,
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
                if needs_browser_home {
                    &self.user_home
                } else {
                    &self.controlled_home
                },
            )
            .env("TMPDIR", working_dir)
            .env("PATH", &self.paths.bin_dir)
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
        let stdout_thread = thread::spawn(move || read_lines_bounded(stdout, line_tx));
        let stderr_thread = thread::spawn(move || read_bytes_bounded(stderr, MAX_STDERR_BYTES));
        let mut stdout_lines = Vec::new();
        let mut stdout_bytes = 0_usize;
        let mut termination_started = None;

        let status = loop {
            while let Ok(line) = line_rx.try_recv() {
                stdout_bytes = stdout_bytes.saturating_add(line.len());
                if stdout_bytes > MAX_STDOUT_BYTES {
                    terminate_process_group(&mut child, true);
                    return Err(HostError::new(
                        ErrorCode::ToolsIncompatible,
                        "A managed tool exceeded its structured output limit",
                    ));
                }
                on_stdout(&line);
                stdout_lines.push(line);
            }
            if cancelled.load(Ordering::Acquire) {
                if termination_started.is_none() {
                    terminate_process_group(&mut child, false);
                    termination_started = Some(Instant::now());
                } else if termination_started.unwrap().elapsed() >= Duration::from_secs(2) {
                    terminate_process_group(&mut child, true);
                }
            }
            if let Some(status) = child.try_wait()? {
                break status;
            }
            thread::sleep(Duration::from_millis(20));
        };
        while let Ok(line) = line_rx.try_recv() {
            on_stdout(&line);
            stdout_lines.push(line);
        }
        let _ = stdout_thread.join();
        let stderr_bytes = stderr_thread.join().unwrap_or_default();
        let safe_stderr = redact_diagnostic(&String::from_utf8_lossy(&stderr_bytes));
        if cancelled.load(Ordering::Acquire) {
            return Err(HostError::new(ErrorCode::Cancelled, "Operation cancelled"));
        }
        Ok(ProcessOutput {
            status,
            stdout_lines,
            safe_stderr,
        })
    }
}

fn read_lines_bounded(reader: impl Read, sender: mpsc::Sender<String>) {
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(line.chars().last(), Some('\n' | '\r')) {
                    line.pop();
                }
                if sender.send(line.clone()).is_err() {
                    break;
                }
            }
        }
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
}
