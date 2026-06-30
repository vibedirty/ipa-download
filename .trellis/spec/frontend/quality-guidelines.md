# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

---

## Scenario: Tauri Commands That Depend On Selected Apple ID

### 1. Scope / Trigger

- Trigger: frontend code invokes `ipatool` through Tauri commands while the UI supports multiple local account profiles.
- This is a cross-layer contract: UI profile state -> `src/api.ts` command wrapper -> Tauri command -> local `ipatool` process.
- Apple IDs can be region-scoped, so every business command must run under the selected profile's real active login.

### 2. Signatures

Frontend API wrappers live in `src/api.ts` and should be the only place that calls `invoke(...)` directly:

```ts
setSelectedAccount(id: string | null): Promise<AppConfig>
markAccountUsed(id: string): Promise<AppConfig>
runSearch(term: string, platform: string, limit: number): Promise<CommandOutput>
runListVersions(appId?: number, bundleId?: string): Promise<CommandOutput>
runPurchase(bundleId: string): Promise<CommandOutput>
startPty(request: {
  sessionId: string;
  kind: "login" | "download";
  email?: string | null;
  args?: string[] | null;
}): Promise<void>
```

Backend commands are declared in `src-tauri/src/lib.rs`:

```rust
fn set_selected_account(app: AppHandle, id: Option<String>) -> Result<AppConfig, String>
fn mark_account_used(app: AppHandle, id: String) -> Result<AppConfig, String>
```

### 3. Contracts

- `AppConfig.selectedAccountId` is the UI-selected local profile, not proof of real App Store login.
- `AuthState.email` from `ipatool auth info --format json` is the source of truth for the real active account.
- A profile matches the real login only when `AuthState.signedIn == true` and `AuthState.email` equals profile `email` case-insensitively after trimming.
- Password and 2FA values may live only in component state long enough to submit PTY input. They must not be added to `AppConfig`, `CommandDiagnostic`, URL state, or logs.
- `lastUsedAt` may be updated only after a profile has matched refreshed `auth info`.

### 4. Validation & Error Matrix

- No usable binary -> block with `configureBinaryFirst`; do not invoke business commands.
- No selected profile -> block with `selectProfileFirst`.
- Not signed in -> block with `signInBeforeCommands`.
- Selected profile email differs from `AuthState.email` -> block with `selectedMismatch`.
- Active account switch requested -> warn with `switchConfirm`, then run revoke before PTY login.
- PTY login exits non-zero -> show signed-out state and keep local profiles.
- PTY login exits zero but refreshed `auth info` does not match target email -> show `selectedMismatch`.

### 5. Good/Base/Bad Cases

- Good: search, list versions, purchase, and download all call one shared selected-account preflight before invoking `ipatool`.
- Base: selecting a profile whose email already matches `auth info` only updates UI context / `lastUsedAt`; it does not revoke or login again.
- Bad: allowing search or purchase without matching selected profile and `auth info` email can use the wrong regional Apple ID.

### 6. Tests Required

- Unit-test case-insensitive email matching.
- Unit-test account profile serialization excludes password, 2FA, token, cookie, and auth-code fields.
- Build/type-check frontend after adding command wrappers or changing payload shape.
- Run Rust tests after changing store, command, redaction, or PTY logic.
- Manual/mock smoke test should cover auth-info failure, revoke + login switch, login failure after revoke, and selected/active mismatch blocking for all business commands.

### 7. Wrong vs Correct

#### Wrong

```ts
await api.runSearch(term, platform, limit);
```

This bypasses selected-account validation and can run under whichever Apple ID `ipatool` currently has.

#### Correct

```ts
const blocked = commandPreflight();
if (blocked) {
  setNotice(blocked);
  return;
}
await api.runSearch(term, platform, limit);
```

The command is invoked only after binary, selected profile, signed-in state, and selected email match have all been verified.

## Scenario: Startup Auth Profile Sync

### 1. Scope / Trigger

