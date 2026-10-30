"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "@/components/SettingsUi";
import { DshMigration } from "./Migration";

export function DshModels() { return <DshNativeView view="models" />; }
export function DshPlugins() { return <DshNativeView view="plugins" />; }

/** The official Client owns plugin configuration/Slots in an independent document and React runtime. */
export function DshNativeView({ view = "plugins", sessionId }: { view?: "plugins" | "models" | "session"; sessionId?: string }) {
  const { locale } = useI18n();
  const english = locale === "en";
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const leaseId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
    let nativeId = "", leasedId = "", visible = false;
    const send = (id: string, active: boolean) => { void fetch("/api/harnesses/dsh/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "view-lease", nativeId: id, leaseId, active }), keepalive: !active }).catch(() => {}); };
    const update = () => {
      const next = visible && document.visibilityState === "visible" ? nativeId : "";
      if (leasedId && leasedId !== next) send(leasedId, false);
      if (next) send(next, true);
      leasedId = next;
    };
    const message = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || event.data?.type !== "coding-agent-dsh-selection" || typeof event.data.nativeId !== "string") return;
      nativeId = event.data.nativeId; update();
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    if (frame.current) observer.observe(frame.current);
    window.addEventListener("message", message);
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, 5000);
    return () => {
      observer.disconnect(); clearInterval(timer);
      window.removeEventListener("message", message); document.removeEventListener("visibilitychange", update);
      if (leasedId) send(leasedId, false);
    };
  }, [revision, view, sessionId]);
  const restart = async () => {
    if (!window.confirm(english ? "Restart the shared dsh Host? All conversations must be idle. Their native histories are preserved." : "重启共享 dsh Host？所有会话和后台任务必须空闲，原生历史会保留。")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/harnesses/dsh/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restart" }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setRevision((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "dsh request failed"); }
    finally { setBusy(false); }
  };
  const url = `/api/harnesses/dsh/native/?view=${view}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`;
  return <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
      <span style={{ flex: 1, color: "var(--text-muted)" }}>{english ? "Native dsh · coding-agent-web profile · shared across projects" : "原生 dsh · coding-agent-web profile · 跨项目共享"}</span>
      <ConfigButton size="small" onClick={() => setRevision((value) => value + 1)} disabled={busy}>{english ? "Reload view" : "刷新视图"}</ConfigButton>
      <ConfigButton size="small" onClick={() => void restart()} disabled={busy}>{busy ? (english ? "Restarting…" : "重启中…") : (english ? "Apply restart" : "应用重启")}</ConfigButton>
    </div>
    {view === "models" && <DshMigration english={english} onImported={() => setRevision((value) => value + 1)} />}
    {error && <div role="alert" style={{ color: "var(--error, #dc2626)", padding: 12, fontSize: 12 }}>{error}</div>}
    <iframe ref={frame} key={revision} src={url} title={english ? "Native dsh" : "dsh 原生管理"} style={{ width: "100%", flex: 1, minHeight: 380, border: 0, background: "var(--bg)" }} allow="clipboard-read; clipboard-write" />
  </div>;
}
