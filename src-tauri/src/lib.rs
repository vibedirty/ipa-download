mod ipatool;
mod pty;
mod store;

use ipatool::{
    detect_binary_at_path, find_binary_on_path, refresh_auth_info_inner, run_json_command_inner,
    CommandDiagnostic, CommandOutput, IpaToolError,
};
use pty::{PtyInput, PtyManager, PtyStart};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, process::Command};
use store::{
    clear_download_history_inner, delete_account_inner, delete_download_history_inner, load_config,
    mark_account_used_inner, record_download_history_inner, save_config, set_binary_path_inner,
    set_download_dir_inner, set_selected_account_inner, upsert_account_inner, AccountProfile,
    AppConfig, AppState, AuthState, BinaryStatus, DownloadHistoryItem,
};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionMetadataOutput {
    version_name: Option<String>,
    diagnostic: CommandDiagnostic,
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<AppState, String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary = match &config.binary_path {
        Some(path) => detect_binary_at_path(path),
        None => find_binary_on_path(),
    };
    let auth = if binary.ok {
        binary
            .path
            .as_deref()
            .map(|path| refresh_auth_info_inner(path).unwrap_or_else(AuthState::from_error))
            .unwrap_or_else(|| AuthState::signed_out("ipatool binary is not configured"))
    } else {
        AuthState::signed_out("ipatool binary is not configured")
    };

    Ok(AppState {
        config,
        binary,
        auth,
    })
}

#[tauri::command]
fn pick_binary_file() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Choose ipatool binary")
        .pick_file()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn pick_download_dir() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Choose IPA download directory")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn detect_binary() -> BinaryStatus {
    find_binary_on_path()
}

#[tauri::command]
fn set_binary_path(app: AppHandle, path: String) -> Result<BinaryStatus, String> {
    set_binary_path_inner(&app, path).map_err(|err| err.to_string())
}

#[tauri::command]
fn set_download_dir(app: AppHandle, path: Option<String>) -> Result<AppConfig, String> {
    set_download_dir_inner(&app, path).map_err(|err| err.to_string())
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("download directory is not configured".to_string());
    }
    let metadata = std::fs::metadata(path).map_err(|err| format!("directory not found: {err}"))?;
    if !metadata.is_dir() {
        return Err("configured download path is not a directory".to_string());
    }
    Command::new("open")
        .arg(path)
        .status()
        .map_err(|err| format!("failed to open directory: {err}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "open command failed with status {}",
                    status
                        .code()
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                ))
            }
        })
}

