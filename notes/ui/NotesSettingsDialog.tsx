"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfigButton, ConfigField } from "@/components/SettingsUi";
import { listenForPanelEscape } from "@/lib/stacked-dialog";
import type { NotesAgentSkill, NotesSettings } from "@/notes/types";

/**
 * Notes settings: the agent's model and the whiteboard's element defaults.
 * These are notes-wide, so the dialog sits above the app like Coding's
 * Settings does, and every section saves its own half of the file.
 */

type Section = "agent" | "board" | "skills";

const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: "agent", label: "Agent 模型" },
  { id: "board", label: "白板" },
  { id: "skills", label: "技能" },
];

const API_OPTIONS = [
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

export function NotesSettingsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: NotesSettings) => void;
}) {
  const [section, setSection] = useState<Section>("agent");
  const [skills, setSkills] = useState<NotesAgentSkill[]>([]);
  const [fonts, setFonts] = useState<{ value: number; label: string }[]>([]);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [effective, setEffective] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotesSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => listenForPanelEscape(document, onClose), [onClose]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    fetch("/api/notes/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { settings?: NotesSettings; apiKeySet?: boolean; effective?: string | null; file?: string; skills?: NotesAgentSkill[]; fonts?: { value: number; label: string }[]; error?: string };
        if (!response.ok || !body.settings) throw new Error(body.error || "读取设置失败");
        setDraft(body.settings);
        setApiKeySet(body.apiKeySet ?? false);
        setEffective(body.effective ?? null);
        setFile(body.file ?? null);
        setSkills(body.skills ?? []);
        setFonts(body.fonts ?? []);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "读取设置失败"));
  }, [open]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/notes/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: draft.agent, board: draft.board }),
      });
      const body = await response.json() as { settings?: NotesSettings; apiKeySet?: boolean; effective?: string | null; skills?: NotesAgentSkill[]; error?: string };
      if (!response.ok || !body.settings) throw new Error(body.error || "保存失败");
      setDraft(body.settings);
      setApiKeySet(body.apiKeySet ?? false);
      setEffective(body.effective ?? null);
      setSkills(body.skills ?? []);
      setSaved(true);
      onSaved(body.settings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  if (!open) return null;

  const agent = draft?.agent;
  const board = draft?.board;

  return (
    <div
      className="settings-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="笔记设置"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="settings-dialog-surface notes-settings-surface">
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">笔记设置</strong>
          <nav className="settings-section-tabs" aria-label="笔记设置">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="settings-section-tab"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <button type="button" className="notes-agent-icon notes-settings-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="notes-settings-body">
          {!draft && !error && <div className="notes-settings-loading">加载设置…</div>}
          {section === "agent" && agent && (
            <section className="notes-settings-section">
              <p className="notes-settings-hint">
                笔记 agent 用自己的模型。地址和模型留空时，直接用本机 pi 已经配好的默认模型。
              </p>
              <p className="notes-settings-note">
                当前生效：<strong>{effective ?? (agent.model ? `notes/${agent.model}` : "pi 默认模型")}</strong>
              </p>
              {file && <p className="notes-settings-note">配置文件：<code>{file}</code></p>}
              <div className="notes-settings-grid">
                <ConfigField label="接口地址（Base URL）">
                  <input
                    className="notes-config-input"
                    value={agent.baseUrl}
                    placeholder="留空 = 用 pi 默认模型"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, agent: { ...agent, baseUrl: event.target.value } })}
                  />
                </ConfigField>
                <ConfigField label="API Key">
                  <input
                    className="notes-config-input"
                    type="password"
                    value={agent.apiKey}
                    placeholder={apiKeySet ? "已保存，留空表示不修改" : "sk-…（本地服务可留空）"}
                    spellCheck={false}
                    autoComplete="new-password"
                    onChange={(event) => setDraft({ ...draft, agent: { ...agent, apiKey: event.target.value } })}
                  />
                </ConfigField>
                <ConfigField label="模型名">
                  <input
                    className="notes-config-input"
                    value={agent.model}
                    placeholder="留空 = 用 pi 默认模型"
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, agent: { ...agent, model: event.target.value } })}
                  />
                </ConfigField>
                <ConfigField label="接口协议">
                  <select
                    className="notes-config-input"
                    value={agent.api}
                    onChange={(event) => setDraft({ ...draft, agent: { ...agent, api: event.target.value } })}
                  >
                    {API_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </ConfigField>
                <ConfigField label="上下文窗口（tokens）">
                  <input
                    className="notes-config-input"
                    type="number"
                    value={agent.contextWindow}
                    onChange={(event) => setDraft({ ...draft, agent: { ...agent, contextWindow: Number(event.target.value) } })}
                  />
                </ConfigField>
                <ConfigField label="单次输出上限（tokens）">
                  <input
                    className="notes-config-input"
                    type="number"
                    value={agent.maxTokens}
                    onChange={(event) => setDraft({ ...draft, agent: { ...agent, maxTokens: Number(event.target.value) } })}
                  />
                </ConfigField>
              </div>
              <p className="notes-settings-note">改模型会清空当前对话：新会话看不到旧上下文。</p>
            </section>
          )}

          {section === "board" && board && (
            <section className="notes-settings-section">
              <p className="notes-settings-hint">新画的元素用这里的字体和字号；白板上已有的元素保持自己的样式。</p>
              <div className="notes-settings-grid">
                <ConfigField label="字体">
                  <select
                    className="notes-config-input"
                    value={board.fontFamily}
                    onChange={(event) => setDraft({ ...draft, board: { ...board, fontFamily: Number(event.target.value) } })}
                  >
                    {fonts.map((font) => (
                      <option key={font.value} value={font.value}>{font.label}</option>
                    ))}
                  </select>
                </ConfigField>
                <ConfigField label="字号（px）">
                  <input
                    className="notes-config-input"
                    type="number"
                    min={10}
                    max={64}
                    value={board.fontSize}
                    onChange={(event) => setDraft({ ...draft, board: { ...board, fontSize: Number(event.target.value) } })}
                  />
                </ConfigField>
              </div>
            </section>
          )}

          {section === "skills" && (
            <section className="notes-settings-section">
              <p className="notes-settings-hint">
                技能放在 <code>notes/skills/&lt;名字&gt;/SKILL.md</code>，每个目录一个技能；agent 按描述决定什么时候读它。
              </p>
              {skills.length === 0 && <p className="notes-settings-note">还没有技能。</p>}
              <ul className="notes-settings-skills">
                {skills.map((skill) => (
                  <li key={skill.name}>
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                    <code>{skill.path}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error && <div className="notes-settings-error" role="alert">{error}</div>}

          <div className="notes-settings-footer">
            {saved && <span className="notes-settings-saved">已保存</span>}
            {section !== "skills" && (
              <ConfigButton variant="primary" disabled={saving || !draft} onClick={() => void save()}>
                {saving ? "保存中…" : "保存"}
              </ConfigButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
