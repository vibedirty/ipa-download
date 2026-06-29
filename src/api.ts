import { invoke } from "@tauri-apps/api/core";
import type {
  AccountProfile,
  AppConfig,
  AppState,
  AuthState,
  BinaryStatus,
  CommandOutput
} from "./types";

export const api = {
  loadState: () => invoke<AppState>("load_state"),
  pickBinaryFile: () => invoke<string | null>("pick_binary_file"),
  detectBinary: () => invoke<BinaryStatus>("detect_binary"),
  setBinaryPath: (path: string) => invoke<BinaryStatus>("set_binary_path", { path }),
  upsertAccount: (profile: AccountProfile) =>
    invoke<AppConfig>("upsert_account", { profile }),
  deleteAccount: (id: string, revokeIfActive: boolean) =>
    invoke<[AppConfig, unknown | null]>("delete_account", { id, revokeIfActive }),
  refreshAuthInfo: () => invoke<AuthState>("refresh_auth_info"),
  revokeAuth: () => invoke<CommandOutput>("revoke_auth"),
  runSearch: (term: string, platform: string, limit: number) =>
    invoke<CommandOutput>("run_search", {
      term,
      platform: platform || null,
      limit
    }),
  runListVersions: (appId?: number, bundleId?: string) =>
    invoke<CommandOutput>("run_list_versions", {
      appId: appId || null,
      bundleId: bundleId || null
    }),
  runPurchase: (bundleId: string) => invoke<CommandOutput>("run_purchase", { bundleId }),
  startPty: (request: {
    sessionId: string;
    kind: "login" | "download";
    email?: string | null;
    args?: string[] | null;
  }) => invoke<void>("start_pty", { request }),
  sendPtyInput: (sessionId: string, data: string, submit = true) =>
    invoke<void>("send_pty_input", { input: { sessionId, data, submit } }),
  stopPty: (sessionId: string) => invoke<void>("stop_pty", { sessionId })
};
