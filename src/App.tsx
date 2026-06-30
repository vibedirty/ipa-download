import { listen } from "@tauri-apps/api/event";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  AccountProfile,
  AppConfig,
  AuthState,
  BinaryStatus,
  CommandDiagnostic,
  DownloadHistoryItem,
  PtyEvent
} from "./types";

const appLogoUrl = new URL("./assets/app-logo.png", import.meta.url).href;

type View = "search" | "details" | "history" | "settings";
type PromptKind = "password" | "twoFactor" | null;
type PtyMode = "login" | "download" | null;

type AlertState = {
  title: string;
  message: string;
};

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => Promise<void> | void;
};

type AppRecord = {
  name: string;
  bundleId: string;
  version: string;
  price: string;
  iconUrl?: string;
  appId?: number;
};

type VersionRecord = {
  versionName: string;
  versionId: string;
  date: string;
  platform: string;
  arch: string;
  badge: string;
  externalVersionId?: string;
};

type VersionMetadataState = {
  versionName?: string;
  loading?: boolean;
};

type AccountDraft = {
  email: string;
  displayName: string;
  notes: string;
  secret: string;
};

type DetailsLoadRequest = {
  id: number;
  app: AppRecord;
};

type DownloadContext = {
  appName: string;
  bundleId: string;
  appIconUrl?: string | null;
  versionName?: string | null;
  externalVersionId?: string | null;
  accountId?: string | null;
  accountEmail?: string | null;
  outputPath?: string | null;
};

const emptyConfig: AppConfig = {
  binaryPath: null,
  selectedAccountId: null,
  downloadDir: null,
  accounts: [],
  downloadHistory: []
};

const emptyBinary: BinaryStatus = {
  ok: false,
  path: null,
  version: null,
  helpOk: false,
  error: null
};

const emptyAuth: AuthState = {
  signedIn: false,
  email: null,
  name: null,
  countryCode: null,
  error: null,
  diagnostic: null
};

