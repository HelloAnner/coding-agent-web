"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { focusIfLost, listenForStackedDialogEscape } from "@/lib/stacked-dialog";

interface Props {
  parentPath: string;
  description?: string;
  onCancel: () => void;
  onCreated: (path: string) => void | Promise<void>;
}

/** Shared by the directory picker and the sidebar's quick project creation. */
export function CreateDirectoryDialog({ parentPath, description, onCancel, onCreated }: Props) {
  const { t } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const busyRef = useRef(false);
  // If opening/saving the project fails after mkdir, retry that step, not mkdir.
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    inputRef.current?.focus();
    const stopListening = listenForStackedDialogEscape(document, () => {
      if (!busyRef.current) cancelRef.current();
    });
    return () => {
      stopListening();
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) focusIfLost(document, opener);
    };
  }, []);

  const create = async () => {
    if (!name.trim() || busyRef.current) return;
    busyRef.current = true;
    setCreating(true);
    setError(null);
    try {
      let path = createdPath;
      if (!path) {
        const response = await fetch("/api/cwd/browse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: parentPath, name: name.trim() }),
        });
        const data = await response.json() as { path?: string; error?: string };
        if (!response.ok || data.error || !data.path) throw new Error(data.error ?? `HTTP ${response.status}`);
        path = data.path;
        setCreatedPath(path);
      }
      await onCreated(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setCreating(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="create-directory-dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCancel();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busyRef.current) onCancel();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void create(); }} aria-busy={creating}>
        <h2 id={`${id}-title`}>{t("directoryPicker.createDirectory")}</h2>
        <div className="create-directory-body">
          <p id={`${id}-description`}>
            {createdPath ? t("directoryPicker.createdPending") : description ?? t("directoryPicker.createIn", { path: parentPath })}
          </p>
          <label htmlFor={`${id}-name`}>{t("directoryPicker.directoryName")}</label>
          <input
            ref={inputRef}
            id={`${id}-name`}
            className="directory-picker-path create-directory-input"
            value={name}
            required
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("directoryPicker.directoryNamePlaceholder")}
            disabled={creating || createdPath !== null}
            aria-invalid={error && !createdPath ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => { setName(event.target.value); setError(null); }}
          />
          <code className="create-directory-path">{createdPath ?? `${parentPath.replace(/[\\/]$/, "")}/${name.trim()}`}</code>
          {error && <p id={`${id}-error`} className="create-directory-error" role="alert">{error}</p>}
        </div>
        <div className="create-directory-actions">
          <button className="directory-picker-action" type="button" disabled={creating} onClick={onCancel}>{t("i18n.cancel")}</button>
          <button className="directory-picker-action is-primary" type="submit" disabled={creating || !name.trim()}>
            {creating ? t("directoryPicker.creating") : t(createdPath ? "directoryPicker.retry" : "directoryPicker.create")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