- Trigger: `load_state` or `refresh_auth_info` returns a signed-in `AuthState.email` while the local account profile list may not contain that email yet.
- This is a cross-layer contract: backend auth discovery -> frontend profile persistence -> selected-account command preflight.

### 2. Signatures

Frontend synchronization should happen after reading `AuthState`:

```ts
syncAuthProfile(nextAuth: AuthState, sourceConfig: AppConfig): Promise<void>
```

It may call existing wrappers only:

```ts
upsertAccount(profile: AccountProfile): Promise<AppConfig>
markAccountUsed(id: string): Promise<AppConfig>
```

### 3. Contracts

- `load_state` must run `ipatool auth info --format json` when a usable binary path exists.
- If `AuthState.signedIn` is true and `email` is present, the UI must ensure the email appears in `AppConfig.accounts`.
- Auto-created profiles must persist only local metadata: `id`, normalized `email`, `displayName`, `defaultDownloadDir`, `notes`, and `lastUsedAt`.
- Auto-created profiles must not persist passwords, 2FA codes, tokens, cookies, password tokens, keychain passphrases, or auth codes.
- After syncing, the matching profile should be selected and marked used so command preflight sees the same account that the top bar displays.
- Account login forms should use app-level validation (`noValidate`) and render progress/errors inside the modal, not only in the top bar.
- Account switch confirmation must be an in-app modal state, not `window.confirm`, because native confirm behavior can be unavailable or return cancellation in Tauri contexts.
- PTY login failure should display a safe summary from redacted `ipatool` output with the exit code. Filter prompt lines, password/2FA labels, redacted token lines, and short numeric code-like echoes before showing the summary.

### 4. Validation & Error Matrix

- Usable binary + auth info success + matching profile exists -> mark that profile used and selected.
- Usable binary + auth info success + no matching profile -> create a local profile, then mark it used and selected.
- Auth info failure -> leave profiles unchanged and show signed-out state with diagnostic.
- PTY login start failure -> clear pending login state so the modal does not remain stuck waiting for a prompt.
- Invalid/missing email, missing binary, save failure, switch cancellation, revoke/login start progress -> show a visible modal status message.
- PTY login non-zero exit -> keep local profiles, mark auth signed out, and show `登录失败（退出码 N）：<safe ipatool detail>` when a safe detail is available.

### 5. Good/Base/Bad Cases

- Good: startup shows the active email in both the top bar and account list without user re-entry.
- Base: refresh after an external `ipatool` login creates/selects the matching local profile.
- Bad: top bar shows a signed-in email while the account list has no selected/matching profile; later commands are blocked or appear unresponsive.
- Bad: native browser form validation or top-bar-only notices make "Save and login" look like it did nothing.

### 6. Tests Required

- Build/type-check frontend after changing auth/profile sync.
- Run Rust tests after changing `load_state` auth behavior.
- Manual smoke test: start with `ipatool` already logged in and no saved profile; the account list should receive a local profile for the active email.

### 7. Wrong vs Correct

#### Wrong

```ts
setAuth(state.auth);
setConfig(state.config);
```

This can render a signed-in top bar while leaving `selectedAccountId` empty.

#### Correct

```ts
setAuth(state.auth);
setConfig(state.config);
await syncAuthProfile(state.auth, state.config);
```

The local profile list is brought into alignment with the real `ipatool` login state before account-gated commands are used.

## Scenario: Search Results And Version Selection

### 1. Scope / Trigger

- Trigger: frontend renders `ipatool search` and `ipatool list-versions` JSON into app cards and historical version rows.
- This is a UI/API boundary because `ipatool` JSON field names vary across App Store payloads and tool versions.

### 2. Signatures

```ts
extractApps(json: Record<string, unknown>): AppRecord[]
extractVersions(json: Record<string, unknown>): VersionRecord[]
runGetVersionMetadata(bundleId: string, externalVersionId: string): Promise<{
  versionName?: string | null
  diagnostic: CommandDiagnostic
}>
runPurchase(bundleId: string): Promise<CommandOutput>
```

### 3. Contracts

