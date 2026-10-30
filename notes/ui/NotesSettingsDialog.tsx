"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfigButton, ConfigField } from "@/components/SettingsUi";
import { listenForPanelEscape } from "@/lib/stacked-dialog";
import type { NotesAgentSkill, NotesSettings } from "@/notes/types";

/**
 * Notes-wide whiteboard preferences and the unchanged agent's skills.
 * Model/auth configuration is inherited, never edited here.
 */

type Section = "board" | "skills";

const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: "board", label: "白板" },
  { id: "skills", label: "技能" },
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
  const [section, setSection] = useState<Section>("board");
  const [skills, setSkills] = useState<NotesAgentSkill[]>([]);
  const [fonts, setFonts] = useState<{ value: number; label: string }[]>([]);
  const [draft, setDraft] = useState<NotesSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    return listenForPanelEscape(document, onClose);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    fetch("/api/notes/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { settings?: NotesSettings; skills?: NotesAgentSkill[]; fonts?: { value: number; label: string }[]; error?: string };
        if (!response.ok || !body.settings) throw new Error(body.error || "读取设置失败");
        setDraft(body.settings);
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
        body: JSON.stringify({ board: draft.board }),
      });
      const body = await response.json() as { settings?: NotesSettings; skills?: NotesAgentSkill[]; error?: string };
      if (!response.ok || !body.settings) throw new Error(body.error || "保存失败");
      setDraft(body.settings);
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
