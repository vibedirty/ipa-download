use crate::store::{AuthState, BinaryStatus};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{ffi::OsStr, path::PathBuf, process::Command, time::Instant};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IpaToolError {
    #[error("{message}")]
    Command {
        message: String,
        diagnostic: CommandDiagnostic,
    },
    #[error("failed to run ipatool: {0}")]
    Io(#[from] std::io::Error),
    #[error("ipatool returned invalid JSON: {message}")]
    Json {
        message: String,
        diagnostic: CommandDiagnostic,
    },
}

impl IpaToolError {
    pub fn into_diagnostic(self) -> Option<CommandDiagnostic> {
        match self {
            IpaToolError::Command { diagnostic, .. } => Some(diagnostic),
            IpaToolError::Json { diagnostic, .. } => Some(diagnostic),
            IpaToolError::Io(_) => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDiagnostic {
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub json: Value,
    pub diagnostic: CommandDiagnostic,
}

pub fn find_binary_on_path() -> BinaryStatus {
    match which::which("ipatool") {
        Ok(path) => detect_binary_at_path(path.to_string_lossy().as_ref()),
        Err(err) => BinaryStatus {
            ok: false,
            path: None,
            version: None,
            help_ok: false,
            error: Some(format!("ipatool was not found on PATH: {err}")),
        },
    }
}

pub fn detect_binary_at_path(path: &str) -> BinaryStatus {
    let path_buf = PathBuf::from(path);
    if !path_buf.exists() {
        return BinaryStatus {
            ok: false,
            path: Some(path.to_string()),
            version: None,
            help_ok: false,
            error: Some("file does not exist".to_string()),
        };
    }

    let version = run_plain(path, &["--version"]);
    let help = run_plain(path, &["--help"]);
    let help_ok = help
        .as_ref()
        .map(|out| out.status.success())
        .unwrap_or(false);
    let version_text = version.as_ref().ok().map(|out| {
        first_non_empty_line(&String::from_utf8_lossy(&out.stdout)).unwrap_or_else(|| {
            first_non_empty_line(&String::from_utf8_lossy(&out.stderr)).unwrap_or_default()
        })
    });

    BinaryStatus {
        ok: help_ok,
        path: Some(path.to_string()),
        version: version_text,
        help_ok,
        error: if help_ok {
            None
        } else {
            Some(help.err().map(|err| err.to_string()).unwrap_or_else(|| {
                "binary did not return a successful --help response".to_string()
            }))
        },
    }
}

pub fn refresh_auth_info_inner(binary_path: &str) -> Result<AuthState, IpaToolError> {
    let output = run_json_command_inner(binary_path, &["auth", "info", "--format", "json"])?;
    Ok(AuthState {
        signed_in: output
            .json
            .get("success")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        email: output
            .json
            .get("email")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned),
        name: output
            .json
            .get("name")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned),
        country_code: country_code_from_auth_json(&output.json),
        error: None,
        diagnostic: Some(output.diagnostic),
    })
}

pub fn run_json_command_inner(
    binary_path: &str,
    args: &[&str],
) -> Result<CommandOutput, IpaToolError> {
    let start = Instant::now();
    let output = Command::new(binary_path).args(args).output()?;
    let diagnostic = CommandDiagnostic {
        command: std::iter::once(binary_path.to_string())
            .chain(args.iter().map(|arg| redact_arg(arg)))
            .collect(),
        exit_code: output.status.code(),
        stdout: redact_text(&String::from_utf8_lossy(&output.stdout)),
        stderr: redact_text(&String::from_utf8_lossy(&output.stderr)),
        duration_ms: start.elapsed().as_millis(),
    };

    if !output.status.success() {
        return Err(IpaToolError::Command {
            message: command_error_message(&diagnostic),
            diagnostic,
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or(stdout.trim());
    let json = serde_json::from_str(json_line).map_err(|err| IpaToolError::Json {
        message: err.to_string(),
        diagnostic: diagnostic.clone(),
    })?;

    Ok(CommandOutput { json, diagnostic })
}

fn run_plain<I, S>(binary_path: &str, args: I) -> Result<std::process::Output, std::io::Error>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new(binary_path).args(args).output()
}

fn first_non_empty_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn command_error_message(diagnostic: &CommandDiagnostic) -> String {
    let stderr = diagnostic.stderr.trim();
    if !stderr.is_empty() {
        return stderr.lines().next().unwrap_or(stderr).to_string();
    }

    let stdout = diagnostic.stdout.trim();
    if !stdout.is_empty() {
        return stdout.lines().next().unwrap_or(stdout).to_string();
    }

    format!(
        "ipatool exited with status {}",
        diagnostic
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    )
}

fn country_code_from_auth_json(value: &serde_json::Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "countryCode",
        "country_code",
        "country",
        "storefrontCountryCode",
        "storefront_country_code",
        "storeCountryCode",
        "store_country_code",
    ];

    match value {
        serde_json::Value::Object(object) => {
            for key in KEYS {
                if let Some(country) = object.get(*key).and_then(country_code_value) {
                    return Some(country);
                }
            }
            object.values().find_map(country_code_from_auth_json)
        }
        serde_json::Value::Array(items) => items.iter().find_map(country_code_from_auth_json),
        _ => None,
    }
}

fn country_code_value(value: &serde_json::Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.len() == 2 && text.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return Some(text.to_ascii_lowercase());
    }
    None
}

fn redact_arg(arg: &str) -> String {
    if looks_sensitive(arg) {
        "<redacted>".to_string()
    } else {
        arg.to_string()
    }
}

pub fn redact_text(value: &str) -> String {
    let mut output = value.to_string();
    let patterns = [
        r#"(?i)("?(?:password|passwordToken|authCode|token|cookie|dsid|directoryServicesID)"?\s*[:=]\s*)("[^"]+"|[^\s,}]+)"#,
        r#"(?i)(--password\s+)\S+"#,
        r#"(?i)(--auth-code\s+)\S+"#,
    ];

    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            output = regex.replace_all(&output, "${1}<redacted>").to_string();
        }
    }
    output
}

fn looks_sensitive(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    lower.contains("password")
        || lower.contains("auth-code")
        || lower.contains("token")
        || lower.contains("cookie")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_sensitive_json_like_output() {
        let input = r#"{"email":"user@example.com","passwordToken":"secret","X-Dsid":"123"}"#;
        let output = redact_text(input);

        assert!(output.contains("user@example.com"));
        assert!(!output.contains("secret"));
        assert!(!output.contains("123"));
    }

    #[test]
    fn extracts_country_code_from_auth_json_variants() {
        assert_eq!(
            country_code_from_auth_json(&serde_json::json!({ "countryCode": "TR" })),
            Some("tr".to_string())
        );
        assert_eq!(
            country_code_from_auth_json(
                &serde_json::json!({ "account": { "storeCountryCode": "ng" } })
            ),
            Some("ng".to_string())
        );
        assert_eq!(
            country_code_from_auth_json(&serde_json::json!({ "storefront": "143441" })),
            None
        );
    }
}
