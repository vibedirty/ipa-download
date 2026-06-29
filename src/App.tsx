import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { copy } from "./i18n";
import type {
  AccountProfile,
  AppConfig,
  AppState,
  AuthState,
  BinaryStatus,
  CommandDiagnostic,
  CommandOutput,
  PtyEvent
} from "./types";

const blankProfile = (): AccountProfile => ({
  id: crypto.randomUUID(),
  email: "",
  displayName: "",
  defaultDownloadDir: "",
  notes: "",
  lastUsedAt: null
});

const emptyBinary: BinaryStatus = {
  ok: false,
  path: null,
  version: null,
  helpOk: false,
  error: "未检查"
};

const emptyAuth: AuthState = {
  signedIn: false,
  email: null,
  name: null,
  error: "未检查"
};

function App() {
  const [config, setConfig] = useState<AppConfig>({ accounts: [] });
  const [binary, setBinary] = useState<BinaryStatus>(emptyBinary);
  const [auth, setAuth] = useState<AuthState>(emptyAuth);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountProfile>(blankProfile);
  const [binaryInput, setBinaryInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [platform, setPlatform] = useState("");
  const [limit, setLimit] = useState(5);
  const [searchResult, setSearchResult] = useState<CommandOutput | null>(null);
  const [versionsBundle, setVersionsBundle] = useState("");
  const [versionsAppId, setVersionsAppId] = useState("");
  const [versionsResult, setVersionsResult] = useState<CommandOutput | null>(null);
  const [downloadBundle, setDownloadBundle] = useState("");
  const [downloadAppId, setDownloadAppId] = useState("");
  const [downloadOutput, setDownloadOutput] = useState("");
  const [downloadExternalVersionId, setDownloadExternalVersionId] = useState("");
  const [purchaseBeforeDownload, setPurchaseBeforeDownload] = useState(false);
  const [diagnostic, setDiagnostic] = useState<CommandDiagnostic | null>(null);
  const [status, setStatus] = useState<string>(copy.loading);
  const [ptySessionId, setPtySessionId] = useState<string | null>(null);
  const [ptyLog, setPtyLog] = useState("");
  const [prompt, setPrompt] = useState<"password" | "twoFactor" | null>(null);
  const [secretInput, setSecretInput] = useState("");

  const selectedAccount = useMemo(
    () => config.accounts.find((account) => account.id === selectedId) ?? null,
    [config.accounts, selectedId]
  );

  const activeMatchesSelected =
    !!selectedAccount &&
    !!auth.email &&
    auth.email.toLowerCase() === selectedAccount.email.toLowerCase();

  useEffect(() => {
    void initialize();
    const unlisten = listen<PtyEvent>("ipatool://pty", (event) => {
      handlePtyEvent(event.payload);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  async function initialize() {
    try {
      const state = await api.loadState();
      applyState(state);
      setStatus(copy.ready);
    } catch (error) {
      setStatus(String(error));
    }
  }

  function applyState(state: AppState) {
    setConfig(state.config);
    setBinary(state.binary);
    setAuth(state.auth);
    setBinaryInput(state.config.binaryPath ?? state.binary.path ?? "");
    const initialSelected =
      state.config.selectedAccountId ??
      state.config.accounts.find(
        (account) =>
          state.auth.email &&
          account.email.toLowerCase() === state.auth.email.toLowerCase()
      )?.id ??
      state.config.accounts[0]?.id ??
      null;
    setSelectedId(initialSelected);
    if (state.auth.diagnostic) {
      setDiagnostic(state.auth.diagnostic);
    }
  }

  async function saveAccount() {
    if (!editing.email.trim()) {
      setStatus(copy.emailRequired);
      return;
    }
    const next = {
      ...editing,
      email: editing.email.trim().toLowerCase(),
      displayName: editing.displayName.trim() || editing.email.trim()
    };
    const updated = await api.upsertAccount(next);
    setConfig(updated);
    setSelectedId(next.id);
    setEditing(blankProfile());
    setStatus(copy.profileSaved);
  }

  async function removeAccount(account: AccountProfile) {
    const isActive =
      auth.email?.toLowerCase() === account.email.toLowerCase() && auth.signedIn;
    const revoke = isActive
      ? window.confirm(copy.deleteActiveConfirm)
      : false;
    const [updated] = await api.deleteAccount(account.id, revoke);
    setConfig(updated);
    setSelectedId(updated.accounts[0]?.id ?? null);
    if (revoke) {
      const refreshed = await api.refreshAuthInfo();
      setAuth(refreshed);
    }
    setStatus(copy.profileDeleted);
  }

  async function chooseBinary() {
    const picked = await api.pickBinaryFile();
    if (!picked) return;
    setBinaryInput(picked);
    const next = await api.setBinaryPath(picked);
    setBinary(next);
    setStatus(next.ok ? copy.binaryConfigured : next.error ?? copy.binaryCheckFailed);
  }

  async function saveBinaryPath() {
    const next = await api.setBinaryPath(binaryInput.trim());
    setBinary(next);
    setStatus(next.ok ? copy.binaryConfigured : next.error ?? copy.binaryCheckFailed);
  }

  async function detectOnPath() {
    const next = await api.detectBinary();
    setBinary(next);
    if (next.path) {
      setBinaryInput(next.path);
    }
    setStatus(next.ok ? copy.foundOnPath : next.error ?? copy.notFound);
  }

  async function refreshAuth() {
    const next = await api.refreshAuthInfo();
    setAuth(next);
    if (next.diagnostic) setDiagnostic(next.diagnostic);
    setStatus(next.signedIn ? `${copy.signedInAs}${next.email}` : next.error ?? copy.signedOut);
  }

  async function revoke() {
    const out = await api.revokeAuth();
    setDiagnostic(out.diagnostic);
    setAuth({ signedIn: false, email: null, name: null, error: copy.signedOut });
    setStatus(copy.loginRevoked);
  }

  async function startLogin(account = selectedAccount) {
    if (!account) {
      setStatus(copy.selectProfileFirst);
      return;
    }
    if (!binary.ok) {
      setStatus(copy.configureBinaryFirst);
      return;
    }
    if (auth.email && auth.email.toLowerCase() !== account.email.toLowerCase()) {
      const confirmed = window.confirm(copy.switchConfirm);
      if (!confirmed) return;
      try {
        await api.revokeAuth();
      } catch {
        // Login can still proceed if revoke fails because ipatool will overwrite on success.
      }
      setAuth({ signedIn: false, email: null, name: null, error: copy.switchingAccounts });
    }

    const sessionId = crypto.randomUUID();
    setPtySessionId(sessionId);
    setPtyLog("");
    setPrompt(null);
    setSecretInput("");
    setStatus(`${copy.loggingIn} ${account.email}`);
    await api.startPty({
      sessionId,
      kind: "login",
      email: account.email
    });
  }

  async function submitSecret() {
    if (!ptySessionId || !secretInput) return;
    await api.sendPtyInput(ptySessionId, secretInput, true);
    setSecretInput("");
    setPrompt(null);
  }

  function handlePtyEvent(event: PtyEvent) {
    if (event.data) {
      setPtyLog((current) => current + event.data);
    }
    if (event.event === "prompt" && event.prompt) {
      setPrompt(event.prompt);
    }
    if (event.event === "error") {
      setStatus(event.data ?? copy.ptyError);
    }
    if (event.event === "exit") {
      setPrompt(null);
      setStatus(
        event.exitCode === 0
          ? copy.commandFinished
          : `${copy.commandExited} ${event.exitCode}`
      );
      void refreshAuth();
    }
  }

  async function search() {
    if (!ensureActiveAccount()) return;
    const out = await api.runSearch(searchTerm, platform, limit);
    setSearchResult(out);
    setDiagnostic(out.diagnostic);
    setStatus(copy.searchComplete);
  }

  async function listVersions() {
    if (!ensureActiveAccount()) return;
    const appId = versionsAppId ? Number(versionsAppId) : undefined;
    const out = await api.runListVersions(appId, versionsBundle);
    setVersionsResult(out);
    setDiagnostic(out.diagnostic);
    setStatus(copy.versionsLoaded);
  }

  async function purchase() {
    if (!ensureActiveAccount()) return;
    const bundleId = versionsBundle || downloadBundle;
    if (!bundleId) {
      setStatus(copy.bundleRequiredForPurchase);
      return;
    }
    const out = await api.runPurchase(bundleId);
    setDiagnostic(out.diagnostic);
    setStatus(copy.purchaseFinished);
  }

  async function startDownload() {
    if (!ensureActiveAccount()) return;
    const args = ["download"];
    if (downloadAppId) args.push("--app-id", downloadAppId);
    if (downloadBundle) args.push("--bundle-identifier", downloadBundle);
    if (downloadOutput) args.push("--output", downloadOutput);
    if (downloadExternalVersionId) {
      args.push("--external-version-id", downloadExternalVersionId);
    }
    if (platform) args.push("--platform", platform);
    if (purchaseBeforeDownload) args.push("--purchase");
    if (!downloadAppId && !downloadBundle) {
      setStatus(copy.appIdOrBundleRequired);
      return;
    }
    const sessionId = crypto.randomUUID();
    setPtySessionId(sessionId);
    setPtyLog("");
    setStatus(copy.downloadStarted);
    await api.startPty({ sessionId, kind: "download", args });
  }

  function ensureActiveAccount() {
    if (!auth.signedIn) {
      setStatus(copy.signInBeforeCommands);
      return false;
    }
    if (!selectedAccount) {
      setStatus(copy.selectProfileFirst);
      return false;
    }
    if (!activeMatchesSelected) {
      setStatus(copy.selectedMismatch);
      return false;
    }
    return true;
  }

  const apps = Array.isArray(searchResult?.json.apps)
    ? (searchResult?.json.apps as Array<Record<string, unknown>>)
    : [];

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brandMark">IPA</span>
          <div>
            <h1>{copy.appName}</h1>
            <p>{copy.appSubtitle}</p>
          </div>
        </div>

        <section className="railSection">
          <div className="sectionHeader">
            <h2>{copy.accounts}</h2>
            <button className="iconButton" onClick={() => setEditing(blankProfile())}>
              <span className="srOnly">{copy.newAccount}</span>
              +
            </button>
          </div>
          <div className="accountList">
            {config.accounts.map((account) => {
              const isActive =
                auth.email?.toLowerCase() === account.email.toLowerCase() && auth.signedIn;
              return (
                <button
                  key={account.id}
                  className={`accountButton ${selectedId === account.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(account.id)}
                >
                  <span>{account.displayName || account.email}</span>
                  <small>{isActive ? copy.activeLogin : account.email}</small>
                </button>
              );
            })}
            {config.accounts.length === 0 && (
              <p className="empty">{copy.noProfiles}</p>
            )}
          </div>
        </section>

        <section className="railSection statusBox">
          <span className={`dot ${binary.ok ? "good" : "bad"}`} />
          <div>
            <strong>{binary.ok ? copy.binaryReady : copy.binaryMissing}</strong>
            <small>{binary.version ?? binary.error}</small>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{copy.currentState}</p>
            <h2>{auth.signedIn ? auth.email : copy.notSignedIn}</h2>
          </div>
          <div className="topActions">
            <button onClick={refreshAuth}>{copy.refresh}</button>
            <button onClick={revoke} disabled={!auth.signedIn}>
              {copy.revoke}
            </button>
          </div>
        </header>

        <div className="grid">
          <section className="panel wide">
            <h3>{copy.binary}</h3>
            <div className="inline">
              <input
                value={binaryInput}
                onChange={(event) => setBinaryInput(event.target.value)}
                placeholder={copy.binaryPathPlaceholder}
              />
              <button onClick={chooseBinary}>{copy.choose}</button>
              <button onClick={saveBinaryPath}>{copy.save}</button>
              <button onClick={detectOnPath}>{copy.autoDetect}</button>
            </div>
          </section>

          <section className="panel">
            <h3>{copy.profile}</h3>
            <label>
              {copy.email}
              <input
                value={editing.email}
                onChange={(event) =>
                  setEditing({ ...editing, email: event.target.value })
                }
              />
            </label>
            <label>
              {copy.displayName}
              <input
                value={editing.displayName}
                onChange={(event) =>
                  setEditing({ ...editing, displayName: event.target.value })
                }
              />
            </label>
            <label>
              {copy.defaultDownloadDir}
              <input
                value={editing.defaultDownloadDir}
                onChange={(event) =>
                  setEditing({ ...editing, defaultDownloadDir: event.target.value })
                }
              />
            </label>
            <label>
              {copy.notes}
              <textarea
                value={editing.notes}
                onChange={(event) =>
                  setEditing({ ...editing, notes: event.target.value })
                }
              />
            </label>
            <div className="inline">
              <button className="primary" onClick={saveAccount}>
                {copy.saveProfile}
              </button>
              {selectedAccount && (
                <button onClick={() => setEditing(selectedAccount)}>{copy.editSelected}</button>
              )}
            </div>
          </section>

          <section className="panel">
            <h3>{copy.login}</h3>
            <div className="identity">
              <strong>{selectedAccount?.displayName || selectedAccount?.email || copy.noProfile}</strong>
              <small>
                {activeMatchesSelected
                  ? copy.matchesActiveLogin
                  : copy.requiresLogin}
              </small>
            </div>
            <div className="inline">
              <button className="primary" onClick={() => startLogin()}>
                {copy.loginOrSwitch}
              </button>
              {selectedAccount && (
                <button onClick={() => removeAccount(selectedAccount)}>{copy.deleteProfile}</button>
              )}
            </div>
            {prompt && (
              <div className="secretBox">
                <label>
                  {prompt === "password" ? copy.applePassword : copy.twoFactorCode}
                  <input
                    type={prompt === "password" ? "password" : "text"}
                    value={secretInput}
                    autoFocus
                    onChange={(event) => setSecretInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitSecret();
                    }}
                  />
                </label>
                <button onClick={submitSecret}>{copy.send}</button>
              </div>
            )}
          </section>

          <section className="panel wide">
            <h3>{copy.search}</h3>
            <div className="inline">
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={copy.searchTerm}
              />
              <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
                <option value="">{copy.iphoneDefault}</option>
                <option value="iphone">iPhone</option>
                <option value="ipad">iPad</option>
                <option value="appletv">Apple TV</option>
              </select>
              <input
                className="short"
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              />
              <button className="primary" onClick={search}>
                {copy.search}
              </button>
            </div>
            <div className="results">
              {apps.map((app, index) => (
                <div className="resultRow" key={`${app.bundleID ?? app.id ?? index}`}>
                  <div>
                    <strong>{String(app.name ?? app.bundleID ?? copy.unknownApp)}</strong>
                    <small>{String(app.bundleID ?? "")}</small>
                  </div>
                  <code>{String(app.id ?? "")}</code>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h3>{copy.versionsPurchase}</h3>
            <label>
              {copy.bundleId}
              <input
                value={versionsBundle}
                onChange={(event) => setVersionsBundle(event.target.value)}
              />
            </label>
            <label>
              {copy.appId}
              <input
                value={versionsAppId}
                onChange={(event) => setVersionsAppId(event.target.value)}
              />
            </label>
            <div className="inline">
              <button onClick={listVersions}>{copy.listVersions}</button>
              <button onClick={purchase}>{copy.purchase}</button>
            </div>
            <pre className="miniLog">
              {versionsResult ? JSON.stringify(versionsResult.json, null, 2) : ""}
            </pre>
          </section>

          <section className="panel">
            <h3>{copy.download}</h3>
            <label>
              {copy.bundleId}
              <input
                value={downloadBundle}
                onChange={(event) => setDownloadBundle(event.target.value)}
              />
            </label>
            <label>
              {copy.appId}
              <input
                value={downloadAppId}
                onChange={(event) => setDownloadAppId(event.target.value)}
              />
            </label>
            <label>
              {copy.externalVersionId}
              <input
                value={downloadExternalVersionId}
                onChange={(event) => setDownloadExternalVersionId(event.target.value)}
              />
            </label>
            <label>
              {copy.outputPath}
              <input
                value={downloadOutput}
                onChange={(event) => setDownloadOutput(event.target.value)}
                placeholder={selectedAccount?.defaultDownloadDir || copy.outputPathPlaceholder}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={purchaseBeforeDownload}
                onChange={(event) => setPurchaseBeforeDownload(event.target.checked)}
              />
              {copy.purchaseIfNeeded}
            </label>
            <button className="primary" onClick={startDownload}>
              {copy.download}
            </button>
          </section>

          <section className="panel wide diagnostics">
            <h3>{copy.diagnostics}</h3>
            <div className="statusLine">{status}</div>
            <pre>{ptyLog || formatDiagnostic(diagnostic)}</pre>
          </section>
        </div>
      </section>
    </main>
  );
}

function formatDiagnostic(diagnostic: CommandDiagnostic | null) {
  if (!diagnostic) return copy.noDiagnostic;
  return JSON.stringify(diagnostic, null, 2);
}

export default App;
