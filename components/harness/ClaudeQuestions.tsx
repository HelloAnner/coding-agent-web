"use client";

import { useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ExtensionUiRequest } from "@/lib/types";

type Questions = NonNullable<Extract<ExtensionUiRequest, { method: "editor" }>["questions"]>;

/** The CLI receives the original question text as each answer's key. */
export function ClaudeQuestions({ questions, onChange }: { questions: Questions; onChange: (answers: Record<string, string>) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const update = (question: Questions[number], values: string[], text: string) => {
    const nextSelected = { ...selected, [question.question]: values };
    const nextOther = { ...other, [question.question]: text };
    setSelected(nextSelected);
    setOther(nextOther);
    onChange(Object.fromEntries(questions.map((item) => [item.question, [...(nextSelected[item.question] ?? []), nextOther[item.question]?.trim() ?? ""].filter(Boolean).join(", ")])));
  };
  return (
    <div style={{ display: "grid", gap: 20 }}>
      {questions.map((question, index) => (
        <fieldset key={question.question} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 10, whiteSpace: "pre-wrap" }}>{question.question}</legend>
          <div style={{ display: "grid", gap: 8 }}>
            {question.options.map((option) => (
              <label key={option.label} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)", cursor: "pointer" }}>
                <input type={question.multiSelect ? "checkbox" : "radio"} name={`${id}-${index}`} checked={(selected[question.question] ?? []).includes(option.label)} onChange={(event) => {
                  const values = question.multiSelect
                    ? event.target.checked ? [...(selected[question.question] ?? []), option.label] : (selected[question.question] ?? []).filter((value) => value !== option.label)
                    : [option.label];
                  update(question, values, question.multiSelect ? other[question.question] ?? "" : "");
                }} style={{ marginTop: 3, accentColor: "var(--accent)" }} />
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <span style={{ display: "block", fontWeight: 550 }}>{option.label}</span>
                  {option.description && <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 12 }}>{option.description}</span>}
                </span>
              </label>
            ))}
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
              {t("harness.claudeOther")}
              <input value={other[question.question] ?? ""} onChange={(event) => update(question, question.multiSelect ? selected[question.question] ?? [] : [], event.target.value)} style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)", color: "var(--text)", padding: "9px 10px", fontSize: 13 }} />
            </label>
          </div>
        </fieldset>
      ))}
    </div>
  );
}