- Search result parsing must accept common field variants: `bundleId`, `bundleIdentifier`, `bundleID`, `appId`, `appID`, `trackId`, `adamId`.
- App icon parsing must accept direct and nested artwork fields: `iconUrl`, `iconURL`, `icon`, `artworkURL`, `artworkUrl100`, `artwork.url`, and artwork template URLs.
- Search result cards display price, not file size. Raw `ipatool search` usually returns `price` but not icon or file size.
- When `ipatool search` returns App Store `id` values, the UI should call the backend `lookup_apps(ids)` command to enrich cards with Apple Lookup fields such as `artworkUrl100`, `artworkUrl512`, `formattedPrice`, and `price`.
- `lookup_apps` should run outside the WebView fetch path because Apple's Lookup endpoint may not provide CORS headers; use the backend path so icon enrichment is not blocked by browser CORS.
- `lookup_apps` must not hardcode one or two storefront countries. Account searches can be region-scoped, and users may sign in with any App Store storefront. Pass country hints from `AuthState.countryCode` and search payload fields such as `countryCode`, `country`, or `storeCountryCode`; when no hint finds a match, use broad multi-storefront fallback and merge by App Store id.
- Lookup enrichment is primarily for missing artwork. Preserve the original `ipatool search` price when present so fallback storefront metadata does not display the wrong regional price.
- The search result "获取 IPA" action should open the details/version list view. It must not immediately start a download from the search results list.
- Historical-version download must use the `ipatool download --external-version-id` flag.
- Version listing should prefer `--app-id` when an App Store id is available; if ipatool returns `invalid response` and a bundle id is available, the backend must retry with `--bundle-identifier`.
- Historical-version metadata lookup must use a lightweight backend response. The backend should parse the actual version name and return only `versionName` plus a compact diagnostic; do not send the full metadata JSON payload back to the WebView.
- Historical-version metadata lookup must be an async Tauri command that runs the blocking `ipatool` subprocess and JSON parsing inside `tauri::async_runtime::spawn_blocking`. A synchronous command can freeze other WebView interactions even when the frontend uses `await invoke(...)`.
- Row-level metadata lookup must set the row loading state, wait for the next browser paint, and only then invoke Tauri so the click feedback is visible before the subprocess starts or IPC payloads are processed.
- If historical-version loading fails with `license is required`, show a `ConfirmDialog` explaining that the current Apple ID must first get/purchase the app, including free apps. On confirmation, call `runPurchase(bundleId)` and then retry historical-version loading.
- Purchase commands run an external `ipatool` subprocess and must use an async Tauri command with `spawn_blocking`, just like metadata lookup.
- Settings diagnostics must show the latest command, exit code, duration, redacted stdout, and redacted stderr so JSON field mismatches can be diagnosed from the UI.

### 4. Validation & Error Matrix

- Search output has nested `data` / `results` / `items` arrays -> find app rows and render cards.
- Search output has no size/icon field -> render fallback icon and `-`, without breaking the row.
- Search output has no icon but has `id` -> enrich from Apple Lookup and update icons asynchronously; if lookup fails, keep the original `ipatool` rows.
- Version output has `externalVersionIdentifiers` / `externalVersionIds` / `externalVersionIDs` as a scalar array -> render one downloadable row per external version ID.
- Version output has `versions`, `versionHistory`, `results`, `data`, or `items` as object arrays -> render rows.
- Version-name lookup by historical version ID must be user-initiated per row. Do not automatically or batch call `get-version-metadata`; one click should fetch only that row's external version ID.
- Version-name lookup receives a large metadata response from `ipatool` -> backend parses and compacts before returning to frontend; frontend renders only the resolved value for that row.
- Version command returns `license is required` -> keep the current-version fallback visible, ask for confirmation to get/purchase the app, then retry version loading after purchase completes.
- App-id version command returns an ipatool `invalid response` JSON and the app row has a bundle id -> backend retries by bundle id before frontend falls back.
- Version output has no rows -> show "未获取到历史版本" instead of success.
- Version command fails with an ipatool response like `invalid response` -> show the current search result version as a fallback downloadable row and surface the failure in notice/logs.
- Latest command diagnostic exists -> settings page renders the command and raw redacted stdout/stderr in scrollable monospace blocks.

