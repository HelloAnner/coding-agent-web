"use client";

import { useEffect, useRef, useState } from "react";
import {
  isActivatableTarget,
  isEditableTarget,
  isEnterFocusKey,
  isFocusComposerKey,
  isLeaderKey,
  isNewSessionKey,
  isOwnedByOverlay,
  scrollChatKey,
  stepProjectKey,
  stepRunningKey,
  stepSessionKey,
  stepUnreadKey,
  type ShortcutEvent,
  type Step,
} from "./keys";
import { LEADER_TIMEOUT_MS, leaderCommandFor, type LeaderCommandId } from "./leader";
import { scrollChatBy } from "./scroll";

export interface ShortcutHandlers {
  /** ⌘↑ / ⌘↓ */
  onStepSession(step: Step): void;
  /** ⌘⇧↑ / ⌘⇧↓ */
  onStepUnread(step: Step): void;
  /** ⌃⇧↑ / ⌃⇧↓ */
  onStepProject(step: Step): void;
  /** ⌃⌥↑ / ⌃⌥↓ */
  onStepRunning(step: Step): void;
  /** ⌃N */
  onNewSessionInProject(): void;
  /** ⌃↵，以及没有焦点时的 ↵ */
  onFocusComposer(): void;
  /** ⌃E ⌃E */
  onFocusSidebar(): void;
  /** ⌃E D */
  onArchiveSession(): void;
  /** ⌃E R */
  onRenameSession(): void;
  /** ⌃E N */
  onNewSession(): void;
}

/**
 * 全局快捷键的唯一监听者。
 *
 * 顺序就是优先级：菜单 / 对话框 / 终端里的键先让给它们；⌃E 已经开始的那一轮
 * 先结束；然后是几个带修饰的跳转（在输入框里也照跳，那是它们存在的理由）；
 * 最后才是 j / k / ↵ 这几个只属于"手不在键盘输入区"的裸键。
 *
 * 返回 ⌃E 是否还在等人按第二步，提示条据此显示。
 */
export function useShortcuts({ enabled, ...handlers }: ShortcutHandlers & { enabled: boolean }): { leaderArmed: boolean } {
  const [leaderArmed, setLeaderArmed] = useState(false);
  const armedUntilRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const handlersRef = useRef<ShortcutHandlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const runLeader = (id: LeaderCommandId): void => {
      const current = handlersRef.current;
      if (id === "sidebar") current.onFocusSidebar();
      else if (id === "archive") current.onArchiveSession();
      else if (id === "rename") current.onRenameSession();
      else current.onNewSession();
    };

    const disarm = (): void => {
      armedUntilRef.current = 0;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setLeaderArmed(false);
    };

    const arm = (): void => {
      armedUntilRef.current = Date.now() + LEADER_TIMEOUT_MS;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (Date.now() >= armedUntilRef.current) disarm();
      }, LEADER_TIMEOUT_MS + 20);
      setLeaderArmed(true);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // 输入法候选期间的键一个都不拦。
      if (event.isComposing || event.keyCode === 229) return;

      const shortcut: ShortcutEvent = event;
      const target = event.target;

      // ---- 菜单、对话框、终端：不让 ----
      if (isOwnedByOverlay(target)) {
        if (armedUntilRef.current > Date.now()) disarm();
        return;
      }

      // ---- ⌃E 已经开始的那一轮 ----
      if (armedUntilRef.current > Date.now()) {
        const command = leaderCommandFor(shortcut);
        // 不认识就结束这一轮，让这个键按自己的规矩走下去（比如 j 照样滚）。
        disarm();
        if (command) {
          event.preventDefault();
          runLeader(command.id);
          return;
        }
      }

      // ---- ⌃E：退出编辑区，同时开始一轮 ----
      if (isLeaderKey(shortcut)) {
        event.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        if (active && isEditableTarget(active)) active.blur();
        arm();
        return;
      }

      // ---- 跳会话：输入框里也照跳 ----
      const session = stepSessionKey(shortcut);
      if (session) {
        event.preventDefault();
        handlersRef.current.onStepSession(session);
        return;
      }
      const unread = stepUnreadKey(shortcut);
      if (unread) {
        event.preventDefault();
        handlersRef.current.onStepUnread(unread);
        return;
      }
      const project = stepProjectKey(shortcut);
      if (project) {
        event.preventDefault();
        handlersRef.current.onStepProject(project);
        return;
      }
      const running = stepRunningKey(shortcut);
      if (running) {
        event.preventDefault();
        handlersRef.current.onStepRunning(running);
        return;
      }

      // ⌃N: a new session in the open session's project, from anywhere (the
      // composer's draft is kept, as with ⌃⌥N).
      if (isNewSessionKey(shortcut)) {
        event.preventDefault();
        handlersRef.current.onNewSessionInProject();
        return;
      }

      // 再往下都是裸键：手在输入框里时它们是那个输入框的。
      if (isEditableTarget(target)) return;

      if (isFocusComposerKey(shortcut)) {
        event.preventDefault();
        handlersRef.current.onFocusComposer();
        return;
      }

      if (isEnterFocusKey(shortcut) && !isActivatableTarget(target)) {
        event.preventDefault();
        handlersRef.current.onFocusComposer();
        return;
      }

      const scroll = scrollChatKey(shortcut);
      if (scroll) {
        event.preventDefault();
        scrollChatBy(scroll);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      disarm();
    };
  }, [enabled]);

  return { leaderArmed };
}
