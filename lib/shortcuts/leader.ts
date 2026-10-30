/**
 * ⌃E 之后的第二步：退出编辑区是第一步，紧跟着的这一个键决定做什么。
 * 表在这里，分发器和提示条都读它，加一条命令只改这一处。
 */

import { isLeaderKey, type ShortcutEvent } from "./keys";

/** 按下 ⌃E 后留给第二步的毫秒数。 */
export const LEADER_TIMEOUT_MS = 1200;

export type LeaderCommandId = "sidebar" | "archive" | "rename" | "new";

export interface LeaderCommand {
  id: LeaderCommandId;
  /** ⌃E 之后的那个键；空串表示再按一次 ⌃E。 */
  key: "" | "d" | "r" | "n";
  /** 提示条上的文字。 */
  labelKey: string;
}

export const LEADER_COMMANDS: readonly LeaderCommand[] = [
  { id: "sidebar", key: "", labelKey: "shortcuts.leaderSidebar" },
  { id: "archive", key: "d", labelKey: "shortcuts.leaderArchive" },
  { id: "rename", key: "r", labelKey: "shortcuts.leaderRename" },
  { id: "new", key: "n", labelKey: "shortcuts.leaderNew" },
];

/**
 * ⌃E 已按下时，这个键选中哪一条命令；没有就是空（调用方结束这一轮）。
 * ⌃E ⌃E 是"去侧栏"，所以这里也认 ⌃E。
 */
export function leaderCommandFor(event: ShortcutEvent): LeaderCommand | null {
  if (isLeaderKey(event)) return LEADER_COMMANDS.find((command) => command.key === "") ?? null;
  // 第二步是裸敲的字母：⌃E 松手之后再按 D。
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return LEADER_COMMANDS.find((command) => command.key !== "" && command.key === key) ?? null;
}
