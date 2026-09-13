use super::*;
use std::process::Command;
use std::time::SystemTime;

fn audio_selection() -> CachedSelection {
    CachedSelection {
        key: "audio-only".into(),
        label: "Audio only (MP3)".into(),
        selector: "bestaudio/best".into(),
        estimated_bytes: None,
        expected_container: Some("mp3".into()),
        audio_only: true,
    }
}

fn probe_record() -> ProbeRecord {
    ProbeRecord {
        token: "test-probe".into(),
        requested_page_url: "https://example.com/music".into(),
        page_url: "https://example.com/music".into(),
        extractor_key: "Generic".into(),
        media_id: "track".into(),
        title: "Page title".into(),
        duration_ms: Some(4_000),
        is_live: false,
        is_drm: false,
        selections: HashMap::new(),
        created: SystemTime::now(),
    }
}

#[test]
fn audio_conversion_is_scoped_to_audio_selections() {
    for audio_only in [true, false] {
        let mut selection = audio_selection();
        selection.audio_only = audio_only;
        let args = yt_dlp_download_args(
            &probe_record(),
            &selection,
            Path::new("/job"),
            Path::new("/tools"),
            Path::new("/tools/deno"),
            None,
        );
        assert_eq!(args.contains(&"--embed-metadata".into()), audio_only);
        assert_eq!(
            args.windows(2).any(|a| a == ["--audio-format", "mp3"]),
            audio_only
        );
        assert_eq!(args[args.len() - 2], "--");
    }
}

#[test]
fn audio_fallback_keeps_tags_and_uses_mp3_in_both_modes() {
    for mode in [ClipMode::Fast, ClipMode::Exact] {
        let args = ffmpeg_clip_args(
            Path::new("source.mp3"),
            Path::new("clip.mp3"),
            &ClipSpec {
                start_ms: 1_000,
                end_ms: 3_000,
                mode,
            },
            true,
        );
        assert!(args.windows(2).any(|a| a == ["-map_metadata", "0"]));
        let expected = if mode == ClipMode::Fast {
            "copy"
        } else {
            "libmp3lame"
        };
        assert!(args.iter().any(|a| a == expected));
        assert!(!args.iter().any(|a| a == "aac" || a == "0:v:0"));
    }
}

fn successful(command: &mut Command) -> std::process::Output {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn tags(tools: &Path, path: &Path) -> Value {
    let output = successful(
        Command::new(tools.join("ffprobe"))
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration:format_tags:stream=codec_name,codec_type",
                "-of",
                "json",
            ])
            .arg(path),
    );
    let media: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(media["streams"][0]["codec_name"], "mp3");
    assert_eq!(media["streams"].as_array().unwrap().len(), 1);
    media
}

