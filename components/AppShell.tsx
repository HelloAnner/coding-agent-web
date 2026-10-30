"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar, type SelectSessionOptions, type SessionSidebarControl } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { ToolbarQuota } from "./ToolbarQuota";
import { NewSessionContextBar, type NewSessionContextControl } from "./NewSessionContextBar";
import type { ChatScrollPosition } from "@/lib/chat-scroll-position";
import { FileBrowserPane } from "./FileBrowserPane";
import { DashboardApp } from "@/dashboard/ui/DashboardApp";
import { NotesApp } from "@/notes/ui/NotesApp";
import { WEB_APPS, webAppForPath, type WebApp } from "@/lib/apps";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import {
  forgetSessionPanel,
  readSessionPanel,
  saveSessionPanel,
  type NoteTab,
  type SessionPanelState,
} from "./session-panel-memory";
import { isNotePathUnder, noteTabIdAfterMove, remapNoteTabs } from "./note-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog, type ProjectTrustFailure } from "./ProjectTrustDialog";
import { SidebarToast, type SidebarToastData } from "./SidebarToast";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { SubagentViewer } from "./SubagentViewer";
import { TerminalPanel } from "./TerminalPanel";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { useTheme } from "@/hooks/useTheme";
import { useFontPreferences } from "@/hooks/useFontPreferences";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile, useIsNarrowMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { sendAgentCommand } from "@/lib/agent-client";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";
import { getInitialNavigation, linkedSessionId, withTabOpen } from "@/lib/initial-navigation";
import { clearTabOpenSession, getTabOpen, setTabOpenNewSession, setTabOpenSession } from "@/lib/tab-session";
import { composerHarnessFor, isPiSessionFile, mergeCatalogRow } from "./session-catalog-helpers";
import { getDraft, parkedNewSessionDraftKey, rekeyDraft } from "@/lib/draft-store";
import {
  contextForCwd,
  type NewSessionContext,
  type NewSessionMove,
  type NewSessionOptions,
  type NewSessionTarget,
  type ProjectChoice,
} from "@/lib/new-session-context";
import {
  clearLastOpen,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import {
  FILE_BROWSER_DEFAULT_WIDTH,
  FILE_BROWSER_MAX_WIDTH,
  FILE_BROWSER_MIN_WIDTH,
  FILE_VIEWER_MIN_WIDTH,
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { McpErrorResponse, ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import { NoteEditor } from "@/notes/ui/NoteEditor";
import { Whiteboard } from "@/notes/ui/Whiteboard";
import { notifyNotesChanged } from "@/lib/notes-watch";
import type { NotesBoardSettings, NotesEditorControl, NotesFileKind } from "@/notes/types";
import type { AgentEndInfo, NewSessionChoices } from "@/hooks/useAgentSession";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { formatActiveDuration, formatCompactCount, formatCostShort } from "@/lib/session-stats-format";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { PRESET_READ_ONLY, type ToolEntry } from "@/lib/tool-presets";
import { getAgentsBadge, getSessionFamily } from "@/lib/session-family";
import { getLastSettingsSection, settingsSectionRequiresProject, type SettingsSection } from "@/lib/settings-navigation";
import {
  loadFileTreeCollapsed,
  loadFileTreeSource,
  saveFileTreeCollapsed,
  saveFileTreeSource,
  type FileTreeSource,
} from "@/lib/sidebar-prefs";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";
// The panel shows no save status for a note: its editor autosaves on its own.
const ignoreNoteSaveState = () => {};
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
// A new chat names itself once its first message has had time to land.
const AUTO_NAME_AFTER_FIRST_MESSAGE_MS = 10_000;
const AGENT_PANEL_WIDTH = 420;
// pi's built-in tools that never change a file; any other tool may (#1144).
const READ_ONLY_TOOL_NAMES = new Set(PRESET_READ_ONLY);

function catalogTitle(session: SessionInfo): string {
  const raw = session.name?.trim() || session.firstMessage?.trim() || "";
  if (!raw || raw === "(no messages)") return "";
  const line = raw.split("\n")[0]?.trim() ?? "";
  return line.slice(0, 120);
}

async function readPiSessionMeta(id: string): Promise<{ path: string; name: string; provider: string; model: string }> {
  const empty = { path: "", name: "", provider: "", model: "" };
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return empty;
    const body = await response.json() as {
      filePath?: unknown;
      info?: { path?: unknown; name?: unknown };
      context?: { model?: { provider?: unknown; modelId?: unknown } | null };
    };
    const path = typeof body.info?.path === "string" && body.info.path
      ? body.info.path
      : typeof body.filePath === "string" ? body.filePath : "";
    const name = typeof body.info?.name === "string" ? body.info.name : "";
    const model = body.context?.model;
    const provider = model && typeof model.provider === "string" ? model.provider : "";
    const modelId = model && typeof model.modelId === "string" ? model.modelId : "";
    return { path, name, provider, model: modelId };
  } catch {
    return empty;
  }
}
const TOOL_END_REFRESH_MS = 1000;

/** Panel tab id of the last sub-agent tab, or null when there is none. */
function lastAgentTabId(tabs: readonly { sessionId: string }[]): string | null {
  const last = tabs.at(-1);
  return last ? `agent:${last.sessionId}` : null;
}

export function AppShell() {
  const nextRouter = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  // The app in view is a view of this shell, not another page: both stay
  // mounted, so switching loses no chat, file or dashboard state.
  const [activeAppId, setActiveAppId] = useState<WebApp["id"]>(() => webAppForPath(pathname ?? "/").id);
  const activeApp = WEB_APPS.find((app) => app.id === activeAppId) ?? WEB_APPS[0];
  const activeAppIdRef = useRef<WebApp["id"]>(activeAppId);
  activeAppIdRef.current = activeAppId;
  // The coding app writes its session and cwd into the query as it goes.
  // Those writes belong to the coding route: while the dashboard is the app
  // in view, the hidden coding side must not touch the dashboard's URL.
  const router = useMemo(() => ({
    ...nextRouter,
    replace: (href: string, options?: { scroll?: boolean }) => {
      if (activeAppIdRef.current === "coding") nextRouter.replace(href, options);
    },
  }), [nextRouter]);
  // Each app's last URL (the coding side's session and cwd, the dashboard's
  // board, the notes app's open file), so switching back lands where the user
  // left. Kept in one ref: adding an app must not add another ref.
  const appUrlRefs = useRef<Partial<Record<WebApp["id"], string>>>({});
  const [initialNavigation, setInitialNavigation] = useState(() => getInitialNavigation(searchParams));
  // Keep the system-theme subscription mounted for the lifetime of the app.
  useTheme();
  // Restore fonts even when Settings and the chat composer have not been opened.
  useFontPreferences();
  const { locale, t: translate } = useI18n();
  const isMobile = useIsMobile();
  const isNarrowMobile = useIsNarrowMobile();
  useViewportHeight();

  // Once the user has granted notification permission, register a Web Push
  // subscription so the server can notify backgrounded PWAs (notably iOS,
  // which suspends page JS and never receives the SSE completion event).
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    void setupPushSubscription(locale);
  }, [locale]);
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, holdAudio, soundEnabledRef } = useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true");
    } catch {
      // Browser storage is best-effort.
    }
  }, []);
  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelectionEnabled(enabled);
    try {
      localStorage.setItem("pi-quote-selection-enabled", String(enabled));
    } catch {
      // Keep the current page usable when storage is unavailable.
    }
  }, []);
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // Latest selection readable from async callbacks whose captured state is
  // stale (e.g. a delete that completes after the user navigated away).
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  // A pi file stays on pi. A stale index label must not drive the composer.
  useEffect(() => {
    if (!selectedSession || selectedSession.harness === "pi" || !isPiSessionFile(selectedSession.path)) return;
    const sessionId = selectedSession.id;
    setSelectedSession((current) => (
      current?.id === sessionId && current.harness !== "pi" && isPiSessionFile(current.path)
        ? { ...current, harness: "pi" }
        : current
    ));
  }, [selectedSession]);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
    // The sidebar hydrates metadata after the selected session has already
    // mounted. Merge that update into the active session without changing the
    // ChatWindow key or restarting its history load.
    setSelectedSession((current) => {
      if (!current) return current;
      const refreshed = sessions.find((session) => session.id === current.id);
      return refreshed ? mergeCatalogRow(current, refreshed) : current;
    });
  }, []);
  const sessionsWithSelection = useMemo(() => {
    if (!selectedSession) return sessionCatalog;
    return [
      ...sessionCatalog.filter((session) => session.id !== selectedSession.id),
      selectedSession,
    ];
  }, [selectedSession, sessionCatalog]);
  const activeSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, selectedSession?.id),
    [selectedSession?.id, sessionsWithSelection],
  );
  const hasSubagentSessions = Boolean(activeSessionFamily?.subagents.length);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  const agentsBadge = activeSessionFamily ? getAgentsBadge(activeSessionFamily.subagents, runningSessionIds) : null;
  const agentsButtonLabel = agentsBadge?.running
    ? translate("agentSwitcher.titleRunning", { count: agentsBadge.count })
    : translate("agentSwitcher.title");
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  // The bar above a fresh composer (NewSessionContextBar): the sidebar reports
  // what it shows and carries out its moves, which remount the composer. Its
  // model and reasoning picks, as it last reported them, go along with the
  // draft to the composer that replaces it, which takes them once.
  const sidebarControlRef = useRef<SessionSidebarControl | null>(null);
  const [sidebarNewSessionContext, setSidebarNewSessionContext] = useState<NewSessionContext | null>(null);
  // The bar's last move until the sidebar reports that cwd (a commit later),
  // so the bar of the new composer shows the target's project, and a worktree
  // it just created, from its first frame.
  const newSessionMoveRef = useRef<NewSessionMove | null>(null);
  const handleSidebarNewSessionContext = useCallback((context: NewSessionContext | null) => {
    if (context && context.cwd === newSessionMoveRef.current?.cwd) newSessionMoveRef.current = null;
    setSidebarNewSessionContext(context);
  }, []);
  const newSessionBarFocusRef = useRef<NewSessionContextControl | null>(null);
  const newSessionChoicesRef = useRef<NewSessionChoices | null>(null);
  const harnessRef = useRef("pi");
  const harnessModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  // The same pick as state: a fresh composer's send reads it, and ChatInput owns
  // the visible model chip for a harness that has no session file yet.
  const [composerModel, setComposerModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [composerHarness, setComposerHarness] = useState("pi");
  // A new composer reads its folder's preference once. A composer moved here
  // with its text and picks (carryComposer) keeps them instead.
  const newSessionCarryRef = useRef(false);
  const projectPreferenceAppliedRef = useRef<string | null>(null);
  const projectPreferenceRequestRef = useRef(0);
  // A pick the user makes while the folder's preference is still loading wins.
  const projectPreferenceInteractionRef = useRef(0);
  const [carriedNewSessionChoices, setCarriedNewSessionChoices] = useState<NewSessionChoices | null>(null);
  const [resetSessionConfig, setResetSessionConfig] = useState<{ sessionId: string; choices: NewSessionChoices } | null>(null);
  const handleSessionConfigChange = useCallback((sessionId: string, choices: NewSessionChoices | null) => {
    setResetSessionConfig(choices ? { sessionId, choices } : null);
  }, []);
  const [preservedPanelContext, setPreservedPanelContext] = useState<{ draftId: string; sessionId: string | null } | null>(null);
  const preservePanel = preservedPanelContext !== null && (selectedSession
    ? preservedPanelContext.sessionId === selectedSession.id
    : preservedPanelContext.draftId === newSessionDraftId);
  const handleNewSessionChoicesChange = useCallback((choices: NewSessionChoices) => {
    newSessionChoicesRef.current = choices;
    setCarriedNewSessionChoices(null);
  }, []);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatScrollPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current === target ? null : current);
  }, []);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<ProjectTrustFailure | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !initialNavigation.sidebarCollapsed);
  const desktopSidebarOpenRef = useRef(!initialNavigation.sidebarCollapsed);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  useEffect(() => {
    if (!rightPanelOpen) setMobileFilesOpen(false);
  }, [rightPanelOpen]);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // On a phone the right panel shows one column: the file tree over the
  // viewer, until a file (or terminal) is picked.
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  // The file column (project files or notes) folded away: the viewer gets the panel.
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  useEffect(() => { setFileTreeCollapsed(loadFileTreeCollapsed()); }, []);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  // The file tree beside the viewer, inside the right panel.
  const fileBrowserWidthRef = useRef(FILE_BROWSER_DEFAULT_WIDTH);
  const getFileBrowserMaxWidth = useCallback(
    () => Math.max(FILE_BROWSER_MIN_WIDTH, rightPanelResizer.width - FILE_VIEWER_MIN_WIDTH),
    [rightPanelResizer.width],
  );
  const fileBrowserResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFileBrowser"),
    cssVariable: "--file-browser-width",
    defaultWidth: FILE_BROWSER_DEFAULT_WIDTH,
    getMaxWidth: getFileBrowserMaxWidth,
    // The tree sits at the panel's right edge: dragging its handle left grows it.
    growthDirection: "left",
    maxWidth: FILE_BROWSER_MAX_WIDTH,
    minWidth: FILE_BROWSER_MIN_WIDTH,
    storageKey: "pi-file-browser-width",
    widthRef: fileBrowserWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  const reclampFileBrowserWidth = fileBrowserResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // Mobile drawer actions must not change the remembered desktop preference.
  useEffect(() => {
    setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
    reclampFileBrowserWidth();
  }, [reclampFileBrowserWidth, reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  // The tree keeps room for the viewer when the panel itself is resized.
  useEffect(() => {
    reclampFileBrowserWidth();
  }, [reclampFileBrowserWidth, rightPanelResizer.width]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const [branchSwitchLocked, setBranchSwitchLocked] = useState(false);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    setBranchSwitchLocked(locked);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoadIdRef.current += 1;
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  // "Save to notes": one session at a time, resolved on the server.
  const [digestStatus, setDigestStatus] = useState<{ kind: "idle" | "running" | "success" | "error"; message?: string }>({ kind: "idle" });
  // A failed write says why in a toast; the toolbar button alone was too quiet.
  const [digestToast, setDigestToast] = useState<SidebarToastData | null>(null);
  const digestToastIdRef = useRef(0);
  // The dialog where the user writes what this run must focus on.
  const [digestDialogOpen, setDigestDialogOpen] = useState(false);
  const [digestFocus, setDigestFocus] = useState("");
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNameOnFirstMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
      if (autoNameOnFirstMessageTimerRef.current) clearTimeout(autoNameOnFirstMessageTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "system" | "tools" | "session" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!sessionHasBranches) {
      setActiveTopPanel((panel) => panel === "branches" ? null : panel);
    }
  }, [sessionHasBranches]);

  useEffect(() => {
    if (!hasSubagentSessions) {
      setActiveTopPanel((panel) => panel === "agents" ? null : panel);
    }
  }, [hasSubagentSessions]);

  const toggleTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session",
    keepMobileToolbarOpen = false,
  ) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setMobileToolbarMoreOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  // The composer opens Settings too: a bare /mcp opens Settings › MCP (useAgentSession).
  const openSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile) desktopSidebarOpenRef.current = next;
      return next;
    });
  }, [isMobile]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, []);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
      // The icon opens the files themselves; the last tab stays one back tap away.
      if (!rightPanelOpen) setMobileFilesOpen(true);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile, rightPanelOpen]);

  // All apps are mounted in this shell. A switch shows the other one at once
  // and lets the shared layout's route change catch the URL up; the window
  // never reloads and the shell never remounts.
  const switchApp = useCallback((app: WebApp) => {
    if (app.id === activeAppId) return;
    const nextUrl = appUrlRefs.current[app.id] ?? app.href;
    // Before the navigation: the app being left must not write the URL again.
    activeAppIdRef.current = app.id;
    setActiveAppId(app.id);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen(false);
    nextRouter.push(nextUrl, { scroll: false });
  }, [activeAppId, nextRouter]);

  // The route and the view follow each other: a soft navigation (the
  // switcher, Back/Forward) updates the pathname, and with it the app shown.
  useEffect(() => {
    const id = webAppForPath(pathname ?? "/").id;
    activeAppIdRef.current = id;
    setActiveAppId(id);
  }, [pathname]);

  // Each app remembers its last URL. Switching back lands where the user left.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = webAppForPath(window.location.pathname).id;
    appUrlRefs.current[id] = `${window.location.pathname}${window.location.search}`;
  }, [pathname, searchParams]);

  // The pages are empty and the shell is already here: prefetching makes the
  // switcher's soft navigation immediate.
  useEffect(() => {
    nextRouter.prefetch("/");
    nextRouter.prefetch("/dashboard");
    nextRouter.prefetch("/notes");
  }, [nextRouter]);

  useEffect(() => {
    if (activeAppId === "coding") return;
    // Nothing under the dashboard overlay should keep a stray focus.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [activeAppId]);

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [isMobile, isNarrowMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "agents") {
        setTopPanelPos({
          top: topBarRect.bottom,
          left: topBarRect.left,
          width: Math.min(AGENT_PANEL_WIDTH, topBarRect.width),
        });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  // Files unmount when inactive; workspace terminals stay mounted until closed.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  // Bumped on every conversation switch. The active viewer reports its state
  // as it unmounts, tagged with the generation it rendered in, so a late
  // report cannot land in the tabs restored for another conversation.
  const [fileWorkspaceGeneration, setFileWorkspaceGeneration] = useState(0);
  const fileWorkspaceGenerationRef = useRef(0);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  // Subagent work tabs are session-scoped and transient: no persistence, and
  // they are dropped when the conversation changes (they belong to it).
  const [agentTabs, setAgentTabs] = useState<{ sessionId: string; label: string }[]>([]);
  // The notes the right panel has open beside the chat: per conversation, as
  // the files are.
  const [noteTabs, setNoteTabs] = useState<NoteTab[]>([]);
  // The file column's tree: the project's files, or the notes vault.
  const [treeSource, setTreeSource] = useState<FileTreeSource>("project");
  useEffect(() => { setTreeSource(loadFileTreeSource()); }, []);
  const [notesBoard, setNotesBoard] = useState<NotesBoardSettings>({ fontFamily: 3, fontSize: 20 });
  // The open editor's pending keystrokes: a move or delete of its file must
  // wait for them, or the debounced save would land on a path that is gone.
  const noteEditorRef = useRef<NotesEditorControl | null>(null);
  const registerNoteEditor = useCallback((control: NotesEditorControl | null) => {
    noteEditorRef.current = control;
  }, []);
  const flushActiveNote = useCallback(async () => (await noteEditorRef.current?.flush()) ?? true, []);
  const panelTabs: Tab[] = [
    ...fileTabs,
    ...terminalTabs.map((tab) => ({
      id: tab.id,
      label: getFileName(tab.cwd) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    })),
    ...agentTabs.map((tab) => ({
      id: `agent:${tab.sessionId}`,
      label: tab.label,
      filePath: tab.label,
      kind: "agent" as const,
    })),
    ...noteTabs.map((tab) => ({
      id: `note:${tab.path}`,
      label: tab.name,
      filePath: tab.path,
      kind: tab.kind,
    })),
  ];

  // The panel's live state, read at save time: a state-listing effect that read
  // it from this render would write what a switch is about to replace.
  const panelStateRef = useRef<SessionPanelState>({
    open: false,
    treeSource: "project",
    treeCollapsed: false,
    fileTabs: [],
    noteTabs: [],
    activeTabId: null,
  });
  panelStateRef.current = {
    open: rightPanelOpen,
    treeSource,
    treeCollapsed: fileTreeCollapsed,
    fileTabs,
    noteTabs,
    activeTabId: activeFileTabId,
  };
  const terminalTabIdsRef = useRef<string[]>([]);
  terminalTabIdsRef.current = terminalTabs.map((tab) => tab.id);
  // Every conversation keeps its own right panel: switching restores its open
  // state, its tree, its tabs and the tab it had focused. The fresh composer is
  // its own key too, so a New in another project starts with an empty panel.
  const panelKey = selectedSession ? `session:${selectedSession.id}` : `new:${newSessionCwd ?? ""}`;
  const panelKeyRef = useRef<string | null>(null);
  // The conversation just left: its viewer reports its last scroll offset as it
  // unmounts, after the switch, and that report belongs to that memory.
  const leavingSessionRef = useRef<string | null>(null);
  // Conversations deleted or archived in this visit: their memory must not be
  // written back by a switch that happens right after.
  const forgottenSessionsRef = useRef(new Set<string>());
  const sessionCwdRef = useRef<string | null>(null);
  sessionCwdRef.current = selectedSession?.cwd ?? null;
  useEffect(() => {
    const previous = panelKeyRef.current;
    if (previous === panelKey) return;
    panelKeyRef.current = panelKey;
    const leaving = previous?.startsWith("session:") ? previous.slice("session:".length) : null;
    leavingSessionRef.current = leaving;
    // The ref still holds the panel being left: it is saved under its own key.
    if (leaving && !forgottenSessionsRef.current.has(leaving)) saveSessionPanel(leaving, panelStateRef.current);
    const sessionId = panelKey.startsWith("session:") ? panelKey.slice("session:".length) : null;
    // Starting over and promoting a fresh composer keep the live viewers:
    // remounting them would reset scroll offsets and the whiteboard's viewport.
    const composing = previous === `new:${sessionCwdRef.current ?? ""}`;
    if (preservePanel || (sessionId && composing)) return;
    const memory = sessionId ? readSessionPanel(sessionId) : null;
    fileWorkspaceGenerationRef.current += 1;
    setFileWorkspaceGeneration(fileWorkspaceGenerationRef.current);
    setFileTabs(memory?.fileTabs ?? []);
    setNoteTabs(memory?.noteTabs ?? []);
    // Terminals outlive conversations and keep the panel while they are active.
    setActiveFileTabId((current) => current && terminalTabIdsRef.current.includes(current)
      ? current
      : memory?.activeTabId ?? null);
    setRightPanelOpen(memory?.open ?? false);
    setFileTreeCollapsed(memory?.treeCollapsed ?? false);
    setTreeSource(memory?.treeSource ?? loadFileTreeSource());
    setAgentTabs([]);
  }, [panelKey, preservePanel]);

  // Remembered as the user works, so a reload lands on the same panel. The ref
  // is read at fire time: the render a switch starts from must not save over
  // the memory it is about to restore.
  useEffect(() => {
    if (!panelKey.startsWith("session:")) return;
    const sessionId = panelKey.slice("session:".length);
    const timer = setTimeout(() => {
      if (!forgottenSessionsRef.current.has(sessionId)) saveSessionPanel(sessionId, panelStateRef.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [panelKey, rightPanelOpen, treeSource, fileTreeCollapsed, fileTabs, noteTabs, activeFileTabId]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.activeId) {
        setActiveFileTabId(saved.activeId);
        setRightPanelOpen(saved.open);
      }
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeFileTabId,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeFileTabId, rightPanelOpen, terminalsRestored]);

  const handleFileViewerStateChange = useCallback((
    generation: number,
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    if (generation !== fileWorkspaceGenerationRef.current) {
      // The viewer of the conversation just left reports as it unmounts: the
      // offset goes to that conversation's memory, never to the live tabs.
      const left = leavingSessionRef.current;
      const memory = left ? readSessionPanel(left) : null;
      if (!memory || !left) return;
      saveSessionPanel(left, {
        ...memory,
        fileTabs: saveFileViewerState(memory.fileTabs, tabId, viewerRevision, viewerState),
      });
      return;
    }
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const initialLinkedSessionId = linkedSessionId(initialNavigation);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // sessionStorage is empty during SSR. Applying the tab's remembered session
  // in the useState initializer made the first client tree differ from the
  // server HTML (sidebar "select project" vs ""). Restore after mount instead.
  useLayoutEffect(() => {
    const next = withTabOpen(initialNavigation, getTabOpen());
    if (next === initialNavigation) return;
    setInitialNavigation(next);
    if (next.sessionId) setInitialSessionRestored(false);
  }, [initialNavigation]);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Set when the session the URL linked to is gone: the project the sidebar
  // adopts next keeps a fresh composer instead of restoring its last session.
  const skipWorkspaceRestoreRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  // The workspace memory is shared by every tab; the tab memory keeps this
  // tab's own session so a reload does not follow another tab's last pick.
  // New session is a selection too: remember the composer cwd so reload stays
  // on that UI instead of resurrecting the previous chat.
  useEffect(() => {
    if (selectedSession) {
      const projectKey = selectedSession.projectKey
        ?? activeProjectKeyRef.current
        ?? workspaceKeyOf(selectedSession);
      setLastOpenSession(projectKey, selectedSession.id);
      setTabOpenSession(selectedSession.id);
      return;
    }
    if (newSessionCwd) setTabOpenNewSession(newSessionCwd);
  }, [newSessionCwd, selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        newSessionCarryRef.current = false;
        const draftId = `initial:${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
        if (!new URLSearchParams(window.location.search).get("cwd")) {
          router.replace(`?cwd=${encodeURIComponent(data.cwd)}`, { scroll: false });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation, router]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string, cwd: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    const adopt = (d: { sessions: SessionInfo[] } | null) => {
      if (token !== workspaceRestoreTokenRef.current) return; // stale switch
      const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
      if (!s) {
        // The list loaded but the remembered session is gone — forget it.
        // When the list itself failed (d === null) keep the memory so a
        // later switch retries the restore.
        if (d) clearLastOpen(projectKey);
        return;
      }
      if (workspaceKeyOf(s) !== projectKey) {
        // Defensive: the remembered session drifted out of this workspace.
        clearLastOpen(projectKey);
        return;
      }
      // Keep the temporary composer's draft in its cwd, even when the
      // remembered session belongs to another worktree of this project.
      const activeDraftKey = activeNewSessionDraftKeyRef.current;
      if (activeDraftKey) {
        rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(cwd));
      }
      activeNewSessionDraftKeyRef.current = null;
      // Selecting the session must remount the chat with the session
      // present: useAgentSession loads content in a mount-only effect, so
      // the null-session welcome mount from the switch would never load
      // the restored session's messages.
      setPreservedPanelContext(null);
      setSelectedSession(s);
      setSessionKey((k) => k + 1);
      if (new URLSearchParams(window.location.search).get("session") !== s.id) {
        router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
      }
    };
    // Fast path: the sidebar already delivered the catalogue — restore
    // without waiting on a fresh /api/sessions round trip.
    if (sessionCatalog.length > 0) {
      adopt({ sessions: sessionCatalog });
      return;
    }
    void fetch("/api/catalog/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then(adopt)
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router, sessionCatalog]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    invalidateWorkspaceRestore();
    newSessionCarryRef.current = false;
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const skipWorkspaceRestore = skipWorkspaceRestoreRef.current;
    skipWorkspaceRestoreRef.current = false;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setPreservedPanelContext(null);
    const previousDraftKey = activeNewSessionDraftKeyRef.current;
    if (previousDraftKey && currentFreshCwd) {
      rekeyDraft(previousDraftKey, parkedNewSessionDraftKey(currentFreshCwd));
    }
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const draftKey = `new:${draftId}:${cwd}`;
    rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = draftKey;
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setBranchSwitchLocked(false);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (currentProject !== newProject) {
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      if (!skipWorkspaceRestore) restoreWorkspaceContext(newProject, cwd);
    }
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [activeCwd, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false, entryId?: string, blockIndex?: number, options?: SelectSessionOptions) => {
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    invalidateWorkspaceRestore();
    const activeDraftKey = activeNewSessionDraftKeyRef.current;
    const activeDraftCwd = newSessionCwd ?? (selectedSession === null ? activeCwd : null);
    if (activeDraftKey && activeDraftCwd) {
      rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd));
    }
    activeNewSessionDraftKeyRef.current = null;
    // Adopt an explicitly selected session before the sidebar reports its cwd.
    const projectKey = workspaceKeyOf(session);
    if (activeProjectKeyRef.current !== projectKey) setActiveTopPanel(null);
    activeProjectKeyRef.current = projectKey;
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setPreservedPanelContext(null);
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setBranchSwitchLocked(false);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick
    // (unless the sidebar still has something to show: a fork's row and toast).
    if (isMobile && !isRestore && !options?.keepSidebarOpen) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when the URL already has this session — calling
    // replace in production Next.js triggers a Suspense remount loop.
    // Tab-memory restore lands on `/` and must write `?session=` so reload
    // and copy-link keep this session.
    if (!isRestore || new URLSearchParams(window.location.search).get("session") !== session.id) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [activeCwd, invalidateWorkspaceRestore, router, isMobile, newSessionCwd, selectedSession]);

  const handleNewSession = useCallback((sessionId: string, cwd: string, projectKey?: string | null, options?: NewSessionOptions) => {
    invalidateWorkspaceRestore();
    newSessionCarryRef.current = Boolean(options?.carryComposer || options?.keepContext);
    setPreservedPanelContext(options?.keepContext ? { draftId: sessionId, sessionId: null } : null);
    const draftKey = `new:${sessionId}:${cwd}`;
    // Leaving a fresh composer for another cwd parks its draft there, as a
    // workspace switch does; New in the same cwd still starts empty. The bar
    // above the composer moves the composer instead: its draft (the live
    // text, as promoteNewSession takes it) and its model picks go along.
    const activeDraftKey = activeNewSessionDraftKeyRef.current;
    const activeDraftCwd = newSessionCwd ?? (selectedSession === null ? activeCwd : null);
    if (options?.carryComposer && selectedSession === null && activeDraftKey) {
      const input = chatInputRef.current;
      if (input) input.rekeyDraft(activeDraftKey, draftKey);
      else rekeyDraft(activeDraftKey, draftKey);
      setCarriedNewSessionChoices(newSessionChoicesRef.current);
    } else if (activeDraftKey && activeDraftCwd && activeDraftCwd !== cwd) {
      rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd));
    }
    // Adopt the target project before the sidebar reports its cwd, as an
    // explicit session pick does. Without a key (Ctrl+Alt+N) the current cwd
    // keeps its project.
    const targetProject = projectKey ?? (cwd === activeCwd ? activeProjectKeyRef.current : null) ?? cwd;
    activeProjectKeyRef.current = targetProject;
    // A draft parked in this cwd comes back, unless one was carried here: it
    // stays parked for the next time, never merged into what was carried.
    if (!options?.keepContext && !getDraft(draftKey)) rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setBranchSwitchLocked(false);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isMobile && !options?.keepContext) setSidebarOpen(false);
    router.replace(`?cwd=${encodeURIComponent(cwd)}`, { scroll: false });
    // The fresh composer takes the caret once it renders (#1313), unless the
    // move came from the new-session bar, whose control keeps focus instead
    // (newSessionBarFocusRef), or a phone would raise the keyboard for it.
    // A dialog still open over the page (Ctrl+Alt+N under Settings) keeps it.
    if (!isMobile && !newSessionBarFocusRef.current) {
      requestAnimationFrame(() => {
        if (document.activeElement?.closest("[aria-modal='true']")) return;
        chatInputRef.current?.focus();
      });
    }
  }, [activeCwd, invalidateWorkspaceRestore, isMobile, newSessionCwd, router, selectedSession]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/catalog/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  // One row per folder in the catalog db. New chats in that folder read it.
  const saveProjectPreference = useCallback((
    cwd: string | null | undefined,
    preference: { harness: string; provider?: string; model?: string },
  ) => {
    if (!cwd) return;
    void fetch("/api/project-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        harness: preference.harness,
        provider: preference.provider ?? "",
        model: preference.model ?? "",
      }),
    }).catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from its harness.
  // The index row is written before the list is read back, so the sidebar
  // shows the chat that was just started.
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    void (async () => {
      // A pi session's model and file come from the pi session file. A grok
      // session brings its own path and keeps the model the composer picked.
      const harness = session.harness || "pi";
      const meta = harness === "pi" ? await readPiSessionMeta(session.id) : null;
      const picked = harness === "pi"
        ? newSessionChoicesRef.current?.model
        : harnessModelRef.current;
      const provider = meta?.provider || session.modelProvider || picked?.provider || "";
      const model = meta?.model || session.modelId || picked?.modelId || "";
      const sessionPath = session.path || meta?.path;
      const title = catalogTitle(session) || meta?.name;
      saveProjectPreference(session.cwd, { harness, provider, model });
      try {
        await fetch("/api/catalog/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: session.id,
            cwd: session.cwd,
            harness,
            provider,
            model,
            title,
            sessionPath,
          }),
        });
      } catch {
        // The chat stays open. The next list load shows the row once the write lands.
      }
      // A brand new chat names itself after its first message. Same request as
      // the toolbar button, just fired without a click.
      if (autoNameOnFirstMessageTimerRef.current) clearTimeout(autoNameOnFirstMessageTimerRef.current);
      autoNameOnFirstMessageTimerRef.current = setTimeout(() => {
        autoNameOnFirstMessageTimerRef.current = null;
        void requestAutoNameRef.current(session.id);
      }, AUTO_NAME_AFTER_FIRST_MESSAGE_MS);
      if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
      invalidateWorkspaceRestore();
      activeNewSessionDraftKeyRef.current = null;
      setNewSessionCwd(null);
      setPreservedPanelContext((current) => current ? { ...current, sessionId: session.id } : null);
      setSelectedSession({
        ...session,
        path: sessionPath || session.path,
        name: title || session.name,
        harness,
        modelProvider: provider || undefined,
        modelId: model || undefined,
        transient: false,
      });
      hydrateSelectedSession(session.id);
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
      setRefreshKey((k) => k + 1);
    })();
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession, saveProjectPreference]);

  const handleHarnessChange = useCallback((id: string) => {
    // An open session already has a harness. A fresh composer only remembers the next one.
    if (selectedSessionRef.current?.id) return;
    projectPreferenceInteractionRef.current += 1;
    harnessRef.current = id;
    setComposerHarness(id);
    saveProjectPreference(
      selectedSessionRef.current?.cwd ?? newSessionCwd ?? activeCwd,
      { harness: id },
    );
  }, [activeCwd, newSessionCwd, saveProjectPreference]);

  const handleProjectPreferenceChange = useCallback((harness: string, provider: string, modelId: string) => {
    projectPreferenceInteractionRef.current += 1;
    const cwd = selectedSessionRef.current?.cwd ?? newSessionCwd ?? activeCwd;
    saveProjectPreference(cwd, { harness, provider, model: modelId });
  }, [activeCwd, newSessionCwd, saveProjectPreference]);

  const handleCatalogModelChange = useCallback((provider: string, modelId: string) => {
    const session = selectedSessionRef.current;
    const harness = session?.harness || harnessRef.current || "pi";
    if (session && harness === "claude-code") return;
    if (harness !== "pi") {
      harnessModelRef.current = { provider, modelId };
      setComposerModel({ provider, modelId });
    }
    if (!session) return;
    setSelectedSession((current) => (
      current?.id === session.id ? { ...current, modelProvider: provider, modelId } : current
    ));
    void fetch(`/api/catalog/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model: modelId }),
    }).then((response) => {
      if (response.ok) setRefreshKey((k) => k + 1);
    }).catch(() => {});
  }, []);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
      void setupPushSubscription(locale);
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") {
          fire();
          void setupPushSubscription(locale);
        }
      });
    }
  }, [handleSelectSession, locale]);

  const handleAgentEnd = useCallback((end: AgentEndInfo) => {
    // The sidebar's reload merges the selected session's new row into it
    // (handleSessionsChange), so no list fetch of its own here.
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);

    if (end.aborted || selectedSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (selectedSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  // One title request for one session, from the toolbar or from a new chat's
  // own first message. The status only shows on the chat that is on screen.
  const requestAutoName = useCallback(async (sessionId: string) => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    const isActive = () => activeSessionIdRef.current === sessionId;
    if (isActive()) setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (!isActive()) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (!isActive()) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, []);
  const requestAutoNameRef = useRef(requestAutoName);
  requestAutoNameRef.current = requestAutoName;

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    setActiveTopPanel(null);
    await requestAutoName(sessionId);
  }, [autoNameStatus.kind, requestAutoName, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  useEffect(() => {
    setDigestStatus({ kind: "idle" });
    setDigestToast(null);
  }, [selectedSession?.id]);

  const handleDigestToNotes = useCallback(async (boardPath: string, focus: string) => {
    const session = selectedSessionRef.current;
    if (!session || session.transient || digestStatus.kind === "running") return;
    setDigestDialogOpen(false);
    setDigestStatus({ kind: "running" });
    setDigestToast(null);
    try {
      const response = await fetch("/api/notes/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, boardPath, focus }),
      });
      const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error || translate("notes.digestFailed"));
      notifyNotesChanged([boardPath]);
      setDigestStatus({ kind: "success", message: body.message });
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("notes.digestFailed");
      setDigestStatus({ kind: "error", message });
      digestToastIdRef.current += 1;
      setDigestToast({ id: digestToastIdRef.current, message: `${translate("notes.digestFailed")}：${message}`, actions: [] });
    }
  }, [digestStatus.kind, translate]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  // A run's writes show in the file tree as they happen, not only when it ends
  // (#1144): at most one refresh a second, after any tool but the read-only ones.
  const toolEndRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleToolEnd = useCallback((toolName: string) => {
    if (READ_ONLY_TOOL_NAMES.has(toolName) || toolEndRefreshTimerRef.current) return;
    toolEndRefreshTimerRef.current = setTimeout(() => {
      toolEndRefreshTimerRef.current = null;
      setExplorerRefreshKey((k) => k + 1);
    }, TOOL_END_REFRESH_MS);
  }, []);
  useEffect(() => () => {
    if (toolEndRefreshTimerRef.current) clearTimeout(toolEndRefreshTimerRef.current);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    const source = selectedSessionRef.current;
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setPreservedPanelContext(null);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      harness: "pi",
      transient: false,
    }));
    const cwd = source?.cwd ?? "";
    if (cwd.startsWith("/")) {
      const keepModel = !source?.harness || source.harness === "pi";
      void (async () => {
        const meta = await readPiSessionMeta(newSessionId);
        try {
          await fetch("/api/catalog/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: newSessionId,
              cwd,
              harness: "pi",
              provider: meta.provider || (keepModel ? source?.modelProvider ?? "" : ""),
              model: meta.model || (keepModel ? source?.modelId ?? "" : ""),
              title: meta.name,
              sessionPath: meta.path,
            }),
          });
          setRefreshKey((k) => k + 1);
        } catch {
          // The copy is open. A later refresh writes the row if this post failed.
        }
      })();
    }
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleAskInNewChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    sourceEntryId: string,
  ) => {
    const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
      type: "fork_branch",
      entryId: sourceEntryId,
    });
    if (!result?.newSessionId) throw new Error(translate("chat.quoteForkFailed"));
    setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
    handleSessionForked(result.newSessionId);
  }, [handleSessionForked, translate]);

  // The sidebar calls this when the initial session is not in its list.
  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
    if (initialLinkedSessionId) skipWorkspaceRestoreRef.current = true;
  }, [initialLinkedSessionId]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    // A deleted conversation's panel memory goes with it.
    forgottenSessionsRef.current.add(sessionId);
    forgetSessionPanel(sessionId);
    setRefreshKey((k) => k + 1);
    // The DELETE can outlive a session switch: this callback's captured
    // selectedSession is from the delete click. Read the latest selection
    // and only fall back to the empty composer when the user is still on
    // the deleted session at the moment removal completes.
    const active = selectedSessionRef.current;
    if (active?.id === sessionId) {
      clearTabOpenSession(sessionId);
      setPreservedPanelContext(null);
      newSessionCarryRef.current = false;
      const cwd = active.cwd;
      const draftId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setBranchSwitchLocked(false);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
      router.replace(cwd ? `?cwd=${encodeURIComponent(cwd)}` : (typeof window !== "undefined" ? window.location.pathname : "/"), { scroll: false });
    }
  }, [invalidateWorkspaceRestore, router]);

  // Archived conversations leave the sidebar: their memory goes with them.
  const handleSessionsArchived = useCallback((sessionIds: string[]) => {
    for (const sessionId of sessionIds) {
      forgottenSessionsRef.current.add(sessionId);
      forgetSessionPanel(sessionId);
    }
  }, []);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; page?: number },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const page = options?.page;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint,
      page,
      sourceSessionId,
      tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) {
      setSidebarOpen(false);
      setMobileFilesOpen(false);
    }
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string, page?: number) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null, page });
  }, [handleOpenFile, selectedSession?.id]);

  // A note or board from the notes tree: one tab per file, the editor autosaves.
  const handleOpenNote = useCallback((path: string, name: string, kind: NotesFileKind) => {
    setNoteTabs((tabs) => tabs.some((tab) => tab.path === path) ? tabs : [...tabs, { path, name, kind }]);
    setActiveFileTabId(`note:${path}`);
    setRightPanelOpen(true);
    if (isMobile) {
      setSidebarOpen(false);
      setMobileFilesOpen(false);
    }
  }, [isMobile]);

  // A note or folder the notes tree moved: the open tabs follow the file.
  const handleNoteMoved = useCallback((from: string, to: string) => {
    setNoteTabs((tabs) => remapNoteTabs(tabs, from, to));
    setActiveFileTabId((current) => noteTabIdAfterMove(current, from, to));
  }, []);

  // A note or folder the notes tree deleted: its tabs close; the last one
  // left in the panel becomes active, as it does when a tab closes by hand.
  const handleNotesRemoved = useCallback((path: string) => {
    const gone = noteTabs.filter((tab) => isNotePathUnder(tab.path, path));
    if (!gone.length) return;
    const remaining = noteTabs.filter((tab) => !isNotePathUnder(tab.path, path));
    setNoteTabs(remaining);
    setActiveFileTabId((current) => {
      if (!current || !gone.some((tab) => `note:${tab.path}` === current)) return current;
      const lastNote = remaining.at(-1);
      return fileTabs.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? lastAgentTabId(agentTabs)
        ?? (lastNote ? `note:${lastNote.path}` : null);
    });
  }, [noteTabs, fileTabs, terminalTabs, agentTabs]);

  // A whiteboard draws with the vault's tuned defaults; read them on first open.
  useEffect(() => {
    if (!noteTabs.some((tab) => tab.kind === "board")) return;
    let alive = true;
    fetch("/api/notes/settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ settings?: { board?: NotesBoardSettings } }> : null)
      .then((body) => { if (alive && body?.settings?.board) setNotesBoard(body.settings.board); })
      .catch(() => {});
    return () => { alive = false; };
  }, [noteTabs]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    setRightPanelOpen(true);
    if (isMobile) {
      setSidebarOpen(false);
      setMobileFilesOpen(false);
    }
  }, [terminalTabs, isMobile]);

  // Subagent work opens in a right-panel tab instead of hijacking the main chat.
  const handleOpenSubagentTab = useCallback((sessionId: string, label: string) => {
    setAgentTabs((prev) => prev.some((tab) => tab.sessionId === sessionId) ? prev : [...prev, { sessionId, label }]);
    setActiveFileTabId(`agent:${sessionId}`);
    setRightPanelOpen(true);
    if (isMobile) {
      setSidebarOpen(false);
      setMobileFilesOpen(false);
    }
  }, [isMobile]);

  // The agent switcher's side-panel button: opens a subagent's tab, or closes
  // it when the open panel already has it (the panel closes with its last tab).
  // The switcher stays open beside the panel, except on phones, where the
  // panel covers the chat.
  const openSubagentTabIds = useMemo(
    () => new Set(rightPanelOpen ? agentTabs.map((tab) => tab.sessionId) : []),
    [agentTabs, rightPanelOpen],
  );
  const handleToggleSubagentTab = (sessionId: string, label: string) => {
    if (openSubagentTabIds.has(sessionId)) {
      handleCloseFileTab(`agent:${sessionId}`);
      return;
    }
    if (isMobile) setActiveTopPanel(null);
    handleOpenSubagentTab(sessionId, label);
  };

  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const remaining = terminalTabs.filter((item) => item.id !== tab.id);
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    setActiveFileTabId((current) => current !== tab.id ? current : replacement?.id ?? remaining.at(-1)?.id ?? fileTabs.at(-1)?.id ?? lastAgentTabId(agentTabs));
  };

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    if (tabId.startsWith("agent:")) {
      const remainingAgents = agentTabs.filter((tab) => `agent:${tab.sessionId}` !== tabId);
      setAgentTabs(remainingAgents);
      setActiveFileTabId((cur) => {
        if (cur !== tabId) return cur;
        return fileTabs.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? lastAgentTabId(remainingAgents);
      });
      return;
    }
    if (tabId.startsWith("note:")) {
      const remainingNotes = noteTabs.filter((tab) => `note:${tab.path}` !== tabId);
      setNoteTabs(remainingNotes);
      setActiveFileTabId((cur) => {
        if (cur !== tabId) return cur;
        const lastNote = remainingNotes.at(-1);
        return fileTabs.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? lastAgentTabId(agentTabs)
          ?? (lastNote ? `note:${lastNote.path}` : null);
      });
      return;
    }
    setFileTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.at(-1)?.id ?? terminalTabs.at(-1)?.id ?? lastAgentTabId(agentTabs);
    });
  }, [fileTabs, terminalTabs, agentTabs, noteTabs]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  // Every fresh composer starts on its folder's last harness and model. A moved
  // composer keeps its own picks, and a folder with no row yet starts on pi.
  useEffect(() => {
    if (selectedSession !== null || !effectiveNewSessionCwd || !newSessionDraftKey) return;
    const key = newSessionDraftKey;
    if (projectPreferenceAppliedRef.current === key) return;
    projectPreferenceAppliedRef.current = key;
    const carry = newSessionCarryRef.current;
    newSessionCarryRef.current = false;
    if (carry) return;
    const interaction = projectPreferenceInteractionRef.current;
    const requestId = ++projectPreferenceRequestRef.current;
    void fetch(`/api/project-preferences?cwd=${encodeURIComponent(effectiveNewSessionCwd)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: {
        preference?: { harness?: unknown; provider?: unknown; model?: unknown } | null;
      } | null) => {
        if (requestId !== projectPreferenceRequestRef.current) return;
        if (interaction !== projectPreferenceInteractionRef.current) return;
        const preference = body?.preference;
        const harness = typeof preference?.harness === "string" ? preference.harness : "";
        if (!harness) {
          harnessRef.current = "pi";
          setComposerHarness("pi");
          harnessModelRef.current = null;
          setComposerModel(null);
          return;
        }
        harnessRef.current = harness;
        setComposerHarness(harness);
        const provider = typeof preference?.provider === "string" ? preference.provider : "";
        const modelId = typeof preference?.model === "string" ? preference.model : "";
        if (harness === "pi") {
          harnessModelRef.current = null;
          setComposerModel(null);
        } else {
          const picked = provider && modelId ? { provider, modelId } : null;
          harnessModelRef.current = picked;
          setComposerModel(picked);
        }
      })
      .catch(() => {
        if (requestId !== projectPreferenceRequestRef.current) return;
        if (interaction !== projectPreferenceInteractionRef.current) return;
        harnessRef.current = "pi";
        setComposerHarness("pi");
        harnessModelRef.current = null;
        setComposerModel(null);
      });
  }, [effectiveNewSessionCwd, newSessionDraftKey, selectedSession]);
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);

  // The bar above a fresh composer. Only a fresh composer moves, and only
  // somewhere else: the folder in use would remount it for nothing. The
  // control the move came from takes focus in the bar of the new composer.
  const handlePickNewSessionContext = useCallback((target: NewSessionTarget, from: NewSessionContextControl) => {
    if (selectedSession !== null || !effectiveNewSessionCwd || target.cwd === effectiveNewSessionCwd) return;
    newSessionBarFocusRef.current = from;
    // A worktree just created already left its move, with the branch.
    if (target.projectKey && target.projectRoot && newSessionMoveRef.current?.cwd !== target.cwd) {
      newSessionMoveRef.current = { cwd: target.cwd, project: { key: target.projectKey, root: target.projectRoot }, branch: null };
    }
    sidebarControlRef.current?.startNewSessionIn({ ...target, carryComposer: true });
  }, [effectiveNewSessionCwd, selectedSession]);
  // The folder picker answers later: its pick runs the newest closure, guard included.
  const pickNewSessionContextRef = useRef(handlePickNewSessionContext);
  pickNewSessionContextRef.current = handlePickNewSessionContext;
  const handleOpenFolderForNewSession = useCallback((opener: HTMLElement | null) => {
    sidebarControlRef.current?.openFolderForNewSession((target) => pickNewSessionContextRef.current(target, "project"), opener);
  }, []);
  const handleDefaultDirectoryForNewSession = useCallback(() => {
    sidebarControlRef.current?.openDefaultDirectoryForNewSession((target) => pickNewSessionContextRef.current(target, "project"));
  }, []);
  const handleRefreshNewSessionWorktrees = useCallback(() => {
    sidebarControlRef.current?.refreshWorktrees();
  }, []);
  const handleCreateNewSessionWorktree = useCallback(async (project: ProjectChoice, branch: string) => {
    const control = sidebarControlRef.current;
    if (!control) throw new Error("The session sidebar is not mounted");
    const result = await control.createWorktree(project, branch);
    // The bar moves there next, before any report lists it.
    if ("path" in result) newSessionMoveRef.current = { cwd: result.path, project, branch };
    return result;
  }, []);
  const handleNewSessionBarFocusDone = useCallback(() => {
    newSessionBarFocusRef.current = null;
  }, []);
  const newSessionContextBar = selectedSession === null && effectiveNewSessionCwd ? (
    <NewSessionContextBar
      context={contextForCwd(sidebarNewSessionContext, effectiveNewSessionCwd, newSessionMoveRef.current)}
      mobile={isMobile}
      initialFocus={newSessionBarFocusRef.current}
      onInitialFocusDone={handleNewSessionBarFocusDone}
      onPick={handlePickNewSessionContext}
      onUseDefaultDirectory={handleDefaultDirectoryForNewSession}
      onOpenFolder={handleOpenFolderForNewSession}
      onRefreshWorktrees={handleRefreshNewSessionWorktrees}
      onCreateWorktree={handleCreateNewSessionWorktree}
    />
  ) : null;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    // The answer also lists the project's MCP servers (`mcpFile`, `mcpServers`), unused here: the
    // trust dialog fetches the listing again when it opens, since the file can change in between.
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & Partial<McpErrorResponse>;
      if (!response.ok || data.error) {
        // The dialog translates the reason; the English error is only its diagnostic.
        setProjectTrustError({ error: data.error ?? `HTTP ${response.status}`, ...(data.reason ? { reason: data.reason } : {}) });
        return;
      }
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  // The restricted-mode banner and Settings › MCP's trust notice open the same dialog.
  const openProjectTrustDialog = useCallback(() => {
    setProjectTrustError(null);
    setProjectTrustDialogOpen(true);
  }, []);

  // Settings › MCP added a project server: `.pi/mcp.json` alone makes a folder require trust, and a
  // fresh folder was trusted in the same step. Every mounted section reloads in place on the new
  // status (projectTrustReloadKey); nothing was rebuilt, so the chat needs no new session key.
  const handleProjectTrustChanged = useCallback((cwd: string, status: ProjectTrustStatus) => {
    if (cwd === projectTrustCwd) setProjectTrust(status);
  }, [projectTrustCwd]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // Subagent work tabs: like files, only the active one is mounted.
  const activeAgentTab = agentTabs.find((tab) => `agent:${tab.sessionId}` === activeFileTabId) ?? null;
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const activeNoteTab = noteTabs.find((tab) => `note:${tab.path}` === activeFileTabId) ?? null;
  // Phones show one column at a time: the file tree over the viewer, until a
  // file (or terminal) is picked; the tab bar's folder button reopens it.
  const fileBrowserShown = isMobile ? mobileFilesOpen : !fileTreeCollapsed;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeAppId === "coding"
    ? (activeCwdName ? `${activeCwdName} - Coding` : "Coding")
    : activeApp.label;

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        controlRef={sidebarControlRef}
        onNewSessionContextChange={handleSidebarNewSessionContext}
        initialSessionId={initialSessionId}
        initialSessionLinked={initialLinkedSessionId !== null}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        onSessionsArchived={handleSessionsArchived}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onRevealFiles={() => {
          setRightPanelOpen(true);
          if (isMobile) setSidebarOpen(false);
        }}
        currentApp={activeApp}
        onSwitchApp={switchApp}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionsChange={handleSessionsChange}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = settingsSectionRequiresProject(section) && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate("settings.projectRequired") : label}
              aria-label={label}
              style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 32, padding: 0, background: "none", border: "none",
                borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
                fontSize: 12, opacity: disabled ? 0.35 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
            fontSize: 12, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate("common.settings")}</span>
        </button>
      </div>
    </>
  );

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={openProjectTrustDialog}
        title={translate("trust.resourcesNotLoaded")}
        aria-label={translate("trust.resourcesNotLoaded")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mobileBanner ? "flex-start" : "center",
          gap: 6,
          width: mobileBanner ? "100%" : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : "100%",
          padding: mobileBanner ? "6px 12px" : "0 12px",
          background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "#d97706",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1.35,
          textAlign: "left",
        }}
        data-mobile-trust-banner={mobileBanner ? "true" : undefined}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };

  const handleResetSession = () => {
    if (!selectedSession || resetSessionConfig?.sessionId !== selectedSession.id) return;
    const { choices } = resetSessionConfig;
    const harness = composerHarnessFor(selectedSession, composerHarness);
    projectPreferenceRequestRef.current += 1;
    harnessRef.current = harness;
    setComposerHarness(harness);
    harnessModelRef.current = choices.model;
    setComposerModel(choices.model);
    setCarriedNewSessionChoices({ ...choices, preserveModel: true });
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    handleNewSession(draftId, selectedSession.cwd, workspaceKeyOf(selectedSession), { keepContext: true });
  };

  const renderChatToolbarActions = (mobile: boolean) => {
    if (!mobile && !showChat) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%", minWidth: 0 }}>
        {(() => {
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !selectedSession || selectedSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
              }}
              disabled={disabled}
              title={title}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: TOP_BAR_ICON_BUTTON_SIZE,
                height: "100%", padding: 0,
                background: "none", border: "none",
                borderTop: "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              data-mobile-toolbar-action={mobile ? "name" : undefined}
            >
              {autoNameStatus.kind === "naming" ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 4 5 5L7 22l-5-5Z" />
                  <path d="m14 5 5 5" />
                  <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                </svg>
              )}
            </button>
          );
        })()}
        {(() => {
          const running = digestStatus.kind === "running";
          const boardPath = activeNoteTab?.kind === "board" ? activeNoteTab.path : "";
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || running || !boardPath;
          const label = running
            ? translate("notes.digesting")
            : digestStatus.kind === "success"
              ? translate("notes.digested")
              : digestStatus.kind === "error"
                ? translate("notes.digestFailed")
                : translate("notes.digest");
          const isError = digestStatus.kind === "error";
          const isSuccess = digestStatus.kind === "success";
          return (
            <button
              type="button"
              onClick={() => {
                setDigestFocus("");
                setDigestDialogOpen(true);
              }}
              disabled={disabled}
              title={digestStatus.message || translate(boardPath ? "notes.digestTooltip" : "notes.digestNoBoard")}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: TOP_BAR_ICON_BUTTON_SIZE,
                height: "100%", padding: 0,
                background: "none", border: "none",
                borderTop: "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && !running ? 0.45 : 1,
                flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              data-mobile-toolbar-action={mobile ? "digest" : undefined}
            >
              {running ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="m7 14 3-3 3 3 4-4" />
                </svg>
              )}
            </button>
          );
        })()}
        <ToolbarQuota />
        <button
          type="button"
          onClick={handleResetSession}
          disabled={!selectedSession || resetSessionConfig?.sessionId !== selectedSession.id}
          title={translate("session.resetTooltip")}
          aria-label={translate("session.reset")}
          className="file-panel-terminal-button session-reset-button"
          style={{ height: "100%", borderLeft: 0, borderTop: "2px solid transparent", borderRight: "1px solid var(--border)" }}
          data-mobile-toolbar-action={mobile ? "reset" : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m16 3 5 5a2 2 0 0 1 0 3L11 21H6l-4-4a2 2 0 0 1 0-3L13 3a2 2 0 0 1 3 0Z" />
            <path d="m8 8 9 9M11 21h11" />
          </svg>
        </button>
        {hasSubagentSessions && agentsBadge && (
          <button
            type="button"
            onClick={() => toggleTopPanel("agents", mobile)}
            title={agentsButtonLabel}
            aria-label={agentsButtonLabel}
            aria-pressed={activeTopPanel === "agents"}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
            {!mobile && <span>{translate("agentSwitcher.title")}</span>}
            {/* While subagents run: their count, ringed by a spinner; otherwise all of them. */}
            <span
              aria-hidden="true"
              style={{
                position: "relative",
                minWidth: 15, height: 15, padding: "0 4px", display: "grid", placeItems: "center",
                borderRadius: 7,
                background: agentsBadge.running ? "color-mix(in srgb, var(--accent) 22%, var(--bg-panel))" : "var(--bg-selected)",
                color: "var(--accent)",
                fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
                fontWeight: agentsBadge.running ? 600 : undefined,
                ...(mobile ? { position: "absolute", top: 3, right: 3, minWidth: 13, height: 13, padding: "0 3px", fontSize: 9 } : {}),
              }}
            >
              {agentsBadge.running && (
                <svg
                  className="animate-spin motion-reduce:animate-none"
                  viewBox="0 0 24 24" fill="none" aria-hidden="true"
                  style={{ position: "absolute", top: -3, left: -3, width: "calc(100% + 6px)", height: "calc(100% + 6px)", pointerEvents: "none" }}
                >
                  <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                  <path d="M23 12a11 11 0 0 0-11-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {agentsBadge.count}
            </span>
          </button>
        )}
        {sessionHasBranches && (mobile ? (
          <button
            type="button"
            onClick={() => toggleTopPanel("branches", true)}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={activeTopPanel === "branches"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "branches" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            data-mobile-toolbar-action="branches"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: branchTree.length > 0 ? "var(--accent)" : "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        ) : (
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            locked={branchSwitchLocked}
            inline
            containerRef={topBarRef}
            open={activeTopPanel === "branches"}
            onToggle={() => toggleTopPanel("branches")}
            hasSession
          />
        ))}
      </div>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!showChat || (!sessionStats && !contextUsage))) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
    const formatCompact = formatCompactCount;
    const costText = formatCostShort(cost);

    let contextColor = "var(--text-muted)";
    let desktopContextText: string | null = null;
    let mobileContextText: string | null = null;
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      if (percent !== null && percent > 90) contextColor = "#ef4444";
      else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
      desktopContextText = percent !== null
        ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
        : `? / ${formatCompact(contextUsage.contextWindow)}`;
      mobileContextText = percent !== null ? `${percent.toFixed(0)}%` : null;
    }

    const tooltipParts: string[] = [];
    if (tokens) {
      tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
      tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
      tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
      tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      tooltipParts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    const hasMobileValues = Boolean(
      (tokens && (tokens.input > 0 || tokens.output > 0))
      || costText
      || mobileContextText,
    );

    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        disabled={!showChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        aria-hidden={covered ? true : undefined}
        className={mobile ? "mobile-session-stats" : undefined}
        data-mobile-toolbar-stats={mobile ? "true" : undefined}
        style={{
          marginLeft: mobile ? 0 : "auto",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          flex: mobile ? 1 : undefined,
          minWidth: 0,
          gap: mobile ? 7 : 10,
          paddingLeft: mobile ? 6 : 12,
          paddingRight: mobile ? 6 : 12,
          height: "100%",
          overflow: "hidden",
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {mobile ? (
          <>
            {tokens && tokens.input > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {costText && (
              <span className="mobile-session-stat-cost" style={{ color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
                {costText}
              </span>
            )}
            {mobileContextText && (
              <span style={{ color: contextColor, flexShrink: 0 }}>
                {mobileContextText}
              </span>
            )}
            {!hasMobileValues && showChat && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>
                {translate("session.title")}
              </span>
            )}
          </>
        ) : (
          <>
            {tokens && tokens.input > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {tokens && tokens.cacheRead > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                </svg>
                {formatCompact(tokens.cacheRead)}
              </span>
            )}
            {costText && (
              <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                {costText}
              </span>
            )}
            {desktopContextText && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                </svg>
                {desktopContextText}
              </span>
            )}
          </>
        )}
      </button>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    return (
      <button
        type="button"
        onClick={handleRightPanelToggle}
        disabled={covered}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        aria-hidden={covered ? true : undefined}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !mobile && !sessionStats && !contextUsage ? "auto" : 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: rightPanelOpen ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div
      inert={activeAppId !== "coding"}
      style={{
        display: "flex",
        width: "100%",
        height: "var(--app-viewport-height, 100dvh)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", position: "relative", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}>
          <button
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {isMobile && (
            <div
              ref={mobileToolbarRef}
              data-mobile-toolbar="true"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "stretch",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              {isNarrowMobile && (
                <button
                  type="button"
                  onClick={handleMobileToolbarMoreToggle}
                  title={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-label={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-controls="mobile-toolbar-actions"
                  aria-expanded={mobileToolbarMoreOpen}
                  data-mobile-toolbar-more="true"
                  style={{
                    position: "relative",
                    zIndex: mobileToolbarMoreOpen ? 21 : undefined,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                    background: mobileToolbarMoreOpen ? "var(--bg-selected)" : "none",
                    border: "none", borderRight: "1px solid var(--border)",
                    color: mobileToolbarMoreOpen ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                  }}
                >
                  {mobileToolbarMoreOpen ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                    </svg>
                  )}
                </button>
              )}
              {!isNarrowMobile && renderChatToolbarActions(true)}
              {renderSessionStatsButton(true)}
              {renderMainFileToggle(true)}
              {isNarrowMobile && mobileToolbarMoreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={translate("chat.moreControls")}
                  data-mobile-toolbar-actions="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: TOP_BAR_ICON_BUTTON_SIZE,
                    zIndex: 20,
                    display: "flex",
                    alignItems: "stretch",
                    background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                    boxShadow: "4px 0 18px rgba(0,0,0,0.12)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {renderChatToolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <>
              {renderProjectTrustWarning(false)}
              {renderChatToolbarActions(false)}
              {renderSessionStatsButton(false)}
            </>
          )}
          {!isMobile && renderMainFileToggle(false)}
          {isMobile && sessionHasBranches && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              locked={branchSwitchLocked}
              inline
              compact
              containerRef={topBarRef}
              open={activeTopPanel === "branches"}
              onToggle={() => toggleTopPanel("branches")}
              hasSession={showChat}
              hideInlineButton
            />
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "agents" && activeSessionFamily && selectedSession && (
                <AgentSessionPanel
                  rootSession={activeSessionFamily.root}
                  subagents={activeSessionFamily.subagents}
                  selectedSessionId={selectedSession.id}
                  runningSessionIds={runningSessionIds}
                  onSelectSession={handleSelectSession}
                  openSubagentTabIds={openSubagentTabIds}
                  onToggleSubagentTab={handleToggleSubagentTab}
                />
              )}
              {activeTopPanel === "system" && (
                <SystemPromptPanel
                  loading={systemInfoLoading}
                  prompt={systemPrompt}
                  translate={translate}
                />
              )}
              {activeTopPanel === "tools" && (
                <ToolDefinitionsPanel
                  loading={systemInfoLoading}
                  tools={systemTools}
                  translate={translate}
                />
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const ws = selectedSession;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatActiveDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const projectRows = [
                      ...(ws ? [{ label: translate("session.projectDir"), value: ws.projectRoot ?? ws.cwd, copyField: "projectDir" as const }] : []),
                      ...(ws?.branch ? [{ label: translate("session.gitBranch"), value: ws.branch, copyField: "gitBranch" as const }] : []),
                      ...(ws?.isWorktree ? [{ label: translate("session.gitWorktree"), value: ws.cwd, copyField: "gitWorktree" as const }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompactCount(ctx.contextWindow)}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                    const projectInfoSection = projectRows.length > 0 ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {projectRows.map((row) => (
                            <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null;

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20 }}>
                          {sessionInfoSection}
                          {projectInfoSection}
                        </div>
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
              onSearchTargetHandled={handleSearchTargetHandled}
              initialScrollPosition={selectedSession ? sessionScrollPositionsRef.current.get(selectedSession.id) ?? null : null}
              onScrollPositionChange={handleSessionScrollPositionChange}
              sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionDraftKey={newSessionDraftKey}
              newSessionContextBar={newSessionContextBar}
              initialNewSessionChoices={selectedSession === null ? carriedNewSessionChoices : null}
              onNewSessionChoicesChange={handleNewSessionChoicesChange}
              onSessionConfigChange={handleSessionConfigChange}
              harness={composerHarnessFor(selectedSession, composerHarness)}
              harnessModel={composerModel}
              onHarnessChange={handleHarnessChange}
              onCatalogModelChange={handleCatalogModelChange}
              onProjectPreferenceChange={handleProjectPreferenceChange}
              onAgentEnd={handleAgentEnd}
              onToolEnd={handleToolEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemToolsChange={handleSystemToolsChange}
              onSystemInfoLoaderChange={handleSystemInfoLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onOpenSettings={openSettingsSection}
              onContextUsageChange={handleContextUsageChange}
              onOpenFile={handleOpenLinkedFile}
              onFilesUploaded={handleExplorerRefresh}
              onOpenSubagent={handleOpenSubagentTab}
              onAskInNewChat={handleAskInNewChat}
              quoteSelectionEnabled={quoteSelectionEnabled}
              initialPrompt={pendingQuotePrompt?.sessionId === selectedSession?.id ? pendingQuotePrompt?.text : undefined}
              onInitialPromptConsumed={() => setPendingQuotePrompt(null)}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
              holdAudio={holdAudio}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: the viewer, with the files/notes tree as its rightmost column — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        <div className="right-panel-inner">
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
            {/* Right panel tab bar */}
            <div style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              height: "calc(36px + env(safe-area-inset-top))",
              paddingTop: "env(safe-area-inset-top)",
              background: "var(--bg-panel)",
              borderBottom: "1px solid var(--border)",
            }}>
              <div style={{ flex: 1, overflow: "hidden" }}>
                <TabBar
                  tabs={panelTabs}
                  activeTabId={activeFileTabId ?? ""}
                  onSelectTab={setActiveFileTabId}
                  onCloseTab={handleCloseFileTab}
                />
              </div>
              <button
                type="button"
                onClick={() => { if (activeCwd) handleOpenTerminal(activeCwd); }}
                disabled={!activeCwd}
                title={translate("terminal.open")}
                aria-label={translate("terminal.open")}
                className="file-panel-terminal-button"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </button>
              {/* The files/notes tree: the panel's rightmost column, opened here. */}
              <button
                type="button"
                onClick={() => {
                  if (isMobile) {
                    setMobileFilesOpen((open) => !open);
                    return;
                  }
                  const next = !fileTreeCollapsed;
                  setFileTreeCollapsed(next);
                  saveFileTreeCollapsed(next);
                }}
                aria-pressed={fileBrowserShown}
                title={translate(fileBrowserShown ? "sidebar.collapseTree" : "sidebar.expandTree")}
                aria-label={translate(fileBrowserShown ? "sidebar.collapseTree" : "sidebar.expandTree")}
                className={`file-panel-terminal-button${fileBrowserShown ? " is-active" : ""}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
              </button>
            </div>

            {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
              {activeNoteTab ? (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                  {activeNoteTab.kind === "board" ? (
                    <Whiteboard
                      key={activeNoteTab.path}
                      path={activeNoteTab.path}
                      board={notesBoard}
                      onSaveState={ignoreNoteSaveState}
                      onFlushReady={registerNoteEditor}
                    />
                  ) : (
                    <NoteEditor
                      key={activeNoteTab.path}
                      path={activeNoteTab.path}
                      onSaveState={ignoreNoteSaveState}
                      onFlushReady={registerNoteEditor}
                    />
                  )}
                </div>
              ) : activeFileTab?.filePath ? (
                <FileViewer
                  key={`${fileWorkspaceGeneration}:${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
                  filePath={activeFileTab.filePath}
                  cwd={activeCwd ?? undefined}
                  sourceSessionId={activeFileTab.sourceSessionId}
                  gitRefreshKey={explorerRefreshKey}
                  initialDisplayMode={activeFileTab.initialDisplayMode}
                  initialPage={activeFileTab.page}
                  initialState={activeFileTab.viewerState}
                  watchEnabled={rightPanelOpen}
                  onStateChange={(viewerState) => handleFileViewerStateChange(
                    fileWorkspaceGeneration,
                    activeFileTab.id,
                    activeFileTab.viewerRevision ?? 0,
                    viewerState,
                  )}
                  onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
                  onAtMention={handleAtMention}
                  onOpenFile={(filePath, page) => handleOpenFile(
                    filePath,
                    getFileName(filePath),
                    { sourceSessionId: activeFileTab.sourceSessionId, page },
                  )}
                />
              ) : !activeTerminalTab && !activeAgentTab && !activeNoteTab ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                   {translate("files.noneOpen")}
                </div>
              ) : null}
              {terminalTabs.map((tab) => (
                <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
                  <TerminalPanel
                    tab={tab}
                    active={rightPanelOpen && tab.id === activeFileTabId}
                    onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                    onClosed={() => handleTerminalClosed(tab)}
                    onCloseError={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: undefined } : item))}
                  />
                </div>
              ))}
              {activeAgentTab && (
                <SubagentViewer
                  key={activeAgentTab.sessionId}
                  sessionId={activeAgentTab.sessionId}
                  fallbackLabel={activeAgentTab.label}
                  running={runningSessionIds.has(activeAgentTab.sessionId)}
                  onOpenFile={handleOpenLinkedFile}
                />
              )}
            </div>
          </div>

          {fileBrowserShown && (
            <>
              {!isMobile && (
                <div
                  {...fileBrowserResizer.separatorProps}
                  aria-controls="file-browser"
                  className={`panel-resize-handle file-browser-resize-handle${fileBrowserResizer.isResizing ? " is-resizing" : ""}`}
                  data-resize-handle="file-browser"
                  title={`${translate("layout.resizeFileBrowser")}: ${translate("layout.resizeHint")}`}
                />
              )}
              <div
                ref={fileBrowserResizer.panelRef}
                id="file-browser"
                className={`file-browser-column${isMobile ? " is-overlay" : ""}${fileBrowserResizer.isResizing ? " is-resizing" : ""}`}
                style={{ "--file-browser-width": `${fileBrowserResizer.width}px` } as React.CSSProperties}
              >
                <FileBrowserPane
                  activeFilePath={activeFileTab?.filePath}
                  activeNotePath={activeNoteTab?.path ?? null}
                  cwd={activeCwd}
                  source={treeSource}
                  onSourceChange={(next) => {
                    setTreeSource(next);
                    saveFileTreeSource(next);
                  }}
                  sessionKey={selectedSession?.id ?? null}
                  preservePosition={preservePanel}
                  refreshKey={explorerRefreshKey}
                  onOpenFile={handleOpenFile}
                  onOpenNote={handleOpenNote}
                  onBeforeNoteChange={flushActiveNote}
                  onNoteMoved={handleNoteMoved}
                  onNotesRemoved={handleNotesRemoved}
                  onOpenTerminal={handleOpenTerminal}
                  onAtMention={handleAtMention}
                  onAtMentions={handleAtMentions}
                  onRefresh={handleExplorerRefresh}
                  onBack={isMobile ? () => setMobileFilesOpen(false) : undefined}
                  onCollapse={isMobile ? undefined : () => {
                    setFileTreeCollapsed(true);
                    saveFileTreeCollapsed(true);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    <DashboardApp
      active={activeAppId === "dashboard"}
      currentApp={activeApp}
      onSwitchApp={switchApp}
    />
    <NotesApp
      active={activeAppId === "notes"}
      currentApp={activeApp}
      onSwitchApp={switchApp}
    />
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        quoteSelectionEnabled={quoteSelectionEnabled}
        onQuoteSelectionChange={handleQuoteSelectionChange}
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={() => setSessionKey((key) => key + 1)}
        projectTrust={projectTrust}
        onOpenTrustDialog={openProjectTrustDialog}
        onProjectTrustChanged={handleProjectTrustChanged}
      />
    )}
    {/* After Settings, so it opens above it (z-index 1100 over 1000) when Settings › MCP asks for it. */}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
        onStatus={setProjectTrust}
      />
    )}
    {/* Save to notes: the user says what to focus on, the run only appends to the open board. */}
    {digestDialogOpen && activeNoteTab?.kind === "board" && (
      <div
        className="settings-dialog-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label={translate("notes.digest")}
        onClick={(event) => { if (event.target === event.currentTarget) setDigestDialogOpen(false); }}
        onKeyDown={(event) => { if (event.key === "Escape") setDigestDialogOpen(false); }}
      >
        <form
          className="settings-dialog-surface notes-settings-surface"
          onSubmit={(event) => {
            event.preventDefault();
            if (digestFocus.trim()) void handleDigestToNotes(activeNoteTab.path, digestFocus);
          }}
        >
          <div className="settings-dialog-header">
            <strong className="settings-dialog-title">{translate("notes.digest")}</strong>
            <button type="button" className="notes-agent-icon notes-settings-close" onClick={() => setDigestDialogOpen(false)} aria-label={translate("notes.digestCancel")}>×</button>
          </div>
          <div className="notes-settings-body">
            <p className="notes-settings-hint">{translate("notes.digestDialogHint")}</p>
            <p className="notes-settings-note notes-digest-board">{activeNoteTab.path}</p>
            <textarea
              className="notes-digest-input"
              autoFocus
              value={digestFocus}
              placeholder={translate("notes.digestFocusPlaceholder")}
              onChange={(event) => setDigestFocus(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && digestFocus.trim()) {
                  event.preventDefault();
                  void handleDigestToNotes(activeNoteTab.path, digestFocus);
                }
              }}
            />
            <div className="notes-settings-footer">
              <button type="button" className="notes-agent-settings" onClick={() => setDigestDialogOpen(false)}>
                {translate("notes.digestCancel")}
              </button>
              <button type="submit" className="notes-agent-send" disabled={!digestFocus.trim()}>
                {translate("notes.digestConfirm")}
              </button>
            </div>
          </div>
        </form>
      </div>
    )}
    {/* A failed "save to notes" says why until dismissed: 15s was easy to miss
        while looking at the board, and the toolbar only kept it in a tooltip. */}
    {digestToast && (
      <div style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", width: "min(560px, calc(100vw - 24px))", zIndex: 950, pointerEvents: "none" }}>
        <SidebarToast
          toast={digestToast}
          onDismiss={() => setDigestToast(null)}
          dismissLabel={translate("sidebar.dismiss")}
          durationMs={10 * 60_000}
        />
      </div>
    )}
    </>
  );
}