### 5. Good/Base/Bad Cases

- Good: clicking "获取 IPA" from search loads details and historical versions; downloading only happens from a selected version row.
- Good: clicking a row's metadata "获取" button immediately changes that button to a loading state before the backend command starts, and the returned payload is small.
- Good: row metadata lookup uses `async fn` plus `spawn_blocking` so other buttons, scrolling, and navigation remain usable while `ipatool` is running.
- Good: a license-required version-list failure is actionable: the user sees a confirm dialog and can purchase/get the app without leaving the details flow.
- Bad: search-list "获取 IPA" starts a download immediately, because it skips version choice.
- Bad: returning the entire `get-version-metadata` JSON/diagnostic stdout to React can freeze the WebView while IPC deserializes and renders diagnostics.
- Bad: doing `Command::new(...).output()` directly inside a synchronous `#[tauri::command] fn` makes the frontend feel blocked even if the TypeScript caller awaits a Promise.
- Bad: showing raw `license is required` only as an Alert leaves users unable to recover from the history page.

### 6. Tests Required

- Build/type-check frontend after adding field variants.
- Run Rust tests after changing backend response shapes or metadata parsing.
- Manual smoke test with at least one real search result containing artwork and byte size.

### 7. Wrong vs Correct

#### Wrong

```ts
onDownload={(bundleId) => startDownload(bundleId)}
```

#### Correct

```ts
onDownload={(app) => openDetails(app)}
```

Search results navigate to the version-selection workflow before any IPA download starts.

#### Wrong

```ts
setVersionMetadata((items) => ({ ...items, [versionId]: { loading: true } }));
const output = await api.runGetVersionMetadata(bundleId, versionId);
```

This can enter IPC before the loading state paints.

#### Correct

```ts
setVersionMetadata((items) => ({ ...items, [versionId]: { loading: true } }));
await waitForPaint();
const output = await api.runGetVersionMetadata(bundleId, versionId);
```

## Scenario: App-Owned Download History

### 1. Scope / Trigger

- Trigger: frontend records and renders download history for IPA downloads.
- This is a cross-layer contract: PTY download exit event -> frontend download context -> `src/api.ts` wrapper -> Tauri command -> persisted `state.json`.

### 2. Signatures

```ts
type DownloadHistoryItem = {
  id: string
  appName: string
  bundleId: string
  appIconUrl?: string | null
  versionName?: string | null
  externalVersionId?: string | null
  accountId?: string | null
  accountEmail?: string | null
  outputPath?: string | null
  downloadedAt: string
}

recordDownloadHistory(item: DownloadHistoryItem): Promise<AppConfig>
deleteDownloadHistory(id: string): Promise<AppConfig>
clearDownloadHistory(): Promise<AppConfig>
```

### 3. Contracts

- `AppConfig.downloadHistory` contains only downloads launched by this app and observed as successful through the app's PTY session.
- Do not scan filesystem download folders, shell history, or `ipatool` external state to populate this list.
- A download history item must contain enough data to repeat the same command: `bundleId` plus optional `externalVersionId`.
- History recording happens only after the PTY download exits with code `0`.
- Re-downloading a history item must run the same selected-account command preflight used by search, version list, purchase, and first-time download.
- The history entry can store local metadata such as app name, icon URL, selected account email, output path, and downloaded timestamp, but it must not store auth secrets or PTY input.
- Clearing or deleting history removes only local history records. It must not delete downloaded files, account profiles, or `ipatool` login state.

### 4. Validation & Error Matrix

- PTY download exits `0` -> call `recordDownloadHistory` with the captured download context.
- PTY download exits non-zero or errors -> do not write a history item; show the normal command failure surface.
- Missing `bundleId` in a history item -> block re-download before invoking `ipatool`.
- History item has no `externalVersionId` -> repeat current-version download for the bundle id.
- No matching selected/active account -> block through shared `commandPreflight`; do not invoke `ipatool`.

