use crate::protocol::{ErrorCode, HostError};
use std::fs;
use std::net::IpAddr;
use std::path::{Component, Path};
use url::{Host, Url};

pub const MAX_URL_LENGTH: usize = 8192;
pub const MAX_TEXT_LENGTH: usize = 512;

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
        redacted = redact_after_prefix(&redacted, prefix);
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

fn redact_after_prefix(input: &str, prefix: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let prefix_lower = prefix.to_ascii_lowercase();
    let Some(position) = lower.find(&prefix_lower) else {
        return input.to_owned();
    };
    let value_start = position + prefix.len();
    let value_end = input[value_start..]
        .find(['\n', '\r'])
        .map(|offset| value_start + offset)
        .unwrap_or(input.len());
    format!("{}<redacted>{}", &input[..value_start], &input[value_end..])
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
}
