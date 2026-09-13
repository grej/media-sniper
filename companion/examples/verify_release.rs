//! Run the production protocol against an explicitly supplied isolated test root.
use media_sniper_companion::{tools::ToolManager, CompanionConfig, Host};
use std::{path::PathBuf, time::Duration};

fn main() {
    let user_root = PathBuf::from(std::env::args_os().nth(1).expect("isolated root required"));
    let app_root = user_root.join("Media Sniper");
    let staged = user_root.join("staged");
    let manifest = std::fs::read(staged.join("manifest.json")).expect("signed manifest required");
    let signature =
        std::fs::read_to_string(staged.join("manifest.sig")).expect("signature required");
    ToolManager::new(app_root.join("tools"), None)
        .activate_verified_bundle(&staged.join("payload"), &manifest, signature.trim())
        .expect("production signature, hash, and health checks must pass");
    let config = CompanionConfig {
        temp_root: app_root.join("jobs"),
        output_root: user_root.join("Downloads"),
        user_home: user_root,
        app_root,
        developer_mode: false,
        developer_tool_dir: None,
        probe_timeout: Duration::from_secs(75),
    };
    if let Err(error) = Host::run_stdio(config) {
        eprintln!("{}", error.safe_message());
        std::process::exit(1);
    }
}
