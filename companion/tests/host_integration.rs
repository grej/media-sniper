#![cfg(feature = "test-tool")]

use media_sniper_companion::host::{CompanionConfig, Host};
use media_sniper_companion::jobs::EventSink;
use media_sniper_companion::protocol::{Envelope, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

struct Harness {
    _root: TempDir,
    host: Host,
    events: Arc<Mutex<Vec<Envelope>>>,
    jobs: std::path::PathBuf,
    output: std::path::PathBuf,
}

impl Harness {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let tools = root.path().join("tools");
        fs::create_dir_all(&tools).unwrap();
        let fake = Path::new(env!("CARGO_BIN_EXE_media-sniper-fake-tool"));
        for name in ["yt-dlp", "ffmpeg", "ffprobe", "deno"] {
            let destination = tools.join(name);
            fs::copy(fake, &destination).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&destination, fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        let app = root.path().join("app");
        let jobs = app.join("jobs");
        let output = root.path().join("Downloads/Media Sniper");
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let host = Host::new(
            CompanionConfig {
                app_root: app.clone(),
                user_home: root.path().join("home"),
                temp_root: jobs.clone(),
                output_root: output.clone(),
                developer_mode: true,
                developer_tool_dir: Some(tools),
            },
            sink,
        )
        .unwrap();
        Self {
            _root: root,
            host,
            events,
            jobs,
            output,
        }
    }

    fn send(&mut self, request_id: &str, message_type: &str, payload: Value) {
        self.host.handle(Envelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            message_type: message_type.into(),
            payload,
        });
    }

    fn wait(&self, message_type: &str, job_id: Option<&str>) -> Value {
        let started = Instant::now();
        loop {
            if let Some(event) = self.events.lock().unwrap().iter().rev().find(|event| {
                event.message_type == message_type
                    && job_id.is_none_or(|job_id| {
                        event.payload.get("jobId").and_then(Value::as_str) == Some(job_id)
                    })
            }) {
                return event.payload.clone();
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "missing {message_type}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn probe(&mut self, url: &str, auth: Value) -> String {
        self.send("probe-request", "probe", json!({"pageUrl":url,"auth":auth}));
        self.wait("probe_result", None)["probeToken"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[test]
fn hello_probe_download_progress_and_receipt_flow_through_fake_tools() {
    let mut harness = Harness::new();
    harness.send(
        "hello-request",
        "hello",
        json!({"browserTarget":"brave","extensionVersion":"1.12.0"}),
    );
    let health = harness.wait("hello_result", None);
    assert_eq!(health["healthy"], true);
    assert_eq!(health["browserTarget"], "brave");

    let token = harness.probe("https://example.com/watch", json!({"mode":"anonymous"}));
    harness.send(
        "download-request",
        "start_download",
        json!({
            "jobId":"download-job", "probeToken":token, "selectionKey":"best",
            "auth":{"mode":"anonymous"}
        }),
    );
    harness.wait("job_queued", Some("download-job"));
    let completed = harness.wait("job_completed", Some("download-job"));
    assert!(harness.events.lock().unwrap().iter().any(|event| {
        event.message_type == "job_progress"
            && event.payload["jobId"] == "download-job"
            && event.payload.get("percentage").is_some()
    }));
    assert_eq!(completed["container"], "webm");
    let final_path = completed["finalPath"].as_str().unwrap();
    assert!(Path::new(final_path).starts_with(fs::canonicalize(&harness.output).unwrap()));
    assert!(Path::new(final_path).is_file());
    assert!(!completed.to_string().contains("signed.example"));
    wait_for_empty(&harness.jobs);
}

#[test]
fn fallback_requires_matching_prior_event_and_same_job_resume() {
    let mut harness = Harness::new();
    let token = harness.probe(
        "https://example.com/section-fail",
        json!({"mode":"anonymous"}),
    );
    let request = |allow| {
        json!({
            "jobId":"clip-job", "probeToken":token, "selectionKey":"best",
            "clip":{"startMs":1234,"endMs":11234,"mode":"exact"},
            "allowFullDownloadFallback":allow, "auth":{"mode":"anonymous"}
        })
    };

    harness.send("clip-direct", "start_clip", request(false));
    let fallback = harness.wait("fallback_required", Some("clip-job"));
    assert_eq!(fallback["reason"], "section-unsupported");
    wait_for_empty(&harness.jobs);

    harness.send("clip-resume", "start_clip", request(true));
    let completed = harness.wait("job_completed", Some("clip-job"));
    assert_eq!(completed["accuracy"], "exact");
    assert_eq!(completed["durationMs"], 10_000);
    wait_for_empty(&harness.jobs);

    harness.send(
        "unapproved",
        "start_clip",
        json!({
            "jobId":"different-job", "probeToken":token, "selectionKey":"best",
            "clip":{"startMs":1234,"endMs":11234,"mode":"exact"},
            "allowFullDownloadFallback":true, "auth":{"mode":"anonymous"}
        }),
    );
    let failed = harness.wait("job_failed", None);
    assert_eq!(failed["code"], "INVALID_REQUEST");
}

#[test]
fn current_tab_cookie_secret_is_ephemeral_and_never_emitted() {
    let mut harness = Harness::new();
    let url = "https://example.com/authenticated";
    let token = harness.probe(
        url,
        json!({
            "mode":"current-tab", "pageUrl":url, "referer":url,
            "userAgent":"Brave fixture", "cookieStoreId":"1", "incognito":false,
            "cookies":[{
                "name":"session-name-secret", "value":"cookie-value-secret",
                "domain":".example.com", "path":"/", "secure":true,
                "httpOnly":true, "sameSite":"lax", "hostOnly":false, "session":true
            }]
        }),
    );
    assert!(token.starts_with("probe-"));
    wait_for_empty(&harness.jobs);
    let events = serde_json::to_string(&*harness.events.lock().unwrap()).unwrap();
    assert!(!events.contains("session-name-secret"));
    assert!(!events.contains("cookie-value-secret"));
}

#[test]
fn cancellation_terminates_tool_and_cleans_job_temp() {
    let mut harness = Harness::new();
    let token = harness.probe("https://example.com/slow", json!({"mode":"anonymous"}));
    harness.send(
        "slow-start",
        "start_download",
        json!({
            "jobId":"slow-job", "probeToken":token, "selectionKey":"best",
            "auth":{"mode":"anonymous"}
        }),
    );
    harness.wait("job_queued", Some("slow-job"));
    harness.send("slow-cancel", "cancel_job", json!({"jobId":"slow-job"}));
    harness.wait("job_cancelled", Some("slow-job"));
    wait_for_empty(&harness.jobs);
    assert!(!harness.output.exists() || fs::read_dir(&harness.output).unwrap().next().is_none());
}

#[test]
fn declining_pending_fallback_cancels_and_prevents_later_resume() {
    let mut harness = Harness::new();
    let token = harness.probe(
        "https://example.com/section-fail",
        json!({"mode":"anonymous"}),
    );
    let payload = |allow| {
        json!({
            "jobId":"declined-job", "probeToken":token, "selectionKey":"best",
            "clip":{"startMs":0,"endMs":10000,"mode":"fast"},
            "allowFullDownloadFallback":allow, "auth":{"mode":"anonymous"}
        })
    };
    harness.send("decline-start", "start_clip", payload(false));
    harness.wait("fallback_required", Some("declined-job"));
    wait_for_empty(&harness.jobs);
    harness.send(
        "decline-cancel",
        "cancel_job",
        json!({"jobId":"declined-job"}),
    );
    harness.wait("job_cancelled", Some("declined-job"));
    harness.send("decline-resume", "start_clip", payload(true));
    let failed = harness.wait("job_failed", None);
    assert_eq!(failed["code"], "INVALID_REQUEST");
}

fn wait_for_empty(path: &Path) {
    let started = Instant::now();
    loop {
        let empty = path
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true);
        if empty {
            return;
        }
        assert!(started.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(10));
    }
}
