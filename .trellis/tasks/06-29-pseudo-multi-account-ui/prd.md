# Pseudo multi-account UI

## Goal

Build a Tauri desktop UI that offers local "pseudo multi-account" account profiles while continuing to use one user-selected local `ipatool` binary and the single real `ipatool` App Store login state.

The user value is safe, explicit account switching without modifying `ipatool`, storing Apple credentials, or pretending multiple real sessions can coexist.

## Confirmed Facts

- The project is a Tauri v2 + React app.
- The frontend currently has a Stitch-derived static prototype in `src/App.tsx`; this is the user's design source and must be preserved.
- TypeScript types already include `AccountProfile`, `AppConfig`, `AuthState`, `BinaryStatus`, `CommandDiagnostic`, `CommandOutput`, and PTY event shapes.
- The Tauri backend already supports:
  - loading/saving `state.json`
  - storing local account profiles without credential fields
  - selecting/detecting an `ipatool` binary
  - running `ipatool auth info --format json`
  - running `ipatool auth revoke --format json`
  - running search, list-versions, and purchase JSON commands
  - starting PTY sessions for login and download
  - redacting sensitive auth-like output in command diagnostics and PTY output
- Existing UI copy in `src/i18n.ts` already contains strings for account profiles, binary setup, login/switch, command status, mismatch errors, diagnostics, and download fields.

## Requirements

- The app must manage local UI account profiles with:
  - `id`
  - `email`
  - `displayName`
  - `defaultDownloadDir`
  - `notes`
  - `lastUsedAt`
- The app must not persist Apple ID password, 2FA code, password token, cookies, keychain passphrase, or equivalent auth secrets.
- The app must call only the configured local `ipatool` binary. It must not link to Go packages or modify `ipatool` source.
- The implementation must preserve the existing static prototype's visual design, layout, and interaction surface unless the user explicitly approves UI design changes.
- App startup must run `ipatool auth info --format json` when a usable binary is available.
  - Success marks the current real active account by returned email.
  - Failure marks the app as not signed in and exposes a safe error/diagnostic.
- The account list must distinguish:
  - the current active `ipatool` account
  - saved profiles that are not currently logged in
  - unverified profiles
- Adding/editing an account profile must save only local profile fields.
- Selecting an account whose email already matches the current `ipatool` login must switch UI context without revoking or logging in again.
- Selecting an account whose email differs from the current `ipatool` login must warn that switching overwrites the current `ipatool` login state.
- Confirmed account switching must run `ipatool auth revoke`, then run `ipatool auth login --email <email>` through PTY for the target account.
- Login must use PTY interaction for password and 2FA prompts. Password and 2FA input must not be saved to config or command logs.
- After login exits successfully, the app must refresh `auth info` and confirm the active email matches the selected profile.
- If switch login fails after revoke, the app must show a signed-out state and keep all local account profiles.
- Deleting a non-active profile must delete only the local profile.
- Deleting the active profile must ask whether to also run `ipatool auth revoke`.
- Search, purchase, version list, and download workflows must use the currently selected UI account context and must be blocked when the selected profile email does not match the current real `ipatool` login email. This avoids using the wrong regional Apple ID.
- Search, purchase, version list, and download workflows must be blocked before invoking `ipatool` when:
  - no usable binary is configured
  - no current `ipatool` login exists
  - no UI account profile is selected
  - the selected profile email does not match the current active `ipatool` email
- Each account profile's `defaultDownloadDir` must be usable as the download output default.
- The diagnostics view must show:
  - configured `ipatool` path
  - `ipatool --version`
  - current active account email, if any
  - the most recent command exit code
  - recent redacted stdout/stderr or PTY log lines
- Sensitive authentication values must be redacted from diagnostics and PTY output while allowing email to remain visible.

## Acceptance Criteria

- [ ] With a mock `ipatool` where `auth info` fails, app startup shows no active login and does not delete account profiles.
- [ ] A user can create multiple local account profiles with independent `defaultDownloadDir` values.
- [ ] Logging into account A runs `auth login --email <A>` through PTY, accepts password/2FA input through prompt-specific UI, refreshes `auth info`, and marks A active when emails match.
- [ ] Selecting account A while A is already active changes UI context without running revoke/login.
- [ ] Switching from active account A to profile B warns the user, then runs `auth revoke` followed by PTY login for B.
- [ ] If B login fails after revoke, the app shows signed-out state and keeps both A and B profiles.
- [ ] Deleting a non-active profile removes only the local profile.
- [ ] Deleting an active profile lets the user choose whether to revoke the real `ipatool` login.
- [ ] Search, version list, purchase, and download are blocked when selected profile and active `auth info` email do not match.
- [ ] Download uses the selected profile's default download directory when no output path override is provided.
- [ ] The diagnostics view displays binary path, version, active email, latest exit code, and redacted logs.
- [ ] Serialized app config does not contain password, 2FA, password token, cookie, keychain passphrase, or auth code fields/values.
- [ ] Unit tests cover auth info failure, profile persistence, successful login verification, switch revoke+login sequencing, switch-login failure signed-out state, delete semantics, shared command preflight guard, and redaction.
- [ ] Build/type-check passes for the frontend and Rust tests pass for backend logic touched by this task.

## Out of Scope

- True multiple concurrent App Store sessions.
- `ipatool --profile <name>` or changes to `ipatool` account/cookie storage behavior.
- Persisting Apple ID password, 2FA code, auth tokens, cookies, or keychain passphrases.
- Importing or depending on `ipatool` Go packages.
- Cloud sync of profiles.

## Notes

- This task is complex and requires `design.md` and `implement.md` before `task.py start`.
- The first implementation should preserve the pseudo-account framing in the UI: profiles are local convenience records, not independent real sessions.
- Stitch/static prototype UI is a design artifact, not disposable scaffolding. Wire behavior into the existing design instead of replacing it.
