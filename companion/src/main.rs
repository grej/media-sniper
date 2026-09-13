use media_sniper_companion::{CompanionConfig, Host};

fn main() {
    if let Err(error) = CompanionConfig::discover().and_then(Host::run_stdio) {
        eprintln!("media-sniper-companion: {}", error.safe_message());
        std::process::exit(1);
    }
}
