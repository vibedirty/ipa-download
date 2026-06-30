use crate::ipatool::{detect_binary_at_path, run_json_command_inner, CommandDiagnostic};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("failed to resolve app config directory")]
    ConfigDir,
    #[error("failed to create app config directory: {0}")]
    CreateDir(#[from] std::io::Error),
    #[error("failed to serialize config: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to parse config: {0}")]
    Parse(serde_json::Error),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub binary_path: Option<String>,
    #[serde(default)]
    pub selected_account_id: Option<String>,
    #[serde(default)]
    pub download_dir: Option<String>,
    #[serde(default)]
    pub accounts: Vec<AccountProfile>,
    #[serde(default)]
    pub download_history: Vec<DownloadHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub default_download_dir: String,
    pub notes: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadHistoryItem {
    pub id: String,
    pub app_name: String,
    pub bundle_id: String,
    #[serde(default)]
    pub app_icon_url: Option<String>,
    #[serde(default)]
    pub version_name: Option<String>,
    #[serde(default)]
    pub external_version_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub account_email: Option<String>,
    #[serde(default)]
    pub output_path: Option<String>,
    pub downloaded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub config: AppConfig,
    pub binary: BinaryStatus,
    pub auth: AuthState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub ok: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub help_ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub signed_in: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub country_code: Option<String>,
    pub error: Option<String>,
    pub diagnostic: Option<CommandDiagnostic>,
}

impl AuthState {
    pub fn signed_out(message: impl Into<String>) -> Self {
        Self {
            signed_in: false,
            email: None,
            name: None,
            country_code: None,
            error: Some(message.into()),
            diagnostic: None,
        }
    }

    pub fn from_error(err: crate::ipatool::IpaToolError) -> Self {
        let message = err.to_string();
        let diagnostic = err.into_diagnostic();
        Self {
            signed_in: false,
            email: None,
            name: None,
            country_code: None,
            error: Some(message),
            diagnostic,
        }
    }
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, StoreError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| StoreError::ConfigDir)?;
    Ok(dir.join("state.json"))
}

pub fn load_config(app: &AppHandle) -> Result<AppConfig, StoreError> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let data = fs::read_to_string(path)?;
    serde_json::from_str(&data).map_err(StoreError::Parse)
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<(), StoreError> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let data = serde_json::to_string_pretty(config).map_err(StoreError::Serialize)?;
    fs::write(path, data)?;
    Ok(())
}

pub fn set_binary_path_inner(app: &AppHandle, path: String) -> Result<BinaryStatus, StoreError> {
    let status = detect_binary_at_path(&path);
    let mut config = load_config(app)?;
    config.binary_path = Some(path);
    save_config(app, &config)?;
    Ok(status)
}

pub fn set_download_dir_inner(
    app: &AppHandle,
    path: Option<String>,
) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    config.download_dir = clean_optional(path);
    save_config(app, &config)?;
    Ok(config)
}

pub fn upsert_account_inner(
    app: &AppHandle,
    mut profile: AccountProfile,
) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    profile.email = profile.email.trim().to_lowercase();
    if profile.id.trim().is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }

    match config
        .accounts
        .iter()
        .position(|item| item.id == profile.id)
    {
        Some(index) => config.accounts[index] = profile,
        None => config.accounts.push(profile),
    }

    save_config(app, &config)?;
    Ok(config)
}

pub fn set_selected_account_inner(
    app: &AppHandle,
    id: Option<String>,
) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    config.selected_account_id = id.filter(|value| {
        config
            .accounts
            .iter()
            .any(|account| account.id == value.as_str())
    });
    save_config(app, &config)?;
    Ok(config)
}

pub fn mark_account_used_inner(app: &AppHandle, id: String) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    if let Some(account) = config.accounts.iter_mut().find(|item| item.id == id) {
        account.last_used_at = Some(unix_timestamp_string());
        config.selected_account_id = Some(account.id.clone());
    }
    save_config(app, &config)?;
    Ok(config)
}

pub fn record_download_history_inner(
    app: &AppHandle,
    mut item: DownloadHistoryItem,
) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    if item.id.trim().is_empty() {
        item.id = Uuid::new_v4().to_string();
    }
    if item.downloaded_at.trim().is_empty() {
        item.downloaded_at = unix_timestamp_string();
    }
    item.app_name = item.app_name.trim().to_string();
    item.bundle_id = item.bundle_id.trim().to_string();
    item.app_icon_url = clean_optional(item.app_icon_url);
    item.version_name = clean_optional(item.version_name);
    item.external_version_id = clean_optional(item.external_version_id);
    item.account_id = clean_optional(item.account_id);
    item.account_email = clean_optional(item.account_email).map(|email| email.to_lowercase());
    item.output_path = clean_optional(item.output_path);

    config.download_history.retain(|entry| entry.id != item.id);
    config.download_history.insert(0, item);
    config.download_history.truncate(200);
    save_config(app, &config)?;
    Ok(config)
}

