mod ipatool;
mod pty;
mod store;

use ipatool::{
    detect_binary_at_path, find_binary_on_path, refresh_auth_info_inner, run_json_command_inner,
    CommandDiagnostic, CommandOutput,
};
use pty::{PtyInput, PtyManager, PtyStart};
use store::{
    delete_account_inner, load_config, save_config, set_binary_path_inner, upsert_account_inner,
    AccountProfile, AppConfig, AppState, AuthState, BinaryStatus,
};
use tauri::AppHandle;

#[tauri::command]
fn load_state(app: AppHandle) -> Result<AppState, String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary = match &config.binary_path {
        Some(path) => detect_binary_at_path(path),
        None => find_binary_on_path(),
    };
    let auth = match binary.path.as_ref() {
        Some(path) if binary.ok => {
            refresh_auth_info_inner(path).unwrap_or_else(AuthState::from_error)
        }
        _ => AuthState::signed_out("ipatool binary is not configured"),
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
fn detect_binary() -> BinaryStatus {
    find_binary_on_path()
}

#[tauri::command]
fn set_binary_path(app: AppHandle, path: String) -> Result<BinaryStatus, String> {
    set_binary_path_inner(&app, path).map_err(|err| err.to_string())
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
fn refresh_auth_info(app: AppHandle) -> Result<AuthState, String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary_path = config
        .binary_path
        .ok_or_else(|| "ipatool binary is not configured".to_string())?;

    Ok(refresh_auth_info_inner(&binary_path).unwrap_or_else(AuthState::from_error))
}

#[tauri::command]
fn revoke_auth(app: AppHandle) -> Result<CommandOutput, String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary_path = config
        .binary_path
        .ok_or_else(|| "ipatool binary is not configured".to_string())?;

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
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary_path = config
        .binary_path
        .ok_or_else(|| "ipatool binary is not configured".to_string())?;
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
fn run_list_versions(
    app: AppHandle,
    app_id: Option<i64>,
    bundle_id: Option<String>,
) -> Result<CommandOutput, String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary_path = config
        .binary_path
        .ok_or_else(|| "ipatool binary is not configured".to_string())?;
    let mut args = vec![
        "list-versions".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(app_id) = app_id.filter(|id| *id > 0) {
        args.push("--app-id".to_string());
        args.push(app_id.to_string());
    }
    if let Some(bundle_id) = bundle_id.filter(|value| !value.trim().is_empty()) {
        args.push("--bundle-identifier".to_string());
        args.push(bundle_id);
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_json_command_inner(&binary_path, &refs).map_err(|err| err.to_string())
}

#[tauri::command]
fn run_purchase(app: AppHandle, bundle_id: String) -> Result<CommandOutput, String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary_path = config
        .binary_path
        .ok_or_else(|| "ipatool binary is not configured".to_string())?;
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
}

#[tauri::command]
fn start_pty(
    app: AppHandle,
    state: tauri::State<PtyManager>,
    request: PtyStart,
) -> Result<(), String> {
    let config = load_config(&app).map_err(|err| err.to_string())?;
    let binary_path = config
        .binary_path
        .ok_or_else(|| "ipatool binary is not configured".to_string())?;
    state
        .start(app, binary_path, request)
        .map_err(|err| err.to_string())
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
            detect_binary,
            set_binary_path,
            upsert_account,
            delete_account,
            refresh_auth_info,
            revoke_auth,
            run_search,
            run_list_versions,
            run_purchase,
            start_pty,
            send_pty_input,
            stop_pty
        ])
        .run(tauri::generate_context!())
        .expect("failed to run IPATool Desk");
}
