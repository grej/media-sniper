use crate::protocol::{AuthRequest, CookieRecord, ErrorCode, HostError};
use crate::security::{bounded_text, validate_public_page_url, validate_relative_component};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub struct PreparedAuth {
    pub args: Vec<String>,
    _cookie_jar: Option<CookieJar>,
}

pub fn redact_auth_diagnostic(auth: &AuthRequest, diagnostic: &str) -> String {
    let mut redacted = diagnostic.to_owned();
    if let AuthRequest::CurrentTab {
        cookies,
        user_agent,
        ..
    } = auth
    {
        for secret in cookies
            .iter()
            .flat_map(|cookie| [&cookie.name, &cookie.value])
            .chain(std::iter::once(user_agent))
            .filter(|secret| !secret.is_empty())
        {
            redacted = redacted.replace(secret, "<redacted>");
        }
    }
    crate::security::redact_diagnostic(&redacted)
}

impl PreparedAuth {
    pub fn prepare(
        auth: &AuthRequest,
        job_dir: &Path,
        brave_profiles: &[String],
        developer_mode: bool,
    ) -> Result<Self, HostError> {
        match auth {
            AuthRequest::Anonymous => Ok(Self {
                args: Vec::new(),
                _cookie_jar: None,
            }),
            AuthRequest::CurrentTab {
                page_url,
                cookie_store_id,
                incognito: _,
                cookies,
                user_agent,
                referer,
            } => {
                validate_public_page_url(page_url, developer_mode)?;
                if cookie_store_id.is_empty() || cookie_store_id.len() > 128 {
                    return Err(HostError::new(
                        ErrorCode::InvalidRequest,
                        "The current-tab cookie store identity was invalid",
                    ));
                }
                if cookies.len() > 2048 {
                    return Err(HostError::new(
                        ErrorCode::AuthScopeInsufficient,
                        "The current page exposed too many scoped cookies",
                    ));
                }
                let jar = CookieJar::create(job_dir.join("browser-session.cookies"), cookies)?;
                let mut args = vec![
                    "--cookies".to_owned(),
                    jar.path().to_string_lossy().into_owned(),
                ];
                let user_agent = bounded_text(Some(user_agent), "", 1024);
                if !user_agent.is_empty() {
                    args.extend(["--user-agent".to_owned(), user_agent]);
                }
                let referer = validate_public_page_url(referer, developer_mode)?;
                args.extend(["--referer".to_owned(), referer.to_string()]);
                Ok(Self {
                    args,
                    _cookie_jar: Some(jar),
                })
            }
            AuthRequest::BraveProfile { profile_id } => {
                validate_relative_component(profile_id)?;
                if !brave_profiles.iter().any(|known| known == profile_id) {
                    return Err(HostError::new(
                        ErrorCode::InvalidRequest,
                        "The selected Brave profile is not available",
                    ));
                }
                Ok(Self {
                    args: vec![
                        "--cookies-from-browser".to_owned(),
                        format!("brave:{profile_id}"),
                    ],
                    _cookie_jar: None,
                })
            }
        }
    }
}

struct CookieJar {
    path: PathBuf,
}