function App() {
  const [view, setView] = useState<View>("search");
  const [modalOpen, setModalOpen] = useState(false);
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [binary, setBinary] = useState<BinaryStatus>(emptyBinary);
  const [auth, setAuth] = useState<AuthState>(emptyAuth);
  const [busy, setBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState("");
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>({
    email: "",
    displayName: "",
    notes: "",
    secret: ""
  });
  const [promptKind, setPromptKind] = useState<PromptKind>(null);
  const [ptySessionId, setPtySessionId] = useState<string | null>(null);
  const [ptyMode, setPtyMode] = useState<PtyMode>(null);
  const [loginTargetId, setLoginTargetId] = useState<string | null>(null);
  const [pendingSwitchTarget, setPendingSwitchTarget] = useState<AccountProfile | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [selectedApp, setSelectedApp] = useState<AppRecord | null>(null);
  const [versions, setVersions] = useState<VersionRecord[]>([]);
  const [versionMetadata, setVersionMetadata] = useState<Record<string, VersionMetadataState>>({});
  const [detailsLoadRequest, setDetailsLoadRequest] = useState<DetailsLoadRequest | null>(null);
  const [binaryPath, setBinaryPath] = useState("");
  const [lastDiagnostic, setLastDiagnostic] = useState<CommandDiagnostic | null>(null);
  const ptyLogRef = useRef("");
  const loginTargetRef = useRef<AccountProfile | null>(null);
  const downloadContextRef = useRef<DownloadContext | null>(null);
  const searchRequestRef = useRef(0);
  const detailsRequestRef = useRef(0);

  const selectedAccount = useMemo(
    () => config.accounts.find((account) => account.id === config.selectedAccountId) ?? null,
    [config.accounts, config.selectedAccountId]
  );

  useEffect(() => {
    void loadState();
  }, []);

  useEffect(() => {
    if (!detailsLoadRequest) {
      return undefined;
    }

    let cancelled = false;
    const { app, id } = detailsLoadRequest;

    async function loadDetailsAfterPaint() {
      await waitForPaint();
      if (cancelled || detailsRequestRef.current !== id) {
        return;
      }

      setBusy(true);
      try {
        await loadVersionsForApp(app, id);
      } catch (error) {
        if (!cancelled && detailsRequestRef.current === id) {
          setVersions(fallbackVersionsForApp(app));
          if (isLicenseRequiredError(error)) {
            requestPurchaseConfirmation(app, id);
          } else {
            showAlert(`历史版本获取失败：${errorMessage(error)}。已显示当前版本`);
          }
        }
      } finally {
        if (!cancelled && detailsRequestRef.current === id) {
          setBusy(false);
          setDetailsLoading(false);
        }
      }
    }

    void loadDetailsAfterPaint();

    return () => {
      cancelled = true;
    };
  }, [detailsLoadRequest]);

  async function loadVersionsForApp(app: AppRecord, requestId: number) {
    const output = await api.runListVersions(app.appId, app.bundleId);
    if (detailsRequestRef.current !== requestId) {
      return;
    }
    setLastDiagnostic(output.diagnostic);
    const nextVersions = extractVersions(output.json);
    const visibleVersions = nextVersions.length ? nextVersions : fallbackVersionsForApp(app);
    setVersions(visibleVersions);
  }

  function requestPurchaseConfirmation(app: AppRecord, requestId: number) {
    setConfirmDialog({
      title: "需要先获取此 App",
      message: `当前 Apple ID 尚未获取/购买过「${app.name}」，无法读取历史版本。即使是免费 App，也需要先绑定到当前账号。是否现在执行获取/购买后重试？`,
      confirmLabel: "获取并重试",
      cancelLabel: "取消",
      onConfirm: () => purchaseAndReloadVersions(app, requestId)
    });
  }

  async function purchaseAndReloadVersions(app: AppRecord, requestId: number) {
    if (!commandPreflight()) {
      return;
    }
    if (detailsRequestRef.current !== requestId) {
      return;
    }

    setBusy(true);
    setDetailsLoading(true);
    await waitForPaint();
    try {
      const output = await api.runPurchase(app.bundleId);
      setLastDiagnostic(output.diagnostic);
      if (detailsRequestRef.current !== requestId) {
        return;
      }
    } catch (error) {
      showAlert(`获取/购买失败：${errorMessage(error)}`);
      if (detailsRequestRef.current === requestId) {
        setBusy(false);
        setDetailsLoading(false);
      }
      return;
    }

    try {
      await loadVersionsForApp(app, requestId);
    } catch (error) {
      showAlert(`已执行获取/购买，但历史版本仍获取失败：${errorMessage(error)}`);
    } finally {
      if (detailsRequestRef.current === requestId) {
        setBusy(false);
        setDetailsLoading(false);
      }
    }
  }

  function showSearchView() {
    detailsRequestRef.current += 1;
    setDetailsLoadRequest(null);
    setDetailsLoading(false);
    setView("search");
  }

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<PtyEvent>("ipatool://pty", (event) => {
      void handlePtyEvent(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [accountDraft.secret, loginTargetId, ptyMode, ptySessionId]);

  async function loadState() {
    setBusy(true);
    try {
      const state = await api.loadState();
      setConfig(state.config);
      setBinary(state.binary);
      setAuth(state.auth);
      setBinaryPath(state.config.binaryPath ?? state.binary.path ?? "");
      setLastDiagnostic(state.auth.diagnostic ?? null);
      await syncAuthProfile(state.auth, state.config);
    } catch (error) {
      showAlert(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshAuthInfo() {
    try {
      const nextAuth = await api.refreshAuthInfo();
      setAuth(nextAuth);
      setLastDiagnostic(nextAuth.diagnostic ?? lastDiagnostic);
      await syncAuthProfile(nextAuth, config);
    } catch (error) {
      setAuth({ ...emptyAuth, error: errorMessage(error) });
      showAlert(errorMessage(error));
    }
  }

  async function syncAuthProfile(nextAuth: AuthState, sourceConfig: AppConfig) {
    const email = nextAuth.email?.trim().toLowerCase();
    if (!nextAuth.signedIn || !email) {
      return;
    }

    const existing = sourceConfig.accounts.find((account) => emailsMatch(email, account.email));
    const nextConfig = existing
      ? await api.markAccountUsed(existing.id)
      : await api.upsertAccount({
          id: "",
          email,
          displayName: nextAuth.name?.trim() || email.split("@")[0] || email,
          defaultDownloadDir: "",
          notes: "",
          lastUsedAt: null
        }).then((createdConfig) => {
          const created = createdConfig.accounts.find((account) => emailsMatch(email, account.email));
          return created ? api.markAccountUsed(created.id) : createdConfig;
        });

    setConfig(nextConfig);
  }

  async function chooseBinary() {
    const path = await api.pickBinaryFile();
    if (!path) {
      return;
    }
    await saveBinaryPath(path);
  }

  async function saveBinaryPath(path = binaryPath) {
    if (!path.trim()) {
      showAlert("请选择 ipatool 二进制路径");
      return;
    }
    setBusy(true);
    try {
      const status = await api.setBinaryPath(path.trim());
      setBinary(status);
      setBinaryPath(path.trim());
      if (!status.ok) {
        showAlert(status.error ?? "二进制校验失败");
      }
    } catch (error) {
      showAlert(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDownloadDir() {
    try {
      const path = await api.pickDownloadDir();
      if (!path) {
        return;
      }
      const nextConfig = await api.setDownloadDir(path);
      setConfig(nextConfig);
    } catch (error) {
      showAlert(errorMessage(error));
    }
  }

  async function openDownloadDir() {
    const path = config.downloadDir?.trim();
    if (!path) {
      showAlert("请先选择下载目录");
      return;
    }
    try {
      await api.openDirectory(path);
    } catch (error) {
      showAlert(errorMessage(error));
    }
  }

  async function saveAccountAndLogin(event: FormEvent) {
    event.preventDefault();
    if (ptySessionId && promptKind) {
      await submitPromptInput();
      return;
    }
    if (pendingSwitchTarget && !ptySessionId) {
      requestSwitchConfirmation(pendingSwitchTarget);
      return;
    }
    if (!accountDraft.email.trim()) {
      showAlert("请输入邮箱");
      return;
    }
    if (!binary.ok) {
      showAlert("请先配置可用的 ipatool 二进制");
      setView("settings");
      return;
    }

    setBusy(true);
    setAccountBusy(true);
    setAccountStatus("正在保存账户档案");
    try {
      const normalizedEmail = accountDraft.email.trim().toLowerCase();
      const existing = config.accounts.find((account) => emailsMatch(normalizedEmail, account.email));
      const nextConfig = await api.upsertAccount({
        id: existing?.id ?? "",
        email: normalizedEmail,
        displayName:
          accountDraft.displayName.trim() ||
          existing?.displayName ||
          normalizedEmail.split("@")[0] ||
          normalizedEmail,
        defaultDownloadDir: "",
        notes: accountDraft.notes.trim() || existing?.notes || "",
        lastUsedAt: existing?.lastUsedAt ?? null
      });
      setConfig(nextConfig);
      const target = nextConfig.accounts.find((account) => emailsMatch(normalizedEmail, account.email));
      if (!target) {
        showAlert("账户档案保存失败");
        return;
      }
      setAccountStatus("账户档案已保存，正在准备登录");
      await api.setSelectedAccount(target.id);
      setConfig({ ...nextConfig, selectedAccountId: target.id });

      if (emailsMatch(auth.email, target.email)) {
        const marked = await api.markAccountUsed(target.id);
        setConfig(marked);
        setModalOpen(false);
        return;
      }

      if (auth.signedIn) {
        setPendingSwitchTarget(target);
        setAccountStatus(`当前 ipatool 已登录 ${auth.email ?? "其他账户"}。确认后会先退出当前登录，再登录 ${target.email}。`);
        requestSwitchConfirmation(target);
        return;
      }

      await startLogin(target);
    } catch (error) {
      showAlert(errorMessage(error));
    } finally {
      setBusy(false);
      setAccountBusy(false);
    }
  }

  function requestSwitchConfirmation(profile: AccountProfile) {
    setConfirmDialog({
      title: "确认切换账户",
      message: `当前 ipatool 已登录 ${auth.email ?? "其他账户"}。继续后会先退出当前登录，再登录 ${profile.email}。`,
      confirmLabel: "退出并继续",
      cancelLabel: "取消",
      onConfirm: () => confirmSwitchAndLogin(profile)
    });
  }

  async function confirmSwitchAndLogin(profile: AccountProfile) {
    setBusy(true);
    setAccountBusy(true);
    setAccountStatus("正在切换账户");
    try {
      const revoked = await api.revokeAuth();
      setLastDiagnostic(revoked.diagnostic);
      setAuth({ ...emptyAuth, error: "已退出登录" });
      setPendingSwitchTarget(null);
      await startLogin(profile);
    } catch (error) {
      showAlert(errorMessage(error));
    } finally {
      setBusy(false);
      setAccountBusy(false);
    }
  }

  async function startLogin(profile: AccountProfile) {
    const sessionId = createSessionId("login");
    ptyLogRef.current = "";
    setPtySessionId(sessionId);
    setPtyMode("login");
    setLoginTargetId(profile.id);
    loginTargetRef.current = profile;
    setPromptKind(null);
    setAccountStatus("正在启动 ipatool 登录命令");
    try {
      await api.startPty({
        sessionId,
        kind: "login",
        email: profile.email,
        args: null
      });
    } catch (error) {
      setPtySessionId(null);
      setPtyMode(null);
      setLoginTargetId(null);
      loginTargetRef.current = null;
      setPromptKind(null);
      throw error;
    }
  }

  async function closeAccountModal() {
    if (ptySessionId) {
      await api.stopPty(ptySessionId).catch(() => undefined);
    }
    setPtySessionId(null);
    setPtyMode(null);
    setPromptKind(null);
    setLoginTargetId(null);
    loginTargetRef.current = null;
    setPendingSwitchTarget(null);
    setAccountStatus("");
    setAccountDraft({ email: "", displayName: "", notes: "", secret: "" });
    setModalOpen(false);
  }

  async function submitPromptInput() {
    if (!ptySessionId || !promptKind) {
      return;
    }
    const value = accountDraft.secret;
    if (!value) {
      showAlert(promptKind === "twoFactor" ? "请输入双重认证码" : "请输入 Apple ID 密码");
      return;
    }
    await api.sendPtyInput(ptySessionId, value, true);
    setAccountDraft((current) => ({ ...current, secret: "" }));
    setPromptKind(null);
  }

  async function handlePtyEvent(event: PtyEvent) {
    if (ptySessionId && event.sessionId !== ptySessionId) {
      return;
    }
    if (event.event === "output" && event.data) {
      ptyLogRef.current = trimLog(`${ptyLogRef.current}${event.data}`);
    }
    if (event.event === "prompt") {
      setPromptKind(event.prompt ?? null);
      setAccountStatus(event.prompt === "twoFactor" ? "请输入双重认证码" : "请输入 Apple ID 密码");
    }
    if (event.event === "error") {
      showAlert(`终端会话错误：${event.data ?? ""}`);
    }
    if (event.event === "exit") {
      setLastDiagnostic({
        command: [ptyMode === "download" ? "ipatool download" : "ipatool auth login"],
        exitCode: event.exitCode ?? null,
        stdout: ptyLogRef.current,
        stderr: "",
        durationMs: event.durationMs ?? 0
      });
      if (ptyMode === "login") {
        await verifyLogin(event.exitCode ?? null);
      } else {
        const code = event.exitCode ?? null;
        if (code === 0) {
          try {
            await recordDownloadSuccess();
          } catch (error) {
            showAlert(`下载已完成，但写入历史记录失败：${errorMessage(error)}`);
          }
        } else {
          downloadContextRef.current = null;
          showAlert(`命令退出码 ${event.exitCode ?? "unknown"}`);
        }
      }
      setPtySessionId(null);
      setPtyMode(null);
      setPromptKind(null);
    }
  }

  async function verifyLogin(exitCode: number | null) {
    const target =
      loginTargetRef.current ?? config.accounts.find((account) => account.id === loginTargetId);
    setLoginTargetId(null);
    loginTargetRef.current = null;
    if (exitCode !== 0 || !target) {
      const message = loginFailureMessage(exitCode, ptyLogRef.current);
      setAuth({ ...emptyAuth, error: message });
      setAccountDraft((current) => ({ ...current, secret: "" }));
      showAlert(message);
      return;
    }
    const nextAuth = await api.refreshAuthInfo();
    setAuth(nextAuth);
    setLastDiagnostic(nextAuth.diagnostic ?? null);
    if (emailsMatch(nextAuth.email, target.email)) {
      const marked = await api.markAccountUsed(target.id);
      setConfig(marked);
      setAccountDraft({ email: "", displayName: "", notes: "", secret: "" });
      setModalOpen(false);
      setAccountStatus("");
    } else {
      const detail = nextAuth.error ?? summarizePtyFailure(ptyLogRef.current);
      showAlert(detail ? `登录校验失败：${detail}` : "选中的账户档案与当前 ipatool 登录态不一致");
    }
  }

  async function selectAccount(profile: AccountProfile) {
    setAccountDraft({
      email: profile.email,
      displayName: profile.displayName,
      notes: profile.notes,
      secret: ""
    });
    if (!binary.ok) {
      showAlert("请先配置可用的 ipatool 二进制");
      setModalOpen(true);
      return;
    }
    const nextConfig = await api.setSelectedAccount(profile.id);
    setConfig(nextConfig);
    if (emailsMatch(auth.email, profile.email)) {
      const marked = await api.markAccountUsed(profile.id);
      setConfig(marked);
      return;
    }
    setModalOpen(true);
  }

  function commandPreflight() {
    if (!binary.ok) {
      showAlert("请先配置可用的 ipatool 二进制");
      setView("settings");
      return false;
    }
    if (!selectedAccount) {
      showAlert("请先选择账户档案");
      setModalOpen(true);
      return false;
    }
    if (!auth.signedIn) {
      showAlert("请先登录再执行 ipatool 命令");
      setModalOpen(true);
      return false;
    }
    if (!emailsMatch(auth.email, selectedAccount.email)) {
      showAlert("选中的账户档案与当前 ipatool 登录态不一致");
      setModalOpen(true);
      return false;
    }
    return true;
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    if (!searchTerm.trim()) {
      showAlert("请输入搜索关键词");
      return;
    }
    if (!commandPreflight()) {
      return;
    }
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setBusy(true);
    setSearchLoading(true);
    setApps([]);
    await waitForPaint();
    try {
      const output = await api.runSearch(searchTerm.trim(), "", 10);
      if (searchRequestRef.current !== requestId) {
        return;
      }
      setLastDiagnostic(output.diagnostic);
      const nextApps = extractApps(output.json);
      setApps(nextApps.length ? nextApps : []);
      const countryHints = lookupCountryHints(output.json, auth.countryCode);
      void enrichAppsFromLookup(nextApps, countryHints).then((enriched) => {
        if (enriched && searchRequestRef.current === requestId) {
          setApps(enriched);
        }
      });
    } catch (error) {
      if (searchRequestRef.current === requestId) {
        showAlert(errorMessage(error));
      }
    } finally {
      if (searchRequestRef.current === requestId) {
        setBusy(false);
        setSearchLoading(false);
      }
    }
  }

  function openDetails(app: AppRecord) {
    const requestId = detailsRequestRef.current + 1;
    detailsRequestRef.current = requestId;
    setSelectedApp(app);
    setVersions([]);
    setVersionMetadata({});
    setDetailsLoading(true);
    setView("details");
    if (!commandPreflight()) {
      setDetailsLoading(false);
      return;
    }
    setDetailsLoadRequest({ id: requestId, app });
  }

  async function loadVersionMetadata(version: VersionRecord) {
    if (!selectedApp) {
      return;
    }
    const versionId = version.externalVersionId || version.versionId;
    if (!hasDisplayValue(versionId)) {
      showAlert("当前行没有可查询的版本 ID");
      return;
    }
    if (!commandPreflight()) {
      return;
    }
    const current = versionMetadata[versionId];
    if (current?.loading || current?.versionName) {
      return;
    }

    setVersionMetadata((items) => ({
      ...items,
      [versionId]: { ...items[versionId], loading: true }
    }));
    await waitForPaint();
    try {
      const output = await api.runGetVersionMetadata(selectedApp.bundleId, versionId);
      setLastDiagnostic(output.diagnostic);
      const versionName = output.versionName?.trim() ?? "";
      if (!versionName) {
        setVersionMetadata((items) => ({
          ...items,
          [versionId]: { loading: false }
        }));
        showAlert(`未获取到版本 ID ${versionId} 对应的实际版本号`);
        return;
      }
      setVersionMetadata((items) => ({
        ...items,
        [versionId]: { versionName, loading: false }
      }));
    } catch (error) {
      setVersionMetadata((items) => ({
        ...items,
        [versionId]: { ...items[versionId], loading: false }
      }));
      showAlert(errorMessage(error));
    }
  }

  async function startDownload(context: DownloadContext) {
    if (!commandPreflight()) {
      return;
    }
    const bundleId = context.bundleId.trim();
    if (!bundleId) {
      showAlert("下载记录缺少 Bundle ID");
      return;
    }
    const args = ["download", "--bundle-identifier", bundleId, "--format", "json", "--purchase"];
    const externalVersionId = cleanDisplayValue(context.externalVersionId);
    if (externalVersionId) {
      args.push("--external-version-id", externalVersionId);
    }
    const outputDir = config.downloadDir?.trim() || "";
    if (outputDir) {
      args.push("--output", outputDir);
    }
    const sessionId = createSessionId("download");
    ptyLogRef.current = "";
    downloadContextRef.current = {
      ...context,
      bundleId,
      externalVersionId,
      accountId: selectedAccount?.id ?? context.accountId ?? null,
      accountEmail: selectedAccount?.email ?? context.accountEmail ?? null,
      outputPath: outputDir || context.outputPath || null
    };
    setPtySessionId(sessionId);
    setPtyMode("download");
    try {
      await api.startPty({ sessionId, kind: "download", email: null, args });
    } catch (error) {
      showAlert(errorMessage(error));
      downloadContextRef.current = null;
      setPtySessionId(null);
      setPtyMode(null);
    }
  }

  async function recordDownloadSuccess() {
    const context = downloadContextRef.current;
    downloadContextRef.current = null;
    if (!context) {
      return;
    }

    const nextConfig = await api.recordDownloadHistory({
      id: "",
      appName: context.appName || context.bundleId,
      bundleId: context.bundleId,
      appIconUrl: context.appIconUrl ?? null,
      versionName: context.versionName ?? null,
      externalVersionId: context.externalVersionId ?? null,
      accountId: context.accountId ?? null,
      accountEmail: context.accountEmail ?? null,
      outputPath: context.outputPath ?? null,
      downloadedAt: ""
    });
    setConfig(nextConfig);
  }

  async function redownloadFromHistory(item: DownloadHistoryItem) {
    await startDownload({
      appName: item.appName,
      bundleId: item.bundleId,
      appIconUrl: item.appIconUrl ?? null,
      versionName: item.versionName ?? null,
      externalVersionId: item.externalVersionId ?? null,
      accountId: item.accountId ?? null,
      accountEmail: item.accountEmail ?? null,
      outputPath: item.outputPath ?? null
    });
  }

  function deleteDownloadHistory(item: DownloadHistoryItem) {
    setConfirmDialog({
      title: "删除下载记录",
      message: `仅删除「${item.appName || item.bundleId}」这条本地历史记录，不会删除已下载文件。`,
      confirmLabel: "删除",
      cancelLabel: "取消",
      onConfirm: async () => {
        const nextConfig = await api.deleteDownloadHistory(item.id);
        setConfig(nextConfig);
      }
    });
  }

  function clearDownloadHistory() {
    if (!config.downloadHistory.length) {
      return;
    }
    setConfirmDialog({
      title: "清空下载历史",
      message: "只清空本应用记录的下载历史，不会删除已下载文件或账户档案。",
      confirmLabel: "清空",
      cancelLabel: "取消",
      onConfirm: async () => {
        const nextConfig = await api.clearDownloadHistory();
        setConfig(nextConfig);
      }
    });
  }

  function showAlert(message: string, title = "操作失败") {
    setAlert({ title, message });
  }

  async function confirmActiveDialog() {
    if (!confirmDialog) {
      return;
    }
    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  const binaryReady = binary.ok;

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="sidebarTop">
          <div className="brand">
            <img className="brandIcon" src={appLogoUrl} alt="" />
            <div>
              <h1>IPA 管理器</h1>
              <p>{binary.version || "v1.0.0"}</p>
            </div>
          </div>

          <button
            className="primaryButton fullWidth"
            onClick={() => {
              setAccountDraft({ email: "", displayName: "", notes: "", secret: "" });
              setAccountStatus("");
              setModalOpen(true);
            }}
          >
            <span className="material-symbols-outlined">person_add</span>
            新增账户
          </button>

          <nav className="navList" aria-label="主导航">
            <NavButton
              active={view === "search"}
              icon="search"
              label="应用搜索"
              onClick={showSearchView}
            />
            <NavButton
              active={view === "details"}
              icon="info"
              label="应用详情"
              onClick={() => setView("details")}
            />
            <NavButton
              active={view === "history"}
              icon="history"
              label="下载历史"
              onClick={() => setView("history")}
            />
          </nav>

          <section>
            <h2 className="sectionKicker">账户列表</h2>
            <div className="accountList">
              {config.accounts.length === 0 && <p className="emptyInlineText">暂无账户档案</p>}
              {config.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  initials={initialsFor(account)}
                  email={account.email}
                  active={emailsMatch(auth.email, account.email)}
                  selected={account.id === selectedAccount?.id}
                  onClick={() => void selectAccount(account)}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="sidebarFooter">
          <NavButton
            active={view === "settings"}
            icon="settings"
            label="设置"
            onClick={() => setView("settings")}
          />
        </div>
      </aside>

      <section className="mainPane">
        <TopBar binaryReady={binaryReady} />
        <div className="contentCanvas">
          {view === "search" && (
            <SearchView
              apps={apps}
              loading={searchLoading}
              searchTerm={searchTerm}
              onDetails={(app) => void openDetails(app)}
              onDownload={(app) => void openDetails(app)}
              onSearch={(event) => void runSearch(event)}
              setSearchTerm={setSearchTerm}
            />
          )}
          {view === "details" && selectedApp && (
            <DetailsView
              app={selectedApp}
              versions={versions}
              loading={detailsLoading}
              versionMetadata={versionMetadata}
              onLoadVersionMetadata={(version) => void loadVersionMetadata(version)}
              onBack={showSearchView}
              onDownload={(version) => {
                const versionId = version.externalVersionId || version.versionId;
                void startDownload({
                  appName: selectedApp.name,
                  bundleId: selectedApp.bundleId,
                  appIconUrl: selectedApp.iconUrl ?? null,
                  versionName: versionMetadata[versionId]?.versionName || version.versionName,
                  externalVersionId: hasDisplayValue(versionId) ? versionId : null
                });
              }}
            />
          )}
          {view === "details" && !selectedApp && (
            <EmptyDetailsView onBack={showSearchView} />
          )}
          {view === "history" && (
            <DownloadHistoryView
              history={config.downloadHistory}
              downloadDir={config.downloadDir ?? ""}
              onClear={() => void clearDownloadHistory()}
              onChooseDownloadDir={() => void chooseDownloadDir()}
              onDelete={(item) => void deleteDownloadHistory(item)}
              onOpenDownloadDir={() => void openDownloadDir()}
              onRedownload={(item) => void redownloadFromHistory(item)}
            />
          )}
          {view === "settings" && (
            <SettingsView
              auth={auth}
              binary={binary}
              binaryPath={binaryPath}
              downloadDir={config.downloadDir ?? ""}
              setBinaryPath={setBinaryPath}
              onChoose={() => void chooseBinary()}
              onChooseDownloadDir={() => void chooseDownloadDir()}
              onOpenDownloadDir={() => void openDownloadDir()}
              onRefresh={() => void refreshAuthInfo()}
              onSave={() => void saveBinaryPath()}
            />
          )}
        </div>
      </section>

      {modalOpen && (
        <AccountModal
          draft={accountDraft}
          promptKind={promptKind}
          loginPending={ptyMode === "login" && Boolean(ptySessionId)}
          switchPending={Boolean(pendingSwitchTarget)}
          busy={accountBusy}
          statusText={accountStatus}
          onChange={setAccountDraft}
          onClose={() => void closeAccountModal()}
          onSubmit={(event) => void saveAccountAndLogin(event)}
        />
      )}
      {alert && <AlertDialog alert={alert} onClose={() => setAlert(null)} />}
      {confirmDialog && (
        <ConfirmDialog
          confirm={confirmDialog}
          busy={confirmBusy}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={() => void confirmActiveDialog()}
        />
      )}
    </main>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`navItem ${active ? "active" : ""}`} onClick={onClick}>
      <span className="material-symbols-outlined">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function AccountRow({
  initials,
  email,
  active = false,
  selected = false,
  muted = false,
  onClick
}: {
  initials: string;
  email: string;
  active?: boolean;
  selected?: boolean;
  muted?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`accountRow ${active ? "online" : ""} ${selected ? "selected" : ""}`}
      disabled={muted}
      onClick={onClick}
    >
      <span className="avatar">{initials}</span>
      <span className="accountEmail">{email}</span>
      <span className="presence" />
    </button>
  );
}

function TopBar({
  binaryReady
}: {
  binaryReady: boolean;
}) {
  return (
    <header className="topBar">
      <div className="topStatus">
        <span className="labelText">IPATool 状态:</span>
        <span className={`statusPill ${binaryReady ? "success" : ""}`}>
          <span />
          {binaryReady ? "就绪" : "未配置"}
        </span>
      </div>
    </header>
  );
}

function SearchView({
  apps,
  loading,
  searchTerm,
  setSearchTerm,
  onSearch,
  onDetails,
  onDownload
}: {
  apps: AppRecord[];
  loading: boolean;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onDetails: (app: AppRecord) => void;
  onDownload: (app: AppRecord) => void;
}) {
  return (
    <section className="searchView">
      <form className="searchHero" onSubmit={onSearch}>
        <h2>探索应用程序</h2>
        <div className="searchBox">
          <span className="material-symbols-outlined">search</span>
          <input
            value={searchTerm}
            aria-label="搜索应用"
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          <button className="primaryButton" disabled={loading} type="submit">
            {loading ? "搜索中" : "搜索"}
          </button>
        </div>
        <p>搜索、购买、版本列表和下载都会使用当前选中的 Apple ID 档案。</p>
      </form>

      <section className="resultsHeader">
        <h3>找到 {apps.length} 条结果</h3>
      </section>

      <div className="resultList">
        {loading ? (
          <SearchSkeleton />
        ) : (
          <>
            {apps.length === 0 && <p className="emptyStateText">暂无搜索结果</p>}
            {apps.map((app) => (
              <article className="resultCard" key={app.bundleId} onDoubleClick={() => onDetails(app)}>
                {app.iconUrl ? (
                  <img src={app.iconUrl} alt="" className="appIcon" />
                ) : (
                  <span className="appIcon appIconEmpty material-symbols-outlined">apps</span>
                )}
                <div className="resultGrid">
                  <button className="resultName plainButton" onClick={() => onDetails(app)}>
                    <h4>{app.name}</h4>
                    <code>{app.bundleId}</code>
                  </button>
                  <Metric label="版本" value={app.version} />
                  <Metric label="Bundle ID" value={app.bundleId} />
                  <Metric label="价格" value={app.price} align="right" />
                  <button className="downloadButton" onClick={() => onDownload(app)}>
                    <span className="material-symbols-outlined">download</span>
                    获取 IPA
                  </button>
                </div>
              </article>
            ))}
          </>
        )}
      </div>

    </section>
  );
}

function SearchSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <article className="resultCard skeletonCard" key={index} aria-hidden="true">
          <span className="appIcon skeletonBlock" />
          <div className="resultGrid">
            <div className="skeletonStack">
              <span className="skeletonLine wide" />
              <span className="skeletonLine medium" />
            </div>
            <div className="skeletonStack">
              <span className="skeletonLine short" />
              <span className="skeletonLine medium" />
            </div>
            <div className="skeletonStack">
              <span className="skeletonLine short" />
              <span className="skeletonLine wide" />
            </div>
            <div className="skeletonStack">
              <span className="skeletonLine short" />
              <span className="skeletonLine medium" />
            </div>
            <span className="skeletonButton" />
          </div>
        </article>
      ))}
    </>
  );
}

function Metric({
  label,
  value,
  align = "left"
}: {
  label: string;
  value: string;
  align?: "left" | "right";
}) {
  return (
    <div className={`metric ${align === "right" ? "alignRight" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailsView({
  app,
  versions,
  loading,
  versionMetadata,
  onLoadVersionMetadata,
  onBack,
  onDownload
}: {
  app: AppRecord;
  versions: VersionRecord[];
  loading: boolean;
  versionMetadata: Record<string, VersionMetadataState>;
  onLoadVersionMetadata: (version: VersionRecord) => void;
  onBack: () => void;
  onDownload: (version: VersionRecord) => void;
}) {
  const showReleaseDate = loading || versions.some((item) => hasDisplayValue(item.date));

  return (
    <section className="detailsView">
      <div className="detailHeader">
        <button className="iconButton" onClick={onBack} aria-label="返回">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        {app.iconUrl ? (
          <img src={app.iconUrl} alt="" className="detailIcon" />
        ) : (
          <span className="detailIcon appIconEmpty material-symbols-outlined">apps</span>
        )}
        <div>
          <h2>{app.name}</h2>
          <code>{app.bundleId}</code>
        </div>
      </div>

      <section className="tablePanel">
        <div className="panelTitle">
          <h3>历史版本</h3>
        </div>
        <div className={`versionTable ${showReleaseDate ? "" : "withoutReleaseDate"}`}>
          <table aria-label="历史版本">
            <colgroup>
              <col className="versionIdColumn" />
              <col className="versionNameColumn" />
              {showReleaseDate && <col className="dateColumn" />}
              <col className="platformColumn" />
              <col className="archColumn" />
              <col className="actionColumn" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">版本 ID</th>
                <th scope="col">实际版本号</th>
                {showReleaseDate && <th scope="col">发布日期</th>}
                <th scope="col">平台</th>
                <th scope="col">架构</th>
                <th scope="col" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {loading && <VersionSkeletonRows showReleaseDate={showReleaseDate} />}
              {!loading && versions.length === 0 && (
                <tr>
                  <td className="emptyStateCell" colSpan={showReleaseDate ? 6 : 5}>
                    暂无版本数据
                  </td>
                </tr>
              )}
              {!loading && versions.map((item, index) => {
                const versionId = item.externalVersionId || item.versionId;
                const metadata = versionMetadata[versionId];
                return (
                  <tr key={`${versionId}-${item.versionName}-${index}`}>
                    <td>
                      <span className="versionCell">
                        <strong>{versionId}</strong>
                        {item.badge && <em>{item.badge}</em>}
                      </span>
                    </td>
                    <td>
                      {metadata?.versionName ? (
                        <strong className="resolvedVersionName">{metadata.versionName}</strong>
                      ) : (
                        <button
                          className="secondarySmall"
                          type="button"
                          disabled={metadata?.loading || !hasDisplayValue(versionId)}
                          onClick={() => onLoadVersionMetadata(item)}
                        >
                          {metadata?.loading ? "获取中" : "获取"}
                        </button>
                      )}
                    </td>
                    {showReleaseDate && <td>{item.date}</td>}
                    <td>{item.platform}</td>
                    <td>{item.arch}</td>
                    <td>
                      <button
                        className={item.badge ? "primarySmall" : "secondarySmall"}
                        type="button"
                        onClick={() => onDownload(item)}
                      >
                        <span className="material-symbols-outlined">download</span>
                        下载
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function VersionSkeletonRows({ showReleaseDate }: { showReleaseDate: boolean }) {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <tr className="versionSkeletonRow" key={index} aria-hidden="true">
          <td>
            <span className="skeletonLine medium" />
          </td>
          <td>
            <span className="skeletonButton small" />
          </td>
          {showReleaseDate && (
            <td>
              <span className="skeletonLine medium" />
            </td>
          )}
          <td>
            <span className="skeletonLine short" />
          </td>
          <td>
            <span className="skeletonLine short" />
          </td>
          <td>
            <span className="skeletonButton small" />
          </td>
        </tr>
      ))}
    </>
  );
}

function EmptyDetailsView({ onBack }: { onBack: () => void }) {
  return (
    <section className="detailsView">
      <div className="detailHeader">
        <button className="iconButton" onClick={onBack} aria-label="返回">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="detailIcon appIconEmpty material-symbols-outlined">info</span>
        <div>
          <h2>未选择应用</h2>
          <code>请先从搜索结果进入应用详情</code>
        </div>
      </div>
    </section>
  );
}

function DownloadHistoryView({
  history,
  downloadDir,
  onRedownload,
  onDelete,
  onClear,
  onChooseDownloadDir,
  onOpenDownloadDir
}: {
  history: DownloadHistoryItem[];
  downloadDir: string;
  onRedownload: (item: DownloadHistoryItem) => void;
  onDelete: (item: DownloadHistoryItem) => void;
  onClear: () => void;
  onChooseDownloadDir: () => void;
  onOpenDownloadDir: () => void;
}) {
  return (
    <section className="historyView">
      <div className="pageIntro historyIntro">
        <div>
          <h2>下载历史</h2>
          <p>仅记录通过本应用成功启动并完成的下载。</p>
        </div>
        <button className="secondaryButton" type="button" disabled={!history.length} onClick={onClear}>
          清空历史
        </button>
      </div>

      <DownloadDirectoryPanel
        downloadDir={downloadDir}
        compact
        onChoose={onChooseDownloadDir}
        onOpen={onOpenDownloadDir}
      />

      <section className="tablePanel historyPanel">
        <div className="panelTitle">
          <span className="material-symbols-outlined panelIcon">history</span>
          <h3>本应用下载记录</h3>
        </div>
        {history.length === 0 ? (
          <p className="emptyStateText">暂无通过本应用完成的下载记录</p>
        ) : (
          <div className="historyList">
            {history.map((item) => (
              <article className="historyRow" key={item.id}>
                {item.appIconUrl ? (
                  <img className="appIcon" src={item.appIconUrl} alt="" />
                ) : (
                  <span className="appIcon appIconEmpty material-symbols-outlined">apps</span>
                )}
                <div className="historyMain">
                  <h4>{item.appName || item.bundleId}</h4>
                  <code>{item.bundleId}</code>
                  <div className="historyMeta">
                    <span>{formatHistoryVersion(item)}</span>
                    <span>{formatHistoryTime(item.downloadedAt)}</span>
                    <span>{item.accountEmail || "未记录账户"}</span>
                    <span>{item.outputPath || "ipatool 默认目录"}</span>
                  </div>
                </div>
                <div className="historyActions">
                  <button className="primarySmall" type="button" onClick={() => onRedownload(item)}>
                    <span className="material-symbols-outlined">download</span>
                    重新下载
                  </button>
                  <button className="secondarySmall" type="button" onClick={() => onDelete(item)}>
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function SettingsView({
  auth,
  binary,
  binaryPath,
  downloadDir,
  setBinaryPath,
  onChoose,
  onChooseDownloadDir,
  onOpenDownloadDir,
  onRefresh,
  onSave
}: {
  auth: AuthState;
  binary: BinaryStatus;
  binaryPath: string;
  downloadDir: string;
  setBinaryPath: (value: string) => void;
  onChoose: () => void;
  onChooseDownloadDir: () => void;
  onOpenDownloadDir: () => void;
  onRefresh: () => void;
  onSave: () => void;
}) {
  return (
    <section className="settingsView">
      <div className="pageIntro">
        <h2>设置</h2>
        <p>管理您的 IPA 工具配置和全局首选项。</p>
      </div>

      <section className="settingsPanel">
        <div className="panelTitle">
          <span className="material-symbols-outlined panelIcon">terminal</span>
          <h3>IPATool 配置</h3>
        </div>
        <label className="fieldLabel" htmlFor="binary-path">
          二进制路径
        </label>
        <div className="pathField">
          <input
            id="binary-path"
            value={binaryPath}
            placeholder="选择或粘贴 ipatool 路径"
            onChange={(event) => setBinaryPath(event.target.value)}
          />
          <button className="secondaryButton" onClick={onChoose}>
            浏览
          </button>
        </div>
        <p className="helperText">{binary.ok ? "指定您系统中 ipatool 可执行文件的位置。" : binary.error ?? "请配置 ipatool 二进制。"}</p>
      </section>

      <DownloadDirectoryPanel
        downloadDir={downloadDir}
        onChoose={onChooseDownloadDir}
        onOpen={onOpenDownloadDir}
      />

      <section className="settingsPanel">
        <div className="panelTitle">
          <span className="material-symbols-outlined panelIcon">tune</span>
          <h3>通用</h3>
        </div>
        <div className="settingRow">
          <span className="material-symbols-outlined">monitor_heart</span>
          <div>
            <h4>当前登录</h4>
            <p>{auth.signedIn ? auth.email : "未登录"}</p>
          </div>
          <span className={`toggle ${auth.signedIn ? "on" : ""}`} aria-hidden="true" />
        </div>
        <div className="settingsActions">
          <button className="secondaryButton" onClick={onRefresh}>
            刷新
          </button>
          <button className="primaryButton" onClick={onSave}>
            保存更改
          </button>
        </div>
      </section>
    </section>
  );
}

function DownloadDirectoryPanel({
  downloadDir,
  compact = false,
  onChoose,
  onOpen
}: {
  downloadDir: string;
  compact?: boolean;
  onChoose: () => void;
  onOpen: () => void;
}) {
  return (
    <section className={`settingsPanel downloadDirPanel ${compact ? "compact" : ""}`}>
      <div className="panelTitle">
        <span className="material-symbols-outlined panelIcon">folder_open</span>
        <h3>下载目录</h3>
      </div>
      <label className="fieldLabel" htmlFor={compact ? "history-download-dir" : "settings-download-dir"}>
        IPA 保存位置
      </label>
      <div className="pathField wideActions">
        <input
          id={compact ? "history-download-dir" : "settings-download-dir"}
          value={downloadDir || "未设置，默认使用账户下载目录或 ipatool 默认目录"}
          readOnly
        />
        <button className="secondaryButton" type="button" onClick={onChoose}>
          选择目录
        </button>
        <button className="primaryButton" type="button" disabled={!downloadDir} onClick={onOpen}>
          打开目录
        </button>
      </div>
      <p className="helperText">
        {downloadDir
          ? "后续通过本应用下载的 IPA 会保存到此目录，下载历史也会记录该目录。"
          : "选择目录后，后续通过本应用下载的 IPA 会统一保存到指定位置。"}
      </p>
    </section>
  );
}

function AccountModal({
  draft,
  promptKind,
  loginPending,
  switchPending,
  busy,
  statusText,
  onChange,
  onClose,
  onSubmit
}: {
  draft: AccountDraft;
  promptKind: PromptKind;
  loginPending: boolean;
  switchPending: boolean;
  busy: boolean;
  statusText: string;
  onChange: (draft: AccountDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const secretLabel = promptKind === "twoFactor" ? "双重认证码" : "密码";
  return (
    <div className="modalLayer" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <form className="accountModal" noValidate onSubmit={onSubmit}>
        <header>
          <h3 id="modal-title">新增 Apple ID</h3>
          <button className="iconButton" type="button" onClick={onClose} aria-label="关闭">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>
        <div className="securityNote">
          <span className="material-symbols-outlined">lock</span>
          <p>
            {switchPending
              ? "切换账户会覆盖当前 ipatool 登录态。确认后会先退出当前登录，再启动目标账户登录。"
              : loginPending
              ? "已启动 ipatool 登录命令，正在等待密码或 2FA 提示。"
              : "先保存本地账号档案，再由 ipatool 提示时输入密码或 2FA。下载目录使用设置页的全局配置。"}
          </p>
        </div>
        <label className="fieldLabel" htmlFor="apple-id">
          Apple ID (邮箱)
        </label>
        <input
          id="apple-id"
          placeholder="name@example.com"
          type="email"
          value={draft.email}
          onChange={(event) => onChange({ ...draft, email: event.target.value })}
        />
        <label className="fieldLabel" htmlFor="display-name">
          显示名称
        </label>
        <input
          id="display-name"
          placeholder="用于本地识别"
          value={draft.displayName}
          onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
        />
        <label className="fieldLabel" htmlFor="notes">
          备注
        </label>
        <input
          id="notes"
          placeholder="可选"
          value={draft.notes}
          onChange={(event) => onChange({ ...draft, notes: event.target.value })}
        />
        {promptKind && (
          <>
            <label className="fieldLabel" htmlFor="secret-input">
              {secretLabel}
            </label>
            <input
              id="secret-input"
              autoFocus
              placeholder={promptKind === "twoFactor" ? "输入 2FA code" : "按提示输入，不会保存"}
              type={promptKind === "twoFactor" ? "text" : "password"}
              value={draft.secret}
              onChange={(event) => onChange({ ...draft, secret: event.target.value })}
            />
          </>
        )}
        {statusText && <p className="modalStatus">{statusText}</p>}
        <footer>
          <button className="secondaryButton" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primaryButton" disabled={busy || (loginPending && !promptKind)} type="submit">
            {promptKind
              ? "发送"
              : busy
                ? "处理中"
                : switchPending
                  ? "确认切换并登录"
                  : loginPending
                    ? "等待提示"
                    : "保存并登录"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function AlertDialog({ alert, onClose }: { alert: AlertState; onClose: () => void }) {
  return (
    <div className="modalLayer noticeLayer" role="presentation">
      <section className="noticeDialog alertDialog" role="alertdialog" aria-modal="true" aria-labelledby="alert-title">
        <header>
          <span className="noticeIcon material-symbols-outlined">error</span>
          <div>
            <h3 id="alert-title">{alert.title}</h3>
            <p>{alert.message}</p>
          </div>
        </header>
        <footer>
          <button className="primaryButton" type="button" onClick={onClose}>
            知道了
          </button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmDialog({
  confirm,
  busy,
  onCancel,
  onConfirm
}: {
  confirm: ConfirmState;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modalLayer noticeLayer" role="presentation">
      <section className="noticeDialog confirmDialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <header>
          <span className="noticeIcon material-symbols-outlined">help</span>
          <div>
            <h3 id="confirm-title">{confirm.title}</h3>
            <p>{confirm.message}</p>
          </div>
        </header>
        <footer>
          <button className="secondaryButton" disabled={busy} type="button" onClick={onCancel}>
            {confirm.cancelLabel ?? "取消"}
          </button>
          <button className="primaryButton" disabled={busy} type="button" onClick={onConfirm}>
            {busy ? "处理中" : confirm.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function emailsMatch(activeEmail: string | null | undefined, profileEmail: string) {
  return activeEmail?.trim().toLowerCase() === profileEmail.trim().toLowerCase();
}

function initialsFor(profile: AccountProfile) {
  const source = profile.displayName || profile.email;
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function createSessionId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function trimLog(value: string) {
  return value.length > 8000 ? value.slice(value.length - 8000) : value;
}

function cleanDisplayValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "-" ? trimmed : "";
}

function formatHistoryVersion(item: DownloadHistoryItem) {
  const versionName = cleanDisplayValue(item.versionName);
  const versionId = cleanDisplayValue(item.externalVersionId);
  if (versionName && versionId) {
    return `${versionName} · ${versionId}`;
  }
  return versionName || versionId || "当前版本";
}

function formatHistoryTime(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "-";
  }
  const numeric = Number(trimmed);
  const date = Number.isFinite(numeric)
    ? new Date(numeric * 1000)
    : new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function loginFailureMessage(exitCode: number | null, log: string) {
  const code = exitCode ?? "unknown";
  const detail = summarizePtyFailure(log);
  return detail
    ? `登录失败（退出码 ${code}）：${detail}`
    : `登录失败（退出码 ${code}），当前状态已标记为未登录`;
}

function summarizePtyFailure(log: string) {
  const lines = stripAnsi(log)
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, "").trim())
    .filter(Boolean)
    .filter(isSafeLoginDiagnosticLine);
  const priority = lines.filter((line) =>
    /error|failed|failure|invalid|incorrect|denied|unauthorized|forbidden|not authorized|失败|错误|无效|拒绝|不正确|未授权|过期/i.test(line)
  );
  const selected = (priority.length ? priority : lines).slice(-3).join(" / ");
  return selected.length > 500 ? `${selected.slice(0, 500)}...` : selected;
}

function isSafeLoginDiagnosticLine(line: string) {
  const lower = line.toLowerCase();
  if (line.includes("<redacted>")) {
    return false;
  }
  if (/^\d{4,8}$/.test(line)) {
    return false;
  }
  if (/^[*•●]+$/.test(line)) {
    return false;
  }
  if (/^(password|2fa|verification code|auth code|code|密码|验证码)\s*:?$/i.test(line)) {
    return false;
  }
  return !(
    /(enter|input|请输入).*(password|2fa|verification code|auth code|code|密码|验证码)/i.test(lower) ||
    /(password|2fa|verification code|auth code|密码|验证码)\s*:\s*$/i.test(lower)
  );
}

function stripAnsi(value: string) {
  return value.replace(
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ""
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isLicenseRequiredError(error: unknown) {
  return errorMessage(error).toLowerCase().includes("license is required");
}

function extractApps(json: Record<string, unknown>): AppRecord[] {
  const rows = firstArray(json, ["results", "apps", "data", "items"]);
  return rows.map((item, index) => ({
    name: displayField(item, ["name", "trackName", "title"], `应用 ${index + 1}`),
    bundleId: displayField(item, ["bundleId", "bundleIdentifier", "bundleID", "bundle_id"], ""),
    version: displayField(item, ["version", "displayVersion", "shortVersionString"], "-"),
    price: priceField(item),
    iconUrl: imageUrlField(item, [
      "iconUrl",
      "iconURL",
      "icon",
      "artworkUrl",
      "artworkURL",
      "artworkUrl60",
      "artworkUrl100",
      "artworkUrl512",
      "artwork",
      "artwork.url",
      "artwork.urlTemplate",
      "artwork.templateUrl"
    ]),
    appId: numberField(item, ["id", "appId", "appID", "trackId", "adamId"])
  })).filter((item) => item.bundleId);
}

async function enrichAppsFromLookup(apps: AppRecord[], countryHints: string[]) {
  const ids = apps
    .map((app) => app.appId)
    .filter((id): id is number => typeof id === "number" && id > 0);
  if (!ids.length) {
    return null;
  }

  try {
    const payload = await api.lookupApps(ids, countryHints);
    if (!isRecord(payload)) {
      return null;
    }
    const lookupRows = firstArray(payload, ["results"]);
    const byId = new Map<number, Record<string, unknown>>();
    for (const row of lookupRows) {
      const id = numberField(row, ["trackId", "trackID", "id"]);
      if (id) {
        byId.set(id, row);
      }
    }
    return apps.map((app) => {
      const row = app.appId ? byId.get(app.appId) : null;
      if (!row) {
        return app;
      }
      return {
        ...app,
        price: hasDisplayValue(app.price) ? app.price : priceField(row, app.price),
        iconUrl: imageUrlField(row, [
          "artworkUrl100",
          "artworkUrl512",
          "artworkUrl60",
          "artworkURL",
          "artwork",
          "iconUrl",
          "icon"
        ]) || app.iconUrl,
        version: displayField(row, ["version"], app.version)
      };
    });
  } catch {
    // Icon enrichment is best-effort; ipatool search results remain authoritative.
    return null;
  }
}

function lookupCountryHints(json: Record<string, unknown>, authCountryCode: string | null | undefined) {
  const hints = new Set<string>();
  addCountryHint(hints, authCountryCode);
  collectCountryHints(json, hints);
  return [...hints];
}

function collectCountryHints(value: unknown, hints: Set<string>, depth = 0) {
  if (depth > 5) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCountryHints(entry, hints, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isCountryHintKey(key)) {
      addCountryHint(hints, entry);
    }
    collectCountryHints(entry, hints, depth + 1);
  }
}

function isCountryHintKey(key: string) {
  return /^(country|countryCode|country_code|storeCountryCode|store_country_code|storefrontCountryCode|storefront_country_code)$/i.test(key);
}

function addCountryHint(hints: Set<string>, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const country = value.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(country)) {
    hints.add(country);
  }
}

function extractVersions(json: Record<string, unknown>): VersionRecord[] {
  const externalVersionIds = firstScalarArray(json, [
    "externalVersionIdentifiers",
    "externalVersionIds",
    "externalVersionIDs"
  ]);
  if (externalVersionIds.length) {
    const versionNames = firstScalarArray(json, [
      "versionNames",
      "versionName",
      "version_names",
      "versionNumbers",
      "version_numbers",
      "displayVersions",
      "shortVersionStrings",
      "bundleVersions",
      "versions"
    ]);
    return rankVersions(externalVersionIds.map((externalVersionId, index) => ({
      versionName: versionNames[index] || "-",
      versionId: externalVersionId,
      date: "-",
      platform: "iPhone",
      arch: "Universal",
      badge: "",
      externalVersionId
    })));
  }

  const rows = firstArray(json, ["versions", "versionHistory", "results", "data", "items"]);
  return rankVersions(rows.map((item, index) => {
    const externalVersionId = displayField(item, [
      "externalVersionId",
      "externalVersionID",
      "externalVersionIdentifier",
      "externalVersionIdentifiers",
      "external_identifier",
      "versionId",
      "versionID",
      "id"
    ], "");
    return {
      versionName: displayField(item, [
        "versionName",
        "version_name",
        "versionString",
        "version",
        "displayVersion",
        "shortVersionString",
        "bundleShortVersionString",
        "bundleVersion",
        "releaseVersion",
        "name"
      ], `v${index + 1}`),
      versionId: externalVersionId || "-",
      date: displayField(item, ["date", "releaseDate", "released", "created", "createdDate"], "-"),
      platform: displayField(item, ["platform", "platforms"], "iPhone"),
      arch: displayField(item, ["arch", "architecture", "architectures"], "Universal"),
      badge: "",
      externalVersionId
    };
  }));
}

function fallbackVersionsForApp(app: AppRecord): VersionRecord[] {
  return [
    {
      versionName: app.version || "当前版本",
      versionId: "-",
      date: "-",
      platform: "iPhone",
      arch: "Universal",
      badge: "当前",
      externalVersionId: ""
    }
  ];
}

function rankVersions(versions: VersionRecord[]) {
  const sorted = [...versions].sort(compareVersionsNewestFirst);
  return sorted.map((version, index) => ({
    ...version,
    badge: index === 0 ? "最新" : version.badge
  }));
}

function compareVersionsNewestFirst(left: VersionRecord, right: VersionRecord) {
  const leftId = numericVersionId(left.externalVersionId || left.versionId);
  const rightId = numericVersionId(right.externalVersionId || right.versionId);
  if (leftId !== null && rightId !== null && leftId !== rightId) {
    return rightId - leftId;
  }
  if (leftId !== null && rightId === null) {
    return -1;
  }
  if (leftId === null && rightId !== null) {
    return 1;
  }
  return compareSemanticVersions(right.versionName, left.versionName);
}

function numericVersionId(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return null;
  }
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function compareSemanticVersions(left: string, right: string) {
  const leftParts = left.match(/\d+/g)?.map(Number) ?? [];
  const rightParts = right.match(/\d+/g)?.map(Number) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.localeCompare(right);
}

function firstArray(json: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = fieldValue(json, key);
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  for (const key of keys) {
    const value = findArrayByKey(json, key);
    if (value) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function firstScalarArray(json: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = fieldValue(json, key);
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }
  }
  return [];
}

function displayField(item: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = fieldValue(item, key);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (Array.isArray(value) && value.length) {
      return value.map((entry) => String(entry)).join(", ");
    }
  }
  return fallback;
}

function hasDisplayValue(value: string) {
  const normalized = value.trim();
  return Boolean(normalized && normalized !== "-");
}

function numberField(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = fieldValue(item, key);
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function priceField(item: Record<string, unknown>, fallback = "-") {
  const formatted = displayField(item, ["formattedPrice", "priceDisplay", "priceString"], "");
  if (formatted) {
    return formatted;
  }
  for (const key of ["price", "minimumPrice"]) {
    const value = fieldValue(item, key);
    if (typeof value === "number") {
      return value === 0 ? "免费" : String(value);
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric === 0 ? "免费" : value;
      }
      return value;
    }
  }
  return fallback;
}

function fileSizeField(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = fieldValue(item, key);
    if (typeof value === "number") {
      return formatBytes(value);
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 1024 ? formatBytes(numeric) : value;
    }
  }
  return "-";
}

function imageUrlField(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = fieldValue(item, key);
    if (typeof value === "string" && value.trim()) {
      return normalizeImageUrl(value);
    }
    if (isRecord(value)) {
      const nested = displayField(value, ["url", "href", "src", "templateUrl", "urlTemplate"], "");
      if (nested) {
        return normalizeImageUrl(nested);
      }
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) {
          return normalizeImageUrl(entry);
        }
        if (isRecord(entry)) {
          const nested = displayField(entry, ["url", "href", "src", "templateUrl", "urlTemplate"], "");
          if (nested) {
            return normalizeImageUrl(nested);
          }
        }
      }
    }
  }
  return "";
}

function fieldValue(item: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[key];
  }, item);
}

function findArrayByKey(value: unknown, key: string, depth = 0): Record<string, unknown>[] | null {
  if (depth > 4 || !isRecord(value)) {
    return null;
  }
  const direct = value[key];
  if (Array.isArray(direct)) {
    return direct.filter(isRecord);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      continue;
    }
    const found = findArrayByKey(child, key, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizeImageUrl(value: string) {
  return value
    .replace("{w}", "100")
    .replace("{h}", "100")
    .replace("{f}", "jpg")
    .replace("{c}", "bb")
    .replace("{w}x{h}", "100x100");
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default App;
