use crate::ipatool::redact_text;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};
use tauri::{AppHandle, Emitter};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("failed to open PTY: {0}")]
    Open(String),
    #[error("failed to spawn command: {0}")]
    Spawn(String),
    #[error("PTY session not found")]
    NotFound,
    #[error("failed to write PTY input: {0}")]
    Input(String),
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    writer: Box<dyn Write + Send>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStart {
    pub session_id: String,
    pub kind: PtyKind,
    pub email: Option<String>,
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyKind {
    Login,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInput {
    pub session_id: String,
    pub data: String,
    pub submit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyEvent {
    session_id: String,
    event: PtyEventKind,
    data: Option<String>,
    prompt: Option<PromptKind>,
    exit_code: Option<i32>,
    duration_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum PtyEventKind {
    Output,
    Prompt,
    Exit,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum PromptKind {
    Password,
    TwoFactor,
}

impl PtyManager {
    pub fn start(
        &self,
        app: AppHandle,
        binary_path: String,
        request: PtyStart,
    ) -> Result<(), PtyError> {
        let args = build_args(&request);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| PtyError::Open(err.to_string()))?;

        let mut command = CommandBuilder::new(binary_path);
        command.args(args);

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| PtyError::Spawn(err.to_string()))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| PtyError::Open(err.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| PtyError::Open(err.to_string()))?;
        let session_id = request.session_id.clone();
        self.sessions
            .lock()
            .expect("pty sessions mutex poisoned")
            .insert(session_id.clone(), PtySession { writer });

        let started = Instant::now();
        let app_for_reader = app.clone();
        let session_for_reader = session_id.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 2048];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let text = redact_text(&String::from_utf8_lossy(&buffer[..size]));
                        emit_output(&app_for_reader, &session_for_reader, &text);
                        if let Some(prompt) = detect_prompt(&text) {
                            let _ = app_for_reader.emit(
                                "ipatool://pty",
                                PtyEvent {
                                    session_id: session_for_reader.clone(),
                                    event: PtyEventKind::Prompt,
                                    data: None,
                                    prompt: Some(prompt),
                                    exit_code: None,
                                    duration_ms: None,
                                },
                            );
                        }
                    }
                    Err(err) => {
                        let _ = app_for_reader.emit(
                            "ipatool://pty",
                            PtyEvent {
                                session_id: session_for_reader.clone(),
                                event: PtyEventKind::Error,
                                data: Some(err.to_string()),
                                prompt: None,
                                exit_code: None,
                                duration_ms: None,
                            },
                        );
                        break;
                    }
                }
            }
        });

        let app_for_wait = app.clone();
        let session_for_wait = session_id.clone();
        let sessions = Arc::new(());
        let _keep = sessions.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
            let exit_code = status.map(|exit| exit.exit_code() as i32);
            let _ = app_for_wait.emit(
                "ipatool://pty",
                PtyEvent {
                    session_id: session_for_wait,
                    event: PtyEventKind::Exit,
                    data: None,
                    prompt: None,
                    exit_code,
                    duration_ms: Some(started.elapsed().as_millis()),
                },
            );
        });

        Ok(())
    }

    pub fn input(&self, input: PtyInput) -> Result<(), PtyError> {
        let mut sessions = self.sessions.lock().expect("pty sessions mutex poisoned");
        let session = sessions
            .get_mut(&input.session_id)
            .ok_or(PtyError::NotFound)?;
        session
            .writer
            .write_all(input.data.as_bytes())
            .map_err(|err| PtyError::Input(err.to_string()))?;
        if input.submit {
            session
                .writer
                .write_all(b"\n")
                .map_err(|err| PtyError::Input(err.to_string()))?;
        }
        session
            .writer
            .flush()
            .map_err(|err| PtyError::Input(err.to_string()))?;
        Ok(())
    }

    pub fn stop(&self, session_id: &str) -> Result<(), PtyError> {
        self.sessions
            .lock()
            .expect("pty sessions mutex poisoned")
            .remove(session_id);
        Ok(())
    }
}

fn build_args(request: &PtyStart) -> Vec<String> {
    match request.kind {
        PtyKind::Login => vec![
            "auth".to_string(),
            "login".to_string(),
            "--email".to_string(),
            request.email.clone().unwrap_or_default(),
        ],
        PtyKind::Download => request.args.clone().unwrap_or_default(),
    }
}

fn detect_prompt(text: &str) -> Option<PromptKind> {
    let lower = text.to_lowercase();
    if lower.contains("enter password")
        || lower.contains("password:")
        || lower.trim_end().ends_with("password")
        || lower.contains("app-specific password")
    {
        Some(PromptKind::Password)
    } else if lower.contains("enter 2fa")
        || lower.contains("2fa")
        || lower.contains("two-factor")
        || lower.contains("verification code")
        || lower.contains("auth code")
        || lower.contains("code:")
    {
        Some(PromptKind::TwoFactor)
    } else {
        None
    }
}

fn emit_output(app: &AppHandle, session_id: &str, text: &str) {
    let _ = app.emit(
        "ipatool://pty",
        PtyEvent {
            session_id: session_id.to_string(),
            event: PtyEventKind::Output,
            data: Some(text.to_string()),
            prompt: None,
            exit_code: None,
            duration_ms: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_login_prompts() {
        assert!(matches!(
            detect_prompt("enter password:"),
            Some(PromptKind::Password)
        ));
        assert!(matches!(
            detect_prompt("Password:"),
            Some(PromptKind::Password)
        ));
        assert!(matches!(
            detect_prompt("enter 2FA code:"),
            Some(PromptKind::TwoFactor)
        ));
        assert!(matches!(
            detect_prompt("Verification code:"),
            Some(PromptKind::TwoFactor)
        ));
    }
}