impl CookieJar {
    fn create(path: PathBuf, cookies: &[CookieRecord]) -> Result<Self, HostError> {
        let file = create_private_file(&path)?;
        let mut writer = BufWriter::new(file);
        writeln!(writer, "# Netscape HTTP Cookie File")?;
        writeln!(writer, "# Generated ephemerally by Media Sniper")?;
        for cookie in cookies {
            validate_cookie(cookie)?;
            let domain = if cookie.http_only {
                format!("#HttpOnly_{}", cookie.domain)
            } else {
                cookie.domain.clone()
            };
            let include_subdomains = if cookie.host_only { "FALSE" } else { "TRUE" };
            let secure = if cookie.secure { "TRUE" } else { "FALSE" };
            let expires = cookie
                .expiration_date
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.trunc() as u64)
                .unwrap_or(0);
            writeln!(
                writer,
                "{domain}\t{include_subdomains}\t{}\t{secure}\t{expires}\t{}\t{}",
                cookie.path, cookie.name, cookie.value
            )?;
        }
        writer.flush()?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CookieJar {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn validate_cookie(cookie: &CookieRecord) -> Result<(), HostError> {
    let invalid = cookie.name.is_empty()
        || cookie.name.len() > 256
        || cookie.value.len() > 8192
        || cookie.domain.is_empty()
        || cookie.domain.len() > 255
        || cookie.path.is_empty()
        || cookie.path.len() > 2048
        || cookie
            .name
            .chars()
            .chain(cookie.value.chars())
            .chain(cookie.domain.chars())
            .chain(cookie.path.chars())
            .any(|character| matches!(character, '\t' | '\r' | '\n' | '\0'));
    if invalid {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "A scoped cookie could not be represented safely",
        ));
    }
    if !cookie.path.starts_with('/')
        || cookie.domain.contains('/')
        || cookie.domain.contains(' ')
        || cookie.domain.starts_with('-')
    {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "A scoped cookie had invalid domain or path metadata",
        ));
    }
    Ok(())
}

fn create_private_file(path: &Path) -> Result<File, HostError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn cookie() -> CookieRecord {
        CookieRecord {
            name: "session".into(),
            value: "secret".into(),
            domain: ".example.com".into(),
            path: "/".into(),
            secure: true,
            http_only: true,
            same_site: crate::protocol::CookieSameSite::Lax,
            host_only: false,
            expiration_date: None,
            session: true,
        }
    }

    #[test]
    fn jar_is_private_and_deleted_on_drop() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cookies.txt");
        {
            let jar = CookieJar::create(path.clone(), &[cookie()]).unwrap();
            assert!(jar.path().exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        assert!(!path.exists());
    }

    #[test]
    fn current_tab_context_is_passed_as_typed_arguments() {
        let directory = tempdir().unwrap();
        let auth = AuthRequest::CurrentTab {
            page_url: "https://example.com/watch".into(),
            referer: "https://example.com/watch".into(),
            user_agent: "Brave test".into(),
            cookie_store_id: "0".into(),
            incognito: false,
            cookies: vec![cookie()],
        };
        let prepared = PreparedAuth::prepare(&auth, directory.path(), &[], false).unwrap();
        assert!(prepared
            .args
            .windows(2)
            .any(|pair| pair == ["--user-agent", "Brave test"]));
    }

    #[test]
    fn rejects_cookie_line_injection() {
        let directory = tempdir().unwrap();
        let mut malicious = cookie();
        malicious.value = "secret\n.example.com\tTRUE".into();
        assert!(CookieJar::create(directory.path().join("jar"), &[malicious]).is_err());
    }

    #[test]
    fn authentication_diagnostics_remove_cookie_names_and_values() {
        let auth = AuthRequest::CurrentTab {
            page_url: "https://example.com/watch".into(),
            referer: "https://example.com/watch".into(),
            user_agent: "Distinct Browser Agent".into(),
            cookie_store_id: "0".into(),
            incognito: false,
            cookies: vec![cookie()],
        };
        let safe = redact_auth_diagnostic(
            &auth,
            "failed with session=secret using Distinct Browser Agent",
        );
        assert!(!safe.contains("session"));
        assert!(!safe.contains("secret"));
        assert!(!safe.contains("Distinct Browser Agent"));
    }

    #[test]
    fn auth_secrets_are_removed_before_diagnostic_truncation() {
        let secret = "S".repeat(200);
        let auth = AuthRequest::CurrentTab {
            page_url: "https://example.com/watch".into(),
            referer: "https://example.com/watch".into(),
            user_agent: "Boundary Browser Agent".into(),
            cookie_store_id: "0".into(),
            incognito: false,
            cookies: vec![CookieRecord {
                value: secret.clone(),
                ..cookie()
            }],
        };
        let diagnostic = format!("{}{} tail", "x".repeat(950), secret);
        let safe = redact_auth_diagnostic(&auth, &diagnostic);
        assert!(!safe.contains("SSSS"));
        assert!(safe.len() <= 1024);
    }
}
