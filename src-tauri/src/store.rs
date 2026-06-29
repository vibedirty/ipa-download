use crate::ipatool::{detect_binary_at_path, run_json_command_inner, CommandDiagnostic};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
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
    pub binary_path: Option<String>,
    pub selected_account_id: Option<String>,
    pub accounts: Vec<AccountProfile>,
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
    pub error: Option<String>,
    pub diagnostic: Option<CommandDiagnostic>,
}

impl AuthState {
    pub fn signed_out(message: impl Into<String>) -> Self {
        Self {
            signed_in: false,
            email: None,
            name: None,
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
                .map(|email| email.eq_ignore_ascii_case(&account.email))
                .unwrap_or(false);

            if is_active {
                run_json_command_inner(binary_path, &["auth", "revoke", "--format", "json"])
                    .map(|out| out.diagnostic)
                    .err()
                    .and_then(|err| err.into_diagnostic())
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
}
