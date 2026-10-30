"use client";

import { useEffect, useState } from "react";
import { ConfigButton } from "@/components/SettingsUi";

interface Preview { available: boolean; fingerprint?: string; file?: string; providers: { id: string; modelCount: number }[]; warnings: string[] }
export function DshMigration({ english, onImported }: { english: boolean; onImported: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/harnesses/dsh/migration", { signal: controller.signal, cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((body) => { if (!controller.signal.aborted) setPreview(body); }).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!preview?.available) return null;
  const apply = async () => {
    if (!window.confirm(english ? "Import these legacy gateways into native dsh? Existing providers and legacy files will not be overwritten. OAuth sign-ins are not copied." : "将这些旧网关导入原生 dsh？不会覆盖已有提供方或修改旧文件，也不会复制 OAuth 登录。")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/harnesses/dsh/migration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint: preview.fingerprint }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setMessage(english ? `Imported: ${result.imported.join(", ") || "none"}; existing providers skipped: ${result.skipped.join(", ") || "none"}. Select the default model in native settings.` : `已导入：${result.imported.join("、") || "无"}；已有提供方已跳过：${result.skipped.join("、") || "无"}。请在原生设置中选择默认模型。`);
      onImported();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed"); }
    finally { setBusy(false); }
  };
  return <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
    <ConfigButton size="small" onClick={() => setExpanded((value) => !value)}>{english ? "Preview legacy dsh migration" : "预览旧 dsh 配置迁移"}</ConfigButton>
    {expanded && <div style={{ marginTop: 8 }}>
      <div style={{ overflowWrap: "anywhere" }}>{preview.file}</div>
      <ul>{preview.providers.map((item) => <li key={item.id}>{item.id} · {item.modelCount} {english ? "models" : "模型"}</li>)}{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      <p>{english ? "One-time import only. API keys become native credential references; this preview never includes a key." : "仅在确认后执行一次性导入，此后以原生设置为准；API key 按原生凭据引用保存，预览不返回密钥。"}</p>
      <ConfigButton onClick={() => void apply()} disabled={busy || !preview.providers.length}>{busy ? (english ? "Importing…" : "导入中…") : (english ? "Confirm import" : "确认导入")}</ConfigButton>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
