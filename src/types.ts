export type AccountProfile = {
  id: string;
  email: string;
  displayName: string;
  defaultDownloadDir: string;
  notes: string;
  lastUsedAt?: string | null;
};

export type AppConfig = {
  binaryPath?: string | null;
  selectedAccountId?: string | null;
  accounts: AccountProfile[];
};

export type CommandDiagnostic = {
  command: string[];
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type BinaryStatus = {
  ok: boolean;
  path?: string | null;
  version?: string | null;
  helpOk: boolean;
  error?: string | null;
};

export type AuthState = {
  signedIn: boolean;
  email?: string | null;
  name?: string | null;
  error?: string | null;
  diagnostic?: CommandDiagnostic | null;
};

export type AppState = {
  config: AppConfig;
  binary: BinaryStatus;
  auth: AuthState;
};

export type CommandOutput = {
  json: Record<string, unknown>;
  diagnostic: CommandDiagnostic;
};

export type PtyEvent = {
  sessionId: string;
  event: "output" | "prompt" | "exit" | "error";
  data?: string | null;
  prompt?: "password" | "twoFactor" | null;
  exitCode?: number | null;
  durationMs?: number | null;
};
