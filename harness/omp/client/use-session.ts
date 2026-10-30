"use client";

import { useMemo, useRef } from "react";
import type { AttachedImage, SessionData } from "../../../hooks/useAgentSession";
import type { AgentMessage } from "../../../lib/types";
import { newOmpId, OmpClientError, ompSessionUrl, sendOmpCommand } from "./api";

type Selection = { provider: string; modelId: string };
export interface OmpIdentity { sessionPath: string; provider: string; model: string; cwd: string }
export interface OmpView extends SessionData {
  running: boolean;
  state?: { isStreaming?: boolean; isPromptRunning?: boolean; model?: { provider: string; id: string }; thinkingLevel?: string };
}
export interface OmpSessionPorts {
  current(): { id: string | null; known: boolean; cwd: string | null; model: Selection | null; thinkingLevel: string | null; busy: boolean; mounted: boolean };
  begin(id: string, text: string, images?: AttachedImage[]): () => void;
  end(clearId: boolean): void;
  restore(text: string, images?: AttachedImage[]): void;
  notice(message: string, warning?: boolean): void;
  connect(id: string): Promise<unknown>;
  created(result: OmpIdentity, text: string): void;
  loading(value: boolean): void;
  view(value: OmpView, preserveMessages?: boolean): void;
  snapshot(messages: AgentMessage[]): void;
  model(value: Selection): void;
  thinking(value: string | null): void;
  switching(value: boolean): void;
  confirm(cwd: string): boolean;
  reconcile(id: string): void;
}

