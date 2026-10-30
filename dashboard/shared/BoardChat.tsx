"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import type { SessionInfo } from "@/lib/types";
import type { DashboardBoard } from "../boards";
import { boardCwd, boardDraftKey, boardSessions, forgetSessionCache, rememberBoardSession, readBoardSession } from "./board-context";

/** A conversation in the board's folder reads better with the folder's name. */
function folderName(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

function sessionLabel(session: SessionInfo): string {
  const title = session.name || session.firstMessage || session.id.slice(0, 12);
  return title.length > 48 ? `${title.slice(0, 48)}…` : title;
}

/**
 * The dashboard's right-hand chat, shared by every board. It is the coding
 * composer, unchanged: the same harness list, the same model picker, the same
 * session runtime. The only difference is the folder it starts in — the board's
 * own data directory, which carries the board's AGENTS.md.
 */
export function BoardChat({
  board,
  active,
  onClose,
}: {
  board: DashboardBoard;
  active: boolean;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [session, setSession] = useState<SessionInfo | null>(() => readBoardSession(board));
  const [recent, setRecent] = useState<SessionInfo[]>([]);
  const [harness, setHarness] = useState("pi");
  const [harnessModel, setHarnessModel] = useState<{ provider: string; modelId: string } | null>(null);
  const draftKey = useMemo(() => boardDraftKey(board), [board]);

  const loadRecent = useCallback(async (folder: string) => {
    setRecent(await boardSessions(board, folder));
  }, [board]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const folder = await boardCwd(board);
        if (cancelled) return;
        setCwd(folder);
        await loadRecent(folder);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "看板目录不可用");
      }
    })();
    return () => { cancelled = true; };
  }, [active, board, loadRecent]);

  // The board's own folder remembers its harness and model, exactly as a
  // project folder does in coding.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void fetch(`/api/project-preferences?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { preference?: { harness?: string; provider?: string; model?: string } } | null) => {
        if (cancelled || !body?.preference?.harness) return;
        setHarness(body.preference.harness);
        if (body.preference.provider && body.preference.model) {
          setHarnessModel({ provider: body.preference.provider, modelId: body.preference.model });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  const savePreference = useCallback((folder: string, preference: { harness: string; provider?: string; model?: string }) => {
    void fetch("/api/project-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: folder,
        harness: preference.harness,
        provider: preference.provider ?? "",
        model: preference.model ?? "",
      }),
    }).catch(() => {});
  }, []);

  const handleSessionCreated = useCallback((created: SessionInfo) => {
    setSession(created);
    rememberBoardSession(board, created);
    forgetSessionCache();
    void loadRecent(created.cwd || cwd);
  }, [board, cwd, loadRecent]);

  const pickSession = (id: string) => {
    if (!id) {
      setSession(null);
      rememberBoardSession(board, null);
      return;
    }
    const picked = recent.find((row) => row.id === id) ?? null;
    setSession(picked);
    rememberBoardSession(board, picked);
  };

  return (
    <div className="board-chat" aria-label={`${board.label} 对话`} role="region">
      <header className="board-chat-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6a8 8 0 0 1-.9-3.6A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z" />
        </svg>
        <strong className="board-chat-title">{board.label}</strong>
        <span className="board-chat-folder" title={cwd || board.dataDir}>{cwd ? folderName(cwd) : "…"}</span>
        <button type="button" className="board-chat-close" aria-label="关闭对话" onClick={onClose}>×</button>
      </header>

      <div className="board-chat-tools">
        <select
          aria-label="看板对话历史"
          value={session?.id ?? ""}
          onChange={(event) => pickSession(event.target.value)}
          disabled={!cwd}
        >
          <option value="">新对话</option>
          {recent.map((row) => (
            <option key={row.id} value={row.id}>{sessionLabel(row)}</option>
          ))}
        </select>
        <span className="board-chat-hint">固定目录 · 可加数据</span>
      </div>

      <div className="board-chat-body">
        {error ? (
          <p className="board-chat-error" role="alert">{error}</p>
        ) : !cwd ? (
          <p className="board-chat-error" role="status">读取看板目录…</p>
        ) : (
          <ChatWindow
            key={board.id}
            session={session}
            newSessionCwd={cwd}
            newSessionDraftKey={draftKey}
            newSessionContextBar={(
              <p className="board-chat-context">
                <span className="board-chat-context-label">固定目录</span>
                <code>{board.dataDir}</code>
                <span>可让它查数、补数据</span>
              </p>
            )}
            harness={harness}
            harnessModel={harnessModel}
            onHarnessChange={(id) => {
              setHarness(id);
              savePreference(cwd, { harness: id });
            }}
            onCatalogModelChange={(provider, modelId) => {
              setHarnessModel({ provider, modelId });
              savePreference(cwd, { harness, provider, model: modelId });
            }}
            onProjectPreferenceChange={(nextHarness, provider, modelId) => {
              savePreference(cwd, { harness: nextHarness, provider, model: modelId });
            }}
            onSessionCreated={handleSessionCreated}
            onFilesUploaded={() => { void loadRecent(cwd); }}
            soundEnabled={false}
          />
        )}
      </div>
    </div>
  );
}