### 5. Good/Base/Bad Cases

- Good: a successful historical-version download writes a row with app name, bundle id, external version id, account email, output path, and timestamp.
- Base: a user can delete one row or clear all rows without touching files on disk.
- Bad: reading the user's download directory and guessing IPA provenance mixes external downloads into the app-owned history.
- Bad: re-download bypasses selected-account validation and can run under the wrong regional Apple ID.

### 6. Tests Required

- Build/type-check frontend after changing `DownloadHistoryItem` fields or history rendering.
- Run Rust tests after changing `AppConfig` serialization or history Tauri commands.
- Manual smoke test: complete one download, confirm it appears in history, click re-download, then delete and clear records.

### 7. Wrong vs Correct

#### Wrong

```ts
const files = await scanDownloadDirectory(defaultDownloadDir);
setHistory(files);
```

#### Correct

```ts
if (ptyMode === "download" && exitCode === 0) {
  await api.recordDownloadHistory(downloadContext);
}
```

The history is app-owned and repeatable because it comes from the exact command context the app launched.

## Scenario: Global IPA Download Directory

### 1. Scope / Trigger

- Trigger: UI lets users configure where future IPA downloads are saved.
- This is a cross-layer contract: settings/history UI -> `src/api.ts` wrappers -> Tauri directory picker/open commands -> persisted `AppConfig.downloadDir` -> PTY download args.

### 2. Signatures

```ts
type AppConfig = {
  downloadDir?: string | null
}

pickDownloadDir(): Promise<string | null>
setDownloadDir(path: string | null): Promise<AppConfig>
openDirectory(path: string): Promise<void>
```

Backend commands:

```rust
fn pick_download_dir() -> Result<Option<String>, String>
fn set_download_dir(app: AppHandle, path: Option<String>) -> Result<AppConfig, String>
fn open_directory(path: String) -> Result<(), String>
```

### 3. Contracts

- `AppConfig.downloadDir` is the global default output directory for all future downloads launched by this app.
- Settings and download history must render the same `downloadDir` value from `AppConfig`; selecting a directory from either place updates the same persisted field.
- Account create/edit modals must not expose per-account download directory fields. Keep legacy `AccountProfile.defaultDownloadDir` only for config compatibility.
- Download command construction must use `AppConfig.downloadDir` when configured, then omit `--output` so `ipatool` uses its own default.
- A successful download history row stores the actual output directory used for that command in `outputPath`.
- Directory selection must use the native folder picker. Directory opening must validate that the saved path exists and is a directory before launching the OS opener.
- Settings must not render the old "recent command" module or raw command log module when the UX is focused on configuration.

### 4. Validation & Error Matrix

- User cancels folder picker -> keep existing `downloadDir`.
- User selects folder -> persist it through `setDownloadDir`, then update UI from returned `AppConfig`.
- User clicks open with no directory -> show an alert and do not call backend open.
- Saved path does not exist or is not a directory -> backend returns an error and frontend shows the shared alert surface.
- Download starts with global directory configured -> append `--output <downloadDir>` to PTY args and record that same path in history.

### 5. Good/Base/Bad Cases

- Good: changing the directory in history immediately updates settings because both pages read `config.downloadDir`.
- Base: if no global directory is set, no `--output` is passed and `ipatool` uses its own default.
- Bad: keeping separate local state per page causes settings and history to drift.
- Bad: opening a path without validating it can produce a silent OS-level failure.

### 6. Tests Required

- Build/type-check frontend after changing `AppConfig` fields or directory controls.
- Run Rust tests after changing store serialization or Tauri command registration.
- Manual smoke test: choose a directory in settings, verify history shows it, open it from history, then start a download and confirm the history row stores that path.

### 7. Wrong vs Correct

#### Wrong

```ts
const outputDir = selectedAccount?.defaultDownloadDir?.trim() || "";
```

#### Correct

```ts
const outputDir = config.downloadDir?.trim() || "";
```

The global setting is the only app-level IPA save location; account profiles should not own download directories.
