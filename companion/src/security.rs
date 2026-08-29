use crate::protocol::{ErrorCode, HostError};
use std::fs;
use std::io;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Component, Path};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use url::{Host, Url};

pub const MAX_URL_LENGTH: usize = 8192;
pub const MAX_TEXT_LENGTH: usize = 512;
const DNS_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(5);

pub fn create_private_dir(path: &Path) -> Result<(), HostError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn opaque_token(prefix: &str) -> Result<String, HostError> {
    let mut random = [0_u8; 24];
    getrandom::getrandom(&mut random)
        .map_err(|_| HostError::new(ErrorCode::Internal, "Secure random generation failed"))?;
    Ok(format!("{prefix}-{}", hex::encode(random)))
}

pub fn validate_public_page_url(input: &str, developer_mode: bool) -> Result<Url, HostError> {
    if input.is_empty() || input.len() > MAX_URL_LENGTH || input.chars().any(char::is_control) {
        return Err(HostError::new(
            ErrorCode::UrlUnsupported,
            "The page URL is invalid or too long",
        ));
    }
    let url = Url::parse(input)
        .map_err(|_| HostError::new(ErrorCode::UrlUnsupported, "The page URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(HostError::new(
            ErrorCode::UrlUnsupported,
            "Only public HTTP and HTTPS page URLs are supported",
        ));
    }
    if url.host().is_none() {
        return Err(HostError::new(
            ErrorCode::UrlUnsupported,
            "The page URL has no host",
        ));
    }
    if !developer_mode && host_is_non_public(url.host().unwrap()) {
        return Err(HostError::new(
            ErrorCode::UrlUnsupported,
            "Local and private network addresses require developer mode",
        ));
    }
    Ok(url)
}

fn host_is_non_public(host: Host<&str>) -> bool {
    match host {
        Host::Ipv4(address) => ip_is_non_public(IpAddr::V4(address)),
        Host::Ipv6(address) => ip_is_non_public(IpAddr::V6(address)),
        Host::Domain(domain) => {
            let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
            normalized == "localhost"
                || normalized.ends_with(".localhost")
                || normalized.ends_with(".local")
                || normalized.ends_with(".internal")
        }
    }
}

fn ip_is_non_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                || (ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| ip_is_non_public(IpAddr::V4(mapped)))
        }
    }
}

/// Resolve a production page host immediately before native execution and fail
/// closed if DNS yields any address in a non-public range.
pub fn validate_resolved_public_page_url(url: &Url, developer_mode: bool) -> Result<(), HostError> {
    validate_resolved_public_page_url_with(url, developer_mode, |host, port| {
        let host = host.to_owned();
        resolve_with_timeout(
            move || {
                (host.as_str(), port)
                    .to_socket_addrs()
                    .map(|addresses| addresses.map(|address| address.ip()).collect())
            },
            DNS_RESOLUTION_TIMEOUT,
        )
    })
}

fn resolve_with_timeout<F>(resolver: F, timeout: Duration) -> io::Result<Vec<IpAddr>>
where
    F: FnOnce() -> io::Result<Vec<IpAddr>> + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(resolver());
    });
    receiver.recv_timeout(timeout).map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "Page host resolution exceeded the companion deadline",
        )
    })?
}

pub fn validate_resolved_public_page_url_with<F>(
    url: &Url,
    developer_mode: bool,
    resolver: F,
) -> Result<(), HostError>
where
    F: FnOnce(&str, u16) -> std::io::Result<Vec<IpAddr>>,
{
    if developer_mode {
        return Ok(());
    }
    let Some(host) = url.host_str() else {
        return Err(HostError::new(
            ErrorCode::UrlUnsupported,
            "The page URL has no host",
        ));
    };
    if let Ok(address) = host.parse::<IpAddr>() {
        if ip_is_non_public(address) {
            return Err(HostError::new(
                ErrorCode::UrlUnsupported,
                "The page host resolved to a local or private network address",
            ));
        }
        return Ok(());
    }
    let port = url.port_or_known_default().ok_or_else(|| {
        HostError::new(
            ErrorCode::UrlUnsupported,
            "The page URL had no resolvable network port",
        )
    })?;
    let addresses = resolver(host, port).map_err(|_| {
        HostError::new(
            ErrorCode::UrlUnsupported,
            "The page host could not be resolved safely",
        )
    })?;
    if addresses.is_empty() || addresses.into_iter().any(ip_is_non_public) {
        return Err(HostError::new(
            ErrorCode::UrlUnsupported,
            "The page host resolved to a local or private network address",
        ));
    }
    Ok(())
}

pub fn bounded_text(value: Option<&str>, fallback: &str, max: usize) -> String {
    let value = value.unwrap_or(fallback);
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect();
    if cleaned.trim().is_empty() {
        fallback.to_owned()
    } else {
        cleaned.trim().to_owned()
    }
}

pub fn safe_filename_component(value: &str, max: usize) -> String {
    let mut output = String::with_capacity(value.len().min(max));
    let mut previous_separator = false;
    for character in value.chars() {
        if output.chars().count() >= max {
            break;
        }
        let replacement = if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            Some(character)
        } else if character.is_whitespace() || matches!(character, '.' | '(' | ')' | '[' | ']') {
            Some(' ')
        } else {
            None
        };
        if let Some(character) = replacement {
            if character == ' ' {
                if previous_separator || output.is_empty() {
                    continue;
                }
                previous_separator = true;
            } else {
                previous_separator = false;
            }
            output.push(character);
        }
    }
    let output = output.trim().trim_matches('.').trim();
    if output.is_empty() || matches!(output, "." | "..") {
        "media".to_owned()
    } else {
        output.to_owned()
    }
}