#[test]
#[ignore = "Set MEDIA_SNIPER_REAL_TOOLS to the bundled bin directory to exercise real MP3 encoding"]
fn real_mp3_download_metadata_and_fallback_clips() {
    let tools =
        PathBuf::from(std::env::var_os("MEDIA_SNIPER_REAL_TOOLS").expect("real tools required"));
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.wav");
    successful(
        Command::new(tools.join("ffmpeg"))
            .args([
                "-hide_banner",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=4",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&source),
    );
    let embedded = root.path().join("embedded.mp3");
    successful(
        Command::new(tools.join("ffmpeg"))
            .args(["-hide_banner", "-nostdin", "-y", "-i"])
            .arg(&source)
            .args([
                "-c:a",
                "libmp3lame",
                "-q:a",
                "0",
                "-metadata",
                "artist=Embedded artist",
                "-metadata",
                "album=Embedded album",
                "-metadata",
                "date=1984",
            ])
            .arg(&embedded),
    );

    for (name, input, metadata) in [
        (
            "music",
            &source,
            serde_json::json!({"track":"Actual track", "artists":["Artist A", "Artist B"],
            "album":"Actual album", "album_artist":"Album artist", "release_year":1997,
            "release_date":"20010520", "track_number":7, "disc_number":2, "genre":"Jazz"}),
        ),
        ("unknown", &source, serde_json::json!({})),
        (
            "release-date",
            &source,
            serde_json::json!({"release_date":"19950520", "artist":"Solo artist"}),
        ),
        ("embedded", &embedded, serde_json::json!({})),
    ] {
        let job = root.path().join(name);
        fs::create_dir(&job).unwrap();
        let mut info = serde_json::json!({"id":name, "title":"Page title", "extractor":"generic",
            "extractor_key":"Generic", "webpage_url":"https://example.com/music?token=fixture-secret",
            "description":"private fixture description", "uploader":"Not the artist", "upload_date":"20260912",
            "url":url::Url::from_file_path(input).unwrap().as_str(),
            "ext":input.extension().unwrap().to_str().unwrap(), "vcodec":"none", "acodec":"audio"});
        info.as_object_mut()
            .unwrap()
            .extend(metadata.as_object().unwrap().clone());
        let info_file = job.join("fixture.json");
        fs::write(&info_file, serde_json::to_vec(&info).unwrap()).unwrap();
        let mut args = yt_dlp_download_args(
            &probe_record(),
            &audio_selection(),
            &job,
            &tools,
            &tools.join("deno"),
            None,
        );
        args.truncate(args.len() - 2);
        // Test-only local fixture input; the product accepts public page URLs only.
        args.extend([
            "--enable-file-urls".into(),
            "--load-info-json".into(),
            info_file.to_string_lossy().into_owned(),
        ]);
        let output = successful(Command::new(tools.join("yt-dlp")).args(args));
        let path = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .find_map(parse_file_marker)
            .unwrap();
        assert_eq!(path.extension().unwrap(), "mp3");
        let media = tags(&tools, &path);
        let tags = &media["format"]["tags"];
        assert!(tags.get("comment").is_none());
        assert!(tags.get("purl").is_none());
        assert!(tags.get("description").is_none());
        match name {
            "music" => {
                assert_eq!(tags["title"], "Actual track");
                assert_eq!(tags["artist"], "Artist A, Artist B");
                assert_eq!(tags["album"], "Actual album");
                assert_eq!(tags["album_artist"], "Album artist");
                assert_eq!(tags["date"], "1997");
                assert_eq!(tags["track"], "7");
                assert_eq!(tags["disc"], "2");
                assert_eq!(tags["genre"], "Jazz");
                for mode in [ClipMode::Fast, ClipMode::Exact] {
                    let clip_path = job.join(format!("clip-{mode:?}.mp3"));
                    let clip = ClipSpec {
                        start_ms: 1_000,
                        end_ms: 3_000,
                        mode,
                    };
                    successful(
                        Command::new(tools.join("ffmpeg"))
                            .args(ffmpeg_clip_args(&path, &clip_path, &clip, true)),
                    );
                    let clip_media = self::tags(&tools, &clip_path);
                    assert_eq!(clip_media["format"]["tags"]["artist"], "Artist A, Artist B");
                    assert_eq!(clip_media["format"]["tags"]["album"], "Actual album");
                    assert_eq!(clip_media["format"]["tags"]["date"], "1997");
                    let duration = clip_media["format"]["duration"]
                        .as_str()
                        .unwrap()
                        .parse::<f64>()
                        .unwrap();
                    assert!((duration - 2.0).abs() < 0.1);
                }
            }
            "unknown" => {
                for key in ["artist", "album", "date"] {
                    assert!(tags.get(key).is_none(), "{key}");
                }
            }
            "release-date" => {
                assert_eq!(tags["date"], "1995");
                assert_eq!(tags["artist"], "Solo artist");
            }
            "embedded" => {
                assert_eq!(tags["artist"], "Embedded artist");
                assert_eq!(tags["album"], "Embedded album");
                assert_eq!(tags["date"], "1984");
            }
            _ => unreachable!(),
        }
    }
}
