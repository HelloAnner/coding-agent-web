"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "@/components/SettingsUi";
import { focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";
import type { DshInteraction } from "../web-session";
import { record, records } from "../web-projection";
import { DshNativeView } from "./NativeView";

function QuestionForm({ item, answer, english }: { item: DshInteraction; answer: (value: unknown) => Promise<void>; english: boolean }) {
  const questions = records(item.request.questions);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (value: unknown) => { setBusy(true); try { await answer(value); } finally { setBusy(false); } };
  return <form onSubmit={(event) => { event.preventDefault(); void submit({ answers: questions.map((question) => ({ id: question.id, selected: selected[String(question.id)] ?? [], ...(custom[String(question.id)]?.trim() ? { custom: custom[String(question.id)].trim() } : {}) })) }); }}>
    {questions.map((question) => {
      const id = String(question.id);
      return <fieldset key={id} disabled={busy} style={{ border: 0, padding: "4px 0 10px" }}>
        <legend>{String(question.question ?? question.header ?? id)}</legend>
        {records(question.options).map((option) => {
          const label = String(option.label);
          return <label key={label} style={{ display: "block", padding: "4px 0" }}><input type={question.multiSelect ? "checkbox" : "radio"} name={`${item.id}:${id}`} checked={selected[id]?.includes(label) ?? false} onChange={(event) => setSelected((current) => ({ ...current, [id]: question.multiSelect ? (event.target.checked ? [...current[id] ?? [], label] : (current[id] ?? []).filter((value) => value !== label)) : [label] }))} /> {label}{typeof option.description === "string" && <span style={{ color: "var(--text-muted)" }}> — {option.description}</span>}</label>;
        })}
        <label style={{ display: "block" }}>{english ? "Other answer" : "补充回答"}<textarea value={custom[id] ?? ""} onChange={(event) => setCustom((current) => ({ ...current, [id]: event.target.value }))} rows={2} maxLength={20000} style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: 6 }} /></label>
      </fieldset>;
    })}
    <ConfigButton type="submit" variant="primary" disabled={busy || !questions.length || questions.some((question) => !selected[String(question.id)]?.length && !custom[String(question.id)]?.trim())}>{english ? "Submit answer" : "提交回答"}</ConfigButton>
  </form>;
}

function NativeSessionDialog({ sessionId, onClose, english }: { sessionId: string; onClose: () => void; english: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => focusModalPanel(document, panel.current), []);
  useEffect(() => listenForPanelEscape(document, onClose), [onClose]);
  return <div ref={panel} role="dialog" aria-modal="true" aria-label={english ? "Native dsh extensions" : "dsh 原生扩展视图"} tabIndex={-1} className="settings-dialog-backdrop">
    <div className="settings-dialog-surface" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}><strong style={{ flex: 1 }}>{english ? "Same native conversation · extension view" : "同一原生会话 · 扩展视图"}</strong><ConfigButton onClick={onClose}>{english ? "Close" : "关闭"}</ConfigButton></div>
      <div style={{ flex: 1, minHeight: 0 }}><DshNativeView view="session" sessionId={sessionId} /></div>
    </div>
  </div>;
}

/** Native approvals/questions and Client-only extensions stay on the dsh side of the shared chat. */
export function DshSessionPanel({ sessionId, active }: { sessionId: string; active: boolean }) {
  const { locale } = useI18n();
  const english = locale === "en";
  const [items, setItems] = useState<DshInteraction[]>([]);
  const [error, setError] = useState("");
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/dsh/${encodeURIComponent(sessionId)}?interactions=1`, { signal: abort.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (!abort.signal.aborted) setItems(body.interactions ?? []);
      } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "dsh connection failed"); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => void poll(), active ? 1000 : 3000); }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [sessionId, active]);
  const answer = async (item: DshInteraction, value: unknown) => {
    setBusy(item.id); setError("");
    try {
      const response = await fetch(`/api/dsh/${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "answer_interaction", eventId: item.id, value }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setItems((current) => current.filter((value) => value.id !== item.id));
    } catch (error) { setError(error instanceof Error ? error.message : "dsh answer failed"); }
    finally { setBusy(null); }
  };
  return <div style={{ padding: "6px 12px", fontSize: 12 }}>
    <ConfigButton size="small" onClick={() => setNative(true)} disabled={active || items.length > 0}>{english ? "Native extension view" : "原生扩展视图"}</ConfigButton>
    {error && <p role="alert" style={{ color: "var(--error, #dc2626)" }}>{error}</p>}
    {items.map((item) => <section key={item.id} role="alert" style={{ marginTop: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      {item.event === "approval/request" ? <>
        <strong>{english ? "dsh requests approval" : "dsh 请求授权"} · {String(item.request.toolName ?? "tool")}</strong>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(record(item.request.displayReason)[english ? "en" : "zh"] ?? item.request.reason ?? (english ? "Allow this operation once?" : "是否仅允许这一次操作？"))}</p>
        <div style={{ display: "flex", gap: 8 }}><ConfigButton variant="primary" disabled={busy === item.id} onClick={() => void answer(item, "allowed-once")}>{english ? "Allow once" : "仅允许一次"}</ConfigButton><ConfigButton variant="danger" disabled={busy === item.id} onClick={() => void answer(item, "rejected")}>{english ? "Reject" : "拒绝"}</ConfigButton></div>
      </> : <QuestionForm item={item} english={english} answer={(value) => answer(item, value)} />}
    </section>)}
    {native && <NativeSessionDialog sessionId={sessionId} onClose={() => setNative(false)} english={english} />}
  </div>;
}