pub fn validate_relative_component(value: &str) -> Result<(), HostError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > MAX_TEXT_LENGTH
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.contains(['/', '\\', '\0'])
    {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "A companion-owned identifier was invalid",
        ));
    }
    Ok(())
}

pub fn redact_diagnostic(input: &str) -> String {
    let home = std::env::var("HOME").ok();
    let mut redacted = if let Some(home) = home.filter(|path| !path.is_empty()) {
        input.replace(&home, "<home>")
    } else {
        input.to_owned()
    };

    for prefix in ["Cookie:", "Authorization:", "Set-Cookie:"] {
        redacted = redact_all_after_prefix(redacted, prefix);
    }

    let mut result = String::with_capacity(redacted.len());
    for token in redacted.split_whitespace() {
        let safe = if let Ok(mut url) = Url::parse(token.trim_matches(['\'', '"', '(', ')'])) {
            if matches!(url.scheme(), "http" | "https") {
                url.set_query(None);
                url.set_fragment(None);
                token.replacen(token.trim_matches(['\'', '"', '(', ')']), url.as_str(), 1)
            } else {
                token.to_owned()
            }
        } else {
            token.to_owned()
        };
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(&safe);
    }
    bounded_text(Some(&result), "Operation failed", 1024)
}

fn redact_all_after_prefix(mut input: String, prefix: &str) -> String {
    let prefix_lower = prefix.to_ascii_lowercase();
    let mut search_start = 0;
    loop {
        let lower = input.to_ascii_lowercase();
        let Some(offset) = lower[search_start..].find(&prefix_lower) else {
            return input;
        };
        let value_start = search_start + offset + prefix.len();
        let value_end = input[value_start..]
            .find(['\n', '\r'])
            .map(|offset| value_start + offset)
            .unwrap_or(input.len());
        input.replace_range(value_start..value_end, "<redacted>");
        search_start = value_start + "<redacted>".len();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_public_web_urls() {
        for input in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://127.0.0.1/x",
            "http://10.0.0.1/x",
            "http://[::1]/x",
            "https://user:secret@example.com/x",
        ] {
            assert!(validate_public_page_url(input, false).is_err(), "{input}");
        }
        assert!(validate_public_page_url("https://example.com/watch?v=1", false).is_ok());
        assert!(validate_public_page_url("http://127.0.0.1/test", true).is_ok());
    }

    #[test]
    fn resolved_page_hosts_fail_closed_on_private_or_mixed_dns_answers() {
        let url = Url::parse("https://public-looking.example/watch").unwrap();
        let private = |_host: &str, _port: u16| Ok(vec!["127.0.0.1".parse().unwrap()]);
        assert!(validate_resolved_public_page_url_with(&url, false, private).is_err());

        let mixed = |_host: &str, _port: u16| {
            Ok(vec![
                "93.184.216.34".parse().unwrap(),
                "192.168.1.10".parse().unwrap(),
            ])
        };
        assert!(validate_resolved_public_page_url_with(&url, false, mixed).is_err());

        let public = |_host: &str, _port: u16| Ok(vec!["93.184.216.34".parse().unwrap()]);
        assert!(validate_resolved_public_page_url_with(&url, false, public).is_ok());
        assert!(validate_resolved_public_page_url_with(&url, true, private).is_ok());
    }

    #[test]
    fn host_resolution_has_a_deadline() {
        let started = std::time::Instant::now();
        let result = resolve_with_timeout(
            || {
                thread::sleep(Duration::from_millis(300));
                Ok(vec!["93.184.216.34".parse().unwrap()])
            },
            Duration::from_millis(10),
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn option_looking_urls_still_validate_as_urls() {
        assert!(validate_public_page_url("--exec=bad", false).is_err());
        assert!(validate_public_page_url("https://example.com/--exec=bad", false).is_ok());
    }

    #[test]
    fn filenames_cannot_traverse() {
        assert_eq!(safe_filename_component("../../secret", 80), "secret");
        assert_eq!(safe_filename_component("a/b\\c", 80), "abc");
        assert!(validate_relative_component("../Default").is_err());
        assert!(validate_relative_component("Profile 1").is_ok());
    }

    #[test]
    fn diagnostics_remove_secrets_and_home() {
        let diagnostic = redact_diagnostic(
            "Authorization: Bearer secret\n failed https://site.test/a?token=secret#x",
        );
        assert!(!diagnostic.contains("Bearer secret"));
        assert!(!diagnostic.contains("token=secret"));
    }

    #[test]
    fn diagnostics_redact_every_repeated_sensitive_header() {
        let diagnostic = redact_diagnostic(
            "Cookie: first\nAuthorization: bearer one\nCookie: second\nSet-Cookie: third",
        );
        for secret in ["first", "bearer one", "second", "third"] {
            assert!(!diagnostic.contains(secret));
        }
        assert_eq!(diagnostic.matches("<redacted>").count(), 4);
    }
}
