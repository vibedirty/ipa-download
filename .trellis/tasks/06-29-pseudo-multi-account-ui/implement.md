# Pseudo Multi-Account UI Implementation Plan

## Checklist

1. Re-read relevant frontend guidelines before code edits.
2. Inspect current `App.tsx`, `styles.css`, `api.ts`, `types.ts`, `store.rs`, `ipatool.rs`, `pty.rs`, and `lib.rs` for the exact change points.
3. Add or adjust backend helpers where needed:
   - selected account persistence / `lastUsedAt` update
   - active-email comparison helper
   - safer revoke/delete diagnostics if current behavior drops successful diagnostics
   - any download arg helper that reduces frontend duplication
4. Add backend tests:
   - profile serialization excludes secrets
   - auth/redaction keeps email but removes sensitive values
   - active-account matching is case-insensitive
   - delete active/non-active profile behavior
   - switch failure leaves profiles intact where backend code participates
5. Preserve the Stitch/static React prototype design while adding stateful Tauri UI wiring:
   - load app state on startup
   - binary chooser/detection
   - profile list/create/edit/delete
   - selected/active/unverified status derivation
   - login/switch flow with revoke confirmation
   - PTY prompt handling for password and 2FA
   - search/list-versions/purchase command forms
   - shared selected-email preflight guard for search, version list, purchase, and download
   - download form using the same guard
   - diagnostics panel
6. Ensure password and 2FA component state is cleared after submit/exit.
7. Keep `src/i18n.ts` as the source for visible Chinese copy where practical.
8. Update CSS only where required to support existing-design states; do not replace the layout, palette, or component structure without explicit user approval.
9. Run validation commands.
10. Review generated diff for accidental secret persistence, broad rewrites outside scope, and user-owned unrelated changes.

## Validation Commands

Run from repository root:

```bash
npm run build
```

Run from `src-tauri`:

```bash
cargo test
```

If a dev server is needed for manual smoke testing:

```bash
npm run dev
```

Manual smoke checks:

- no binary configured state
- mock binary auth-info failure state
- add two profiles with different download dirs
- login A through PTY prompt UI
- switch A to B with revoke confirmation
- failed B login leaves app signed out and profiles intact
- delete non-active profile
- delete active profile with and without revoke
- search, version list, purchase, and download blocked on selected/active mismatch
- diagnostics show redacted logs

## Risky Files / Rollback Points

- `src/App.tsx`: current UI is a Stitch-derived design artifact. Preserve visual structure while wiring behavior.
- `src/styles.css`: preserve existing layout language and avoid broad palette/layout churn.
- `src-tauri/src/store.rs`: persistence bugs here can corrupt `state.json`; keep schema backward-compatible.
- `src-tauri/src/pty.rs`: do not log raw PTY input; prompt detection changes should be tested.
- `src-tauri/src/ipatool.rs`: redaction changes must preserve email visibility while removing secrets.

## Review Gates Before `task.py start`

- PRD has concrete acceptance criteria.
- Design explicitly states pseudo-account boundaries and single real session behavior.
- Implementation plan names validation commands and high-risk files.
- User has reviewed/approved planning or explicitly asked to start implementation.