#[tauri::command]
fn upsert_account(app: AppHandle, profile: AccountProfile) -> Result<AppConfig, String> {
    upsert_account_inner(&app, profile).map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_account(
    app: AppHandle,
    id: String,
    revoke_if_active: bool,
) -> Result<(AppConfig, Option<CommandDiagnostic>), String> {
    delete_account_inner(&app, id, revoke_if_active).map_err(|err| err.to_string())
}

#[tauri::command]
fn set_selected_account(app: AppHandle, id: Option<String>) -> Result<AppConfig, String> {
    set_selected_account_inner(&app, id).map_err(|err| err.to_string())
}

#[tauri::command]
fn mark_account_used(app: AppHandle, id: String) -> Result<AppConfig, String> {
    mark_account_used_inner(&app, id).map_err(|err| err.to_string())
}

#[tauri::command]
fn record_download_history(app: AppHandle, item: DownloadHistoryItem) -> Result<AppConfig, String> {
    record_download_history_inner(&app, item).map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_download_history(app: AppHandle, id: String) -> Result<AppConfig, String> {
    delete_download_history_inner(&app, id).map_err(|err| err.to_string())
}

#[tauri::command]
fn clear_download_history(app: AppHandle) -> Result<AppConfig, String> {
    clear_download_history_inner(&app).map_err(|err| err.to_string())
}

#[tauri::command]
fn refresh_auth_info(app: AppHandle) -> Result<AuthState, String> {
    let binary_path = resolve_binary_path(&app)?;

    Ok(refresh_auth_info_inner(&binary_path).unwrap_or_else(AuthState::from_error))
}

#[tauri::command]
fn revoke_auth(app: AppHandle) -> Result<CommandOutput, String> {
    let binary_path = resolve_binary_path(&app)?;

    run_json_command_inner(&binary_path, &["auth", "revoke", "--format", "json"])
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn run_search(
    app: AppHandle,
    term: String,
    platform: Option<String>,
    limit: u32,
) -> Result<CommandOutput, String> {
    let binary_path = resolve_binary_path(&app)?;
    let mut args = vec![
        "search".to_string(),
        term,
        "--format".to_string(),
        "json".to_string(),
        "--limit".to_string(),
        limit.to_string(),
    ];
    if let Some(platform) = platform.filter(|value| !value.trim().is_empty()) {
        args.push("--platform".to_string());
        args.push(platform);
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_json_command_inner(&binary_path, &refs).map_err(|err| err.to_string())
}

#[tauri::command]
fn lookup_apps(ids: Vec<i64>, countries: Option<Vec<String>>) -> Result<Value, String> {
    let ids = ids.into_iter().filter(|id| *id > 0).collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(serde_json::json!({ "resultCount": 0, "results": [] }));
    }

    let mut rows = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut last_error = None;

    for country in lookup_country_order(countries.unwrap_or_default()) {
        let remaining_ids = ids
            .iter()
            .filter(|id| !seen_ids.contains(*id))
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if remaining_ids.is_empty() {
            break;
        }

        match fetch_apple_lookup(&remaining_ids, &country) {
            Ok(payload) => {
                if let Some(results) = payload.get("results").and_then(Value::as_array) {
                    for row in results {
                        if let Some(id) = lookup_track_id(row) {
                            if !seen_ids.insert(id) {
                                continue;
                            }
                        }
                        rows.push(row.clone());
                    }
                }
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    if rows.is_empty() {
        if let Some(err) = last_error {
            return Err(err);
        }
    }

    Ok(serde_json::json!({
        "resultCount": rows.len(),
        "results": rows
    }))
}

fn lookup_country_order(hints: Vec<String>) -> Vec<String> {
    const FALLBACK_COUNTRIES: &[&str] = &[
        "cn", "us", "tr", "ng", "jp", "kr", "hk", "tw", "gb", "ca", "au", "de", "fr", "it", "es",
        "nl", "se", "no", "dk", "fi", "pl", "br", "mx", "in", "id", "th", "vn", "ph", "my", "sg",
        "ae", "sa", "eg", "za", "ar", "cl", "co", "pe", "nz", "at", "be", "ch", "cz", "gr", "hu",
        "ie", "il", "pt", "ro", "ru", "sk", "ua", "bg", "hr", "cy", "ee", "lt", "lu", "lv", "mt",
        "si", "is", "al", "am", "az", "bh", "by", "jo", "kz", "kw", "lb", "md", "mk", "om", "pk",
        "qa", "tj", "tm", "uz", "ye", "ag", "ai", "bb", "bm", "bs", "bz", "cr", "dm", "do", "gd",
        "gt", "hn", "jm", "kn", "ky", "lc", "ms", "ni", "pa", "sv", "tc", "tt", "vc", "vg", "bo",
        "ec", "gy", "py", "sr", "uy", "ve", "ao", "bf", "bj", "bw", "cg", "ci", "cm", "cv", "dz",
        "fj", "fm", "ga", "gh", "gm", "gw", "ke", "lr", "mg", "ml", "mn", "mr", "mu", "mw", "mz",
        "na", "ne", "np", "nr", "pg", "pw", "sb", "sc", "sl", "sn", "st", "sz", "td", "tn", "tz",
        "ug", "zw", "bt", "bn", "kh", "kg", "la", "lk", "mo",
    ];
    let mut countries = Vec::new();
    let mut seen = HashSet::new();

    for country in hints
        .into_iter()
        .filter_map(|country| normalize_country_code(&country))
        .chain(FALLBACK_COUNTRIES.iter().map(|country| country.to_string()))
    {
        if seen.insert(country.clone()) {
            countries.push(country);
        }
    }

    countries
}

fn normalize_country_code(value: &str) -> Option<String> {
    let country = value.trim().to_ascii_lowercase();
    if country.len() == 2 && country.chars().all(|ch| ch.is_ascii_alphabetic()) {
        Some(country)
    } else {
        None
    }
}

fn fetch_apple_lookup(ids: &[String], country: &str) -> Result<Value, String> {
    let url = apple_lookup_url(ids, country);
    let output = Command::new("/usr/bin/curl")
        .args(["-fsSL", "--max-time", "8", url.as_str()])
        .output()
        .map_err(|err| format!("failed to run curl for Apple lookup: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Apple lookup failed with status {}: {}",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }
    serde_json::from_slice::<Value>(&output.stdout).map_err(|err| err.to_string())
}

fn apple_lookup_url(ids: &[String], country: &str) -> String {
    format!(
        "https://itunes.apple.com/lookup?id={}&country={}&entity=software",
        ids.join(","),
        country
    )
}

fn lookup_track_id(value: &Value) -> Option<i64> {
    for key in ["trackId", "trackID", "id"] {
        match value.get(key) {
            Some(Value::Number(number)) => {
                if let Some(id) = number.as_i64().filter(|id| *id > 0) {
                    return Some(id);
                }
            }
            Some(Value::String(text)) => {
                if let Ok(id) = text.trim().parse::<i64>() {
                    if id > 0 {
                        return Some(id);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_lookup_url_uses_requested_storefront_country() {
        let ids = vec!["123".to_string(), "456".to_string()];

        assert_eq!(
            apple_lookup_url(&ids, "us"),
            "https://itunes.apple.com/lookup?id=123,456&country=us&entity=software"
        );
    }

    #[test]
    fn lookup_track_id_accepts_numeric_and_string_ids() {
        assert_eq!(
            lookup_track_id(&serde_json::json!({ "trackId": 123 })),
            Some(123)
        );
        assert_eq!(
            lookup_track_id(&serde_json::json!({ "id": "456" })),
            Some(456)
        );
        assert_eq!(
            lookup_track_id(&serde_json::json!({ "id": "invalid" })),
            None
        );
    }

    #[test]
    fn lookup_country_order_prioritizes_hints_and_filters_invalid_values() {
        let countries = lookup_country_order(vec![
            "TR".to_string(),
            "143441".to_string(),
            "ng".to_string(),
            "tr".to_string(),
        ]);

        assert_eq!(countries[0], "tr");
        assert_eq!(countries[1], "ng");
        assert!(countries.contains(&"cn".to_string()));
        assert!(countries.contains(&"us".to_string()));
        assert!(!countries.contains(&"143441".to_string()));
    }
}

#[tauri::command]
fn run_list_versions(
    app: AppHandle,
    app_id: Option<i64>,
    bundle_id: Option<String>,
) -> Result<CommandOutput, String> {
    let binary_path = resolve_binary_path(&app)?;
    let bundle_id = bundle_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let has_app_id = app_id.filter(|id| *id > 0);
    if let Some(app_id) = has_app_id {
        let args = list_versions_args(Some(app_id), None);
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        match run_json_command_inner(&binary_path, &refs) {
            Ok(output) => return Ok(output),
            Err(err) if bundle_id.is_some() && should_retry_versions_with_bundle_id(&err) => {
                let args = list_versions_args(None, bundle_id.as_deref());
                let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
                return run_json_command_inner(&binary_path, &refs).map_err(|err| err.to_string());
            }
            Err(err) => return Err(err.to_string()),
        }
    }

    let args = list_versions_args(None, bundle_id.as_deref());
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_json_command_inner(&binary_path, &refs).map_err(|err| err.to_string())
}

#[tauri::command]
async fn run_get_version_metadata(
    app: AppHandle,
    bundle_id: String,
    external_version_id: String,
) -> Result<VersionMetadataOutput, String> {
    let binary_path = resolve_binary_path(&app)?;
    let bundle_id = bundle_id.trim().to_string();
    let external_version_id = external_version_id.trim().to_string();
    if bundle_id.is_empty() {
        return Err("bundle id is required".to_string());
    }
    if external_version_id.is_empty() {
        return Err("external version id is required".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let output = run_json_command_inner(
            &binary_path,
            &[
                "get-version-metadata",
                "--format",
                "json",
                "-b",
                bundle_id.as_str(),
                "--external-version-id",
                external_version_id.as_str(),
            ],
        )
        .map_err(|err| err.to_string())?;

        Ok(VersionMetadataOutput {
            version_name: metadata_version_name(&output.json),
            diagnostic: compact_diagnostic(output.diagnostic),
        })
    })
    .await
    .map_err(|err| format!("version metadata task failed: {err}"))?
}

fn list_versions_args(app_id: Option<i64>, bundle_id: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "list-versions".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(app_id) = app_id.filter(|id| *id > 0) {
        args.push("--app-id".to_string());
        args.push(app_id.to_string());
    } else if let Some(bundle_id) = bundle_id.filter(|value| !value.trim().is_empty()) {
        args.push("--bundle-identifier".to_string());
        args.push(bundle_id.trim().to_string());
    }
    args
}

fn should_retry_versions_with_bundle_id(err: &IpaToolError) -> bool {
    match err {
        IpaToolError::Command {
            message,
            diagnostic,
        } => {
            let haystack = format!("{}\n{}\n{}", message, diagnostic.stdout, diagnostic.stderr);
            haystack.to_lowercase().contains("invalid response")
        }
        _ => false,
    }
}

fn metadata_version_name(json: &Value) -> Option<String> {
    const PATHS: &[&str] = &[
        "versionName",
        "version_name",
        "versionString",
        "version",
        "displayVersion",
        "shortVersionString",
        "bundleShortVersionString",
        "bundleVersion",
        "releaseVersion",
        "metadata.versionName",
        "metadata.version",
        "data.versionName",
        "data.version",
        "result.versionName",
        "result.version",
    ];
    for path in PATHS {
        if let Some(value) = scalar_at_path(json, path) {
            return Some(value);
        }
    }

    const KEYS: &[&str] = &[
        "versionName",
        "version_name",
        "versionString",
        "displayVersion",
        "shortVersionString",
        "bundleShortVersionString",
        "bundleVersion",
        "releaseVersion",
    ];
    find_scalar_by_key(json, KEYS)
}

fn scalar_at_path(json: &Value, path: &str) -> Option<String> {
    let mut current = json;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    scalar_value(current)
}

fn find_scalar_by_key(json: &Value, keys: &[&str]) -> Option<String> {
    match json {
        Value::Object(object) => {
            for key in keys {
                if let Some(value) = object.get(*key).and_then(scalar_value) {
                    return Some(value);
                }
            }
            object
                .values()
                .find_map(|value| find_scalar_by_key(value, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|value| find_scalar_by_key(value, keys)),
        _ => None,
    }
}

fn scalar_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn compact_diagnostic(mut diagnostic: CommandDiagnostic) -> CommandDiagnostic {
    diagnostic.stdout = tail_chars(&diagnostic.stdout, 4000);
    diagnostic.stderr = tail_chars(&diagnostic.stderr, 4000);
    diagnostic
}

fn tail_chars(value: &str, limit: usize) -> String {
    let length = value.chars().count();
    if length <= limit {
        return value.to_string();
    }
    let start = length - limit;
    format!("...{}", value.chars().skip(start).collect::<String>())
}

#[tauri::command]
async fn run_purchase(app: AppHandle, bundle_id: String) -> Result<CommandOutput, String> {
    let binary_path = resolve_binary_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_json_command_inner(
            &binary_path,
            &[
                "purchase",
                "--format",
                "json",
                "--bundle-identifier",
                bundle_id.as_str(),
            ],
        )
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| format!("purchase task failed: {err}"))?
}

#[tauri::command]
fn start_pty(
    app: AppHandle,
    state: tauri::State<PtyManager>,
    request: PtyStart,
) -> Result<(), String> {
    let binary_path = resolve_binary_path(&app)?;
    state
        .start(app, binary_path, request)
        .map_err(|err| err.to_string())
}

fn resolve_binary_path(app: &AppHandle) -> Result<String, String> {
    let config = load_config(app).map_err(|err| err.to_string())?;
    if let Some(path) = config.binary_path.filter(|path| !path.trim().is_empty()) {
        return Ok(path);
    }

    let status = find_binary_on_path();
    if status.ok {
        if let Some(path) = status.path.filter(|path| !path.trim().is_empty()) {
            return Ok(path);
        }
    }

    Err(status
        .error
        .unwrap_or_else(|| "ipatool binary is not configured".to_string()))
}

#[tauri::command]
fn send_pty_input(state: tauri::State<PtyManager>, input: PtyInput) -> Result<(), String> {
    state.input(input).map_err(|err| err.to_string())
}

#[tauri::command]
fn stop_pty(state: tauri::State<PtyManager>, session_id: String) -> Result<(), String> {
    state.stop(&session_id).map_err(|err| err.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(PtyManager::default())
        .setup(|app| {
            let config = load_config(app.handle())?;
            save_config(app.handle(), &config)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            pick_binary_file,
            pick_download_dir,
            detect_binary,
            set_binary_path,
            set_download_dir,
            open_directory,
            upsert_account,
            delete_account,
            set_selected_account,
            mark_account_used,
            record_download_history,
            delete_download_history,
            clear_download_history,
            refresh_auth_info,
            revoke_auth,
            run_search,
            lookup_apps,
            run_list_versions,
            run_get_version_metadata,
            run_purchase,
            start_pty,
            send_pty_input,
            stop_pty
        ])
        .run(tauri::generate_context!())
        .expect("failed to run IPATool Desk");
}