/** Owns the OMP workflow; the shared chat only supplies view setters and callbacks. */
export function useOmpSession() {
  const ports = useRef<OmpSessionPorts | null>(null);
  return useMemo(() => {
    const ui = () => {
      if (!ports.current) throw new Error("OMP view is not attached");
      return ports.current;
    };
    const prepared = new Map<string, OmpIdentity>();
    let submitting = false;
    let cancelled = false;
    let loadRevision = 0;
    let eventRevision = 0;
    const command = async <T,>(id: string, value: Record<string, unknown>): Promise<T> => {
      try { return await sendOmpCommand<T>(id, value); }
      catch (error) {
        if (submitting && cancelled) throw error;
        if (!(error instanceof OmpClientError) || !error.trustCwd || !ui().current().mounted || !ui().confirm(error.trustCwd)) throw error;
        return sendOmpCommand<T>(id, { ...value, trusted: true });
      }
    };
    const load = async (id: string, showLoading = false, includeState = false) => {
      const request = ++loadRevision;
      if (showLoading) ui().loading(true);
      try {
        for (let attempt = 0; ; attempt++) {
          const revision = eventRevision;
          const response = await fetch(ompSessionUrl(id), { cache: "no-store" });
          const value = await response.json() as OmpView & { error?: string };
          if (!response.ok) throw new OmpClientError(value.error ?? `HTTP ${response.status}`, response.status);
          if (request !== loadRevision || !ui().current().mounted || ui().current().id !== id) return null;
          if (revision !== eventRevision && attempt === 0) continue;
          const stale = revision !== eventRevision;
          ui().view(value, stale);
          return includeState && !stale ? { running: value.running, state: value.state } : null;
        }
      } catch (error) {
        if (request === loadRevision && ui().current().id === id) ui().notice(error instanceof Error ? error.message : String(error));
        return null;
      } finally { if (ui().current().id === id) ui().loading(false); }
    };
    return {
      bind(value: OmpSessionPorts) { ports.current = value; },
      load,
      isSubmitting: () => submitting,
      handleEvent(event: { type: string; [key: string]: unknown }): boolean {
        if (["omp_snapshot", "message_end", "agent_start", "agent_end", "agent_settled"].includes(event.type)) eventRevision++;
        if (event.type !== "omp_snapshot") return false;
        if (Array.isArray(event.messages)) ui().snapshot(event.messages as AgentMessage[]);
        return true;
      },
      async submit(text: string, images?: AttachedImage[]) {
        const context = ui().current();
        if (!context.cwd || context.busy) { ui().restore(text, images); return; }
        const id = context.id ?? newOmpId();
        submitting = true;
        cancelled = false;
        loadRevision++;
        const rollback = ui().begin(id, text, images);
        let dispatched = false;
        try {
          if (!context.known && !prepared.has(id)) {
            const result = await command<OmpIdentity>(id, { type: "ensure_session", cwd: context.cwd, message: text,
              provider: context.model?.provider, modelId: context.model?.modelId, thinkingLevel: context.thinkingLevel ?? undefined });
            prepared.set(id, result);
          }
          if (cancelled) throw new OmpClientError("OMP stopped before sending", 409);
          if (ui().current().mounted) await ui().connect(id).catch((error) => { if (ui().current().mounted) throw error; });
          if (cancelled) throw new OmpClientError("OMP stopped before sending", 409);
          dispatched = true;
          const result = await command<OmpIdentity>(id, { type: "prompt", requestId: newOmpId(), message: text, cwd: context.cwd,
            images: images?.map(({ data, mimeType }) => ({ data, mimeType })) });
          if (cancelled) await sendOmpCommand(id, { type: "abort" }).catch(() => ui().notice("OMP accepted the message, but its stop could not be confirmed. Check the running state before retrying.", true));
          ui().created(result, text);
        } catch (error) {
          const uncertain = dispatched && !(error instanceof OmpClientError);
          if (uncertain) {
            ui().notice("Could not confirm the OMP send. It may already be running; the message was not sent again.", true);
            ui().restore(text, images);
            if (prepared.has(id)) ui().created(prepared.get(id)!, text);
            ui().reconcile(id);
            return;
          }
          rollback();
          ui().end(!context.known && !prepared.has(id));
          ui().restore(text, images);
          if (!cancelled) ui().notice(error instanceof Error ? error.message : String(error));
          if (prepared.has(id)) ui().created(prepared.get(id)!, text);
          if (context.known || prepared.has(id)) void load(id, false, true);
        } finally { submitting = false; }
      },
      async selectModel(provider: string, modelId: string): Promise<boolean> {
        const context = ui().current();
        if (context.busy) return false;
        loadRevision++;
        if (!context.id || !context.known && !prepared.has(context.id)) { ui().model({ provider, modelId }); return true; }
        ui().switching(true);
        try {
          const selected = await command<{ provider: string; id: string }>(context.id, { type: "set_model", provider, modelId });
          ui().model({ provider: selected.provider, modelId: selected.id });
          await load(context.id);
          return true;
        } catch (error) { ui().notice(error instanceof Error ? error.message : String(error)); return false; }
        finally { ui().switching(false); }
      },
      async selectThinking(level: string) {
        const context = ui().current();
        if (context.busy) return;
        loadRevision++;
        if (level === "auto" || !context.id || !context.known && !prepared.has(context.id)) {
          ui().thinking(level === "auto" ? null : level);
          if (context.id && (context.known || prepared.has(context.id))) await load(context.id);
          return;
        }
        try {
          const selected = await command<{ level: string }>(context.id, { type: "set_thinking_level", level });
          ui().thinking(selected.level);
        } catch (error) { ui().notice(error instanceof Error ? error.message : String(error)); }
      },
      async abort() {
        cancelled = true;
        const id = ui().current().id;
        if (!id) return;
        try { await sendOmpCommand(id, { type: "abort" }); }
        catch (error) { if (!(submitting && error instanceof OmpClientError && error.status === 404)) ui().notice(error instanceof Error ? error.message : String(error)); }
      },
      async respond(id: string, value: Record<string, unknown>) {
        const sessionId = ui().current().id;
        if (!sessionId) return;
        await sendOmpCommand(sessionId, { type: "extension_ui_response", id, ...value });
      },
    };
  }, []);
}