pub fn delete_download_history_inner(app: &AppHandle, id: String) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    config.download_history.retain(|entry| entry.id != id);
    save_config(app, &config)?;
    Ok(config)
}

pub fn clear_download_history_inner(app: &AppHandle) -> Result<AppConfig, StoreError> {
    let mut config = load_config(app)?;
    config.download_history.clear();
    save_config(app, &config)?;
    Ok(config)
}

pub fn delete_account_inner(
    app: &AppHandle,
    id: String,
    revoke_if_active: bool,
) -> Result<(AppConfig, Option<CommandDiagnostic>), StoreError> {
    let mut config = load_config(app)?;
    let account = config.accounts.iter().find(|item| item.id == id).cloned();
    let diagnostic = if revoke_if_active {
        if let (Some(account), Some(binary_path)) = (account.as_ref(), config.binary_path.as_ref())
        {
            let output = run_json_command_inner(binary_path, &["auth", "info", "--format", "json"]);
            let is_active = output
                .as_ref()
                .ok()
                .and_then(|out| out.json.get("email").and_then(|value| value.as_str()))
                .map(|email| emails_match(Some(email), &account.email))
                .unwrap_or(false);

            if is_active {
                match run_json_command_inner(binary_path, &["auth", "revoke", "--format", "json"]) {
                    Ok(out) => Some(out.diagnostic),
                    Err(err) => err.into_diagnostic(),
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    config.accounts.retain(|item| item.id != id);
    if config.selected_account_id.as_deref() == Some(id.as_str()) {
        config.selected_account_id = None;
    }
    save_config(app, &config)?;
    Ok((config, diagnostic))
}

pub fn emails_match(active_email: Option<&str>, profile_email: &str) -> bool {
    active_email
        .map(|email| email.trim().eq_ignore_ascii_case(profile_email.trim()))
        .unwrap_or(false)
}

#[cfg(test)]
pub fn selected_profile_matches_auth(config: &AppConfig, auth: &AuthState) -> bool {
    config
        .selected_account_id
        .as_ref()
        .and_then(|id| config.accounts.iter().find(|account| account.id == *id))
        .map(|account| emails_match(auth.email.as_deref(), &account.email))
        .unwrap_or(false)
}

fn unix_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_profile_serialization_does_not_include_secret_fields() {
        let profile = AccountProfile {
            id: "1".to_string(),
            email: "user@example.com".to_string(),
            display_name: "User".to_string(),
            default_download_dir: "/tmp".to_string(),
            notes: "note".to_string(),
            last_used_at: Some("1710000000".to_string()),
        };

        let data = serde_json::to_string(&profile).unwrap();
        assert!(data.contains("user@example.com"));
        assert!(!data.contains("password"));
        assert!(!data.contains("authCode"));
        assert!(!data.contains("token"));
        assert!(!data.contains("cookie"));
    }

    #[test]
    fn emails_match_case_insensitively_and_trim_space() {
        assert!(emails_match(Some(" User@Example.COM "), "user@example.com"));
        assert!(!emails_match(Some("other@example.com"), "user@example.com"));
        assert!(!emails_match(None, "user@example.com"));
    }

    #[test]
    fn selected_profile_matching_uses_auth_email() {
        let config = AppConfig {
            binary_path: None,
            selected_account_id: Some("account-a".to_string()),
            download_dir: None,
            accounts: vec![
                AccountProfile {
                    id: "account-a".to_string(),
                    email: "a@example.com".to_string(),
                    display_name: "A".to_string(),
                    default_download_dir: "/tmp/a".to_string(),
                    notes: String::new(),
                    last_used_at: None,
                },
                AccountProfile {
                    id: "account-b".to_string(),
                    email: "b@example.com".to_string(),
                    display_name: "B".to_string(),
                    default_download_dir: "/tmp/b".to_string(),
                    notes: String::new(),
                    last_used_at: None,
                },
            ],
            download_history: Vec::new(),
        };
        let auth = AuthState {
            signed_in: true,
            email: Some("A@EXAMPLE.COM".to_string()),
            name: None,
            country_code: None,
            error: None,
            diagnostic: None,
        };

        assert!(selected_profile_matches_auth(&config, &auth));
    }
}
