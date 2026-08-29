use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

fn main() {
    let executable = std::env::args().next().unwrap_or_default();
    let name = Path::new(&executable)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--version" | "-version"))
    {
        if name == "deno" {
            println!("deno 2.6.1");
        } else {
            println!("fake-{name} 1.0");
        }
        return;
    }
    match name.as_ref() {
        "yt-dlp" => fake_ytdlp(&args),
        "ffmpeg" => fake_ffmpeg(&args),
        "ffprobe" => fake_ffprobe(&args),
        "deno" => {}
        _ => panic!("unsupported fake tool name: {name}"),
    }
}

fn fake_ytdlp(args: &[String]) {
    let url = args.last().cloned().unwrap_or_default();
    if args.iter().any(|arg| arg == "--dump-single-json") {
        if url.contains("/probe-stall") {
            thread::sleep(Duration::from_secs(5));
        }
        if url.contains("/oversized-probe") {
            println!("{}", "x".repeat(8 * 1024 * 1024 + 1));
            return;
        }
        if url.contains("/auth")
            && !args
                .iter()
                .any(|arg| matches!(arg.as_str(), "--cookies" | "--cookies-from-browser"))
        {
            eprintln!("ERROR: Sign in to confirm access; use cookies");
            std::process::exit(1);
        }
        if url.contains("/playlist") {
            println!(
                "{}",
                json!({"_type":"playlist","entries":[{"id":"one"},{"id":"two"}]})
            );
            return;
        }
        let webpage_url = if url == "https://www.youtube.com/watch?v=id&t=30s" {
            "https://www.youtube.com/watch?v=id".to_owned()
        } else {
            url.clone()
        };
        let title = if url.contains("/profile-env") {
            std::env::var("PATH").unwrap_or_default()
        } else {
            "Fixture ../ media".to_owned()
        };
        println!(
            "{}",
            json!({
                "extractor_key": "Fake",
                "id": "fixture-id",
                "title": title,
                "webpage_url": webpage_url,
                "duration": 60.0,
                "thumbnail": "https://images.example.test/thumb.jpg?signature=secret",
                "formats": [{"format_id":"unsafe --exec", "url":"https://signed.example.test/v?token=secret", "filesize":4096}]
            })
        );
        return;
    }

    let section = value_after(args, "--download-sections");
    if section.is_some() && url.contains("/section-fail") {
        eprintln!("ERROR: section download unsupported");
        std::process::exit(2);
    }
    if url.contains("/slow") {
        for _ in 0..100 {
            thread::sleep(Duration::from_millis(50));
        }
    }
    let home = args
        .windows(2)
        .filter(|pair| pair[0] == "--paths")
        .find_map(|pair| pair[1].strip_prefix("home:"))
        .map(PathBuf::from)
        .expect("controlled home path");
    let (filename, duration) = if let Some(section) = section {
        ("section.mp4", section_duration(&section))
    } else {
        ("source.webm", 60.0)
    };
    let output = home.join(filename);
    fs::write(
        &output,
        format!("duration={duration:.3};video=1;audio=1;vstart=0;astart=0"),
    )
    .unwrap();
    println!(
        "MEDIA_SNIPER_PROGRESS:{}",
        json!({"downloaded_bytes":2048,"total_bytes":4096,"speed":1024.0,"eta":2.0})
    );
    println!(
        "MEDIA_SNIPER_FILE:{}",
        serde_json::to_string(&output.to_string_lossy()).unwrap()
    );
    eprintln!("fake child diagnostic on stderr only");
}

fn fake_ffmpeg(args: &[String]) {
    let output = PathBuf::from(args.last().expect("ffmpeg output"));
    let duration = value_after(args, "-t")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(10.0);
    let audio_only = !args.iter().any(|arg| arg == "0:v:0");
    fs::write(
        output,
        format!(
            "duration={duration:.3};video={};audio=1;vstart=0;astart=0",
            if audio_only { 0 } else { 1 }
        ),
    )
    .unwrap();
}

fn fake_ffprobe(args: &[String]) {
    let path = PathBuf::from(args.last().expect("ffprobe input"));
    let contents = fs::read_to_string(path).unwrap();
    let field = |name: &str| {
        contents
            .split(';')
            .find_map(|entry| entry.strip_prefix(&format!("{name}=")))
            .unwrap_or("0")
            .to_owned()
    };
    let mut streams = Vec::new();
    if field("video") == "1" {
        streams.push(json!({"codec_type":"video","start_time":field("vstart")}));
    }
    if field("audio") == "1" {
        streams.push(json!({"codec_type":"audio","start_time":field("astart")}));
    }
    println!(
        "{}",
        json!({"format":{"duration":field("duration")},"streams":streams})
    );
}

fn value_after(args: &[String], option: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == option)
        .map(|pair| pair[1].clone())
}

fn section_duration(section: &str) -> f64 {
    let section = section.trim_start_matches('*');
    let mut parts = section.split('-');
    let start = parts
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    let end = parts
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(start);
    end - start
}
