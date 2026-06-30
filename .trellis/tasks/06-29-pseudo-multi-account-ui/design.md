# Pseudo Multi-Account UI Design

## Architecture And Boundaries

The app remains a thin Tauri UI over a user-selected local `ipatool` executable, implemented under the existing Stitch-derived visual design.

- Frontend owns:
  - local UI state and view composition
  - account profile CRUD forms
  - account switch confirmations
  - PTY prompt UI for password and 2FA input
  - download preflight validation
  - diagnostics presentation
- Frontend must preserve the existing static prototype design. Behavior wiring should adapt to the current layout instead of replacing the screen structure.
- Tauri backend owns:
  - persisted `state.json`
  - binary detection and command execution
  - `auth info` / `auth revoke` commands
  - PTY process lifecycle
  - command diagnostics and redaction
- `ipatool` owns:
  - the one real App Store login state
  - cookie/account/keychain behavior
  - App Store operations

No layer should claim or model multiple real `ipatool` sessions. Account profiles are local metadata keyed by email.

## Data Model

Existing `AppConfig` and `AccountProfile` remain the persisted model:

```ts
type AppConfig = {
  binaryPath?: string | null;
  selectedAccountId?: string | null;
  accounts: AccountProfile[];
};

type AccountProfile = {
  id: string;
  email: string;
  displayName: string;
  defaultDownloadDir: string;
  notes: string;
  lastUsedAt?: string | null;
};
```

Secrets are intentionally absent. Any UI state for password or 2FA must live only in React component state long enough to send PTY input.

## Auth State And Profile Status

`AuthState` is authoritative for the real current `ipatool` login:

- `signedIn=false`: no usable active session.
- `signedIn=true` with `email`: real active account email.

Profile row status is derived, not persisted:

- active: profile email equals `auth.email` case-insensitively.
- saved/not logged in: profile has been saved but does not match `auth.email`.
- unverified: profile exists but has never successfully matched `auth.email` in this UI session or lacks `lastUsedAt`.

When login verification succeeds, update `selectedAccountId` and `lastUsedAt` for that profile.

## Command Flow

### Startup

1. `load_state` loads config.
2. Detect binary from saved path or PATH.
3. If binary is usable, run `auth info --format json`.
4. Frontend derives selected/active profile state from returned `auth.email`.

### Login Selected Profile

1. User selects a profile.
2. If no binary, block with binary setup message.
3. If current `auth.email` equals profile email, update selected context only.
4. If current `auth.email` differs, show switch warning.
5. On confirmation, run `revoke_auth`.
6. Start PTY with `kind: "login"` and target email.
7. Render prompt-specific password/2FA fields when PTY prompt events arrive.
8. On PTY success, refresh `auth info`.
9. If refreshed email matches target email, mark profile selected and update `lastUsedAt`; otherwise show mismatch error.

### Login Failure After Revoke

If revoke succeeds but login or verification fails, the frontend refreshes `auth info` and shows signed out when no active login exists. It must not delete or mutate account profiles except for any explicitly selected UI context.

### Delete Profile

Deleting a profile always removes the local profile. If the profile matches active `auth.email`, ask whether to pass `revokeIfActive=true`; otherwise pass `false`.

### Search, Versions, Purchase

These commands use existing JSON command APIs and the current real `ipatool` login state, but they must pass the same selected-account preflight used by download before invoking `ipatool`.

The selected-account match is required because Apple IDs can be region-scoped. A search or purchase against the wrong active login can return different availability or mutate the wrong account.

### Shared Command Preflight

Before search, version list, purchase, or download, frontend runs a preflight check:

- binary exists and is usable
- selected profile exists
- `auth.signedIn` is true
- `auth.email` matches selected profile email

### Download

Download uses PTY because it may stream progress.

Download args should include output path. If the user leaves output blank, use selected profile `defaultDownloadDir`.

## Diagnostics

Maintain a frontend `lastDiagnostic` record from command results and PTY exit/log state. Show:

- binary path and version from `BinaryStatus`
- active email from `AuthState`
- latest exit code when present
- redacted stdout/stderr or PTY log text

Backend redaction remains the primary safety boundary. Frontend must not append raw password/2FA input to logs.

## Testing Strategy

Backend unit tests should cover command redaction, profile serialization, account deletion semantics, and any new pure helpers for active-account matching/shared command preflight.

Frontend implementation should keep account/auth state transformations in pure helpers where possible so they can be tested without a running Tauri shell. If the project does not yet have a frontend test runner, validate with TypeScript build and add backend tests for the higher-risk logic.

Mock `ipatool` integration should be implemented as a local script or test fixture that can simulate:

- `auth info` failure
- `auth info` success for selected emails
- `auth revoke`
- PTY login prompts and success/failure

## Trade-Offs

- This design accepts re-login switching to avoid patching `ipatool` session storage.
- Profile status is derived from real `auth info`, avoiding stale persisted "active" flags.
- Keeping preflight guard primarily in frontend is simpler, but any future backend command that combines selected profile and `ipatool` execution should repeat the same guard server-side before spawning `ipatool`.

## Rollback

The feature can be rolled back by reverting UI wiring and any new helper commands while preserving the existing `state.json` shape. Existing saved account profiles remain compatible because no secret fields or session material are introduced.
