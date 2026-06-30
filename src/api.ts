import { invoke } from "@tauri-apps/api/core";
import type {
  AccountProfile,
  AppConfig,
  AppState,
  AuthState,
  BinaryStatus,
  CommandOutput,
  DownloadHistoryItem,
  VersionMetadataOutput
} from "./types";

export const api = {
  loadState: () => invoke<AppState>("load_state"),
  pickBinaryFile: () => invoke<string | null>("pick_binary_file"),
  pickDownloadDir: () => invoke<string | null>("pick_download_dir"),
  detectBinary: () => invoke<BinaryStatus>("detect_binary"),
  setBinaryPath: (path: string) => invoke<BinaryStatus>("set_binary_path", { path }),
  setDownloadDir: (path: string | null) =>
    invoke<AppConfig>("set_download_dir", { path }),
  openDirectory: (path: string) => invoke<void>("open_directory", { path }),
  upsertAccount: (profile: AccountProfile) =>
    invoke<AppConfig>("upsert_account", { profile }),
  deleteAccount: (id: string, revokeIfActive: boolean) =>
    invoke<[AppConfig, unknown | null]>("delete_account", { id, revokeIfActive }),
  setSelectedAccount: (id: string | null) =>
    invoke<AppConfig>("set_selected_account", { id }),
  markAccountUsed: (id: string) => invoke<AppConfig>("mark_account_used", { id }),
  recordDownloadHistory: (item: DownloadHistoryItem) =>
    invoke<AppConfig>("record_download_history", { item }),
  deleteDownloadHistory: (id: string) =>
    invoke<AppConfig>("delete_download_history", { id }),
  clearDownloadHistory: () => invoke<AppConfig>("clear_download_history"),
  refreshAuthInfo: () => invoke<AuthState>("refresh_auth_info"),
  revokeAuth: () => invoke<CommandOutput>("revoke_auth"),
  runSearch: (term: string, platform: string, limit: number) =>
    invoke<CommandOutput>("run_search", {
      term,
      platform: platform || null,
      limit
    }),
  lookupApps: (ids: number[], countries: string[] = []) =>
    invoke<Record<string, unknown>>("lookup_apps", { ids, countries }),
  runListVersions: (appId?: number, bundleId?: string) =>
    invoke<CommandOutput>("run_list_versions", {
      appId: appId || null,
      bundleId: bundleId || null
    }),
  runGetVersionMetadata: (bundleId: string, externalVersionId: string) =>
    invoke<VersionMetadataOutput>("run_get_version_metadata", {
      bundleId,
      externalVersionId
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
