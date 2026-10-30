/**
 * 全局快捷键：哪个 keydown 是哪一个快捷键，以及什么时候这个键属于别人
 * （输入框、菜单、对话框、终端）。纯函数，不依赖 React 和 DOM 之外的任何东西，
 * 所以可以直接在 node 里测。
 *
 * 这套键是用户自己定的，刻意避开浏览器：
 * 不碰任何 ⌘+字母（⌘T ⌘W ⌘L ⌘F ⌘1–9 都是标签页的），
 * 只取 ⌘↑↓、⌘⇧↑↓、⌃⇧↑↓、⌃E、⌃↵，加上没有输入框时的裸 j / k / ↵。
 */

/** 走一步：+1 往下（更新的 / 后一个），-1 往上。 */
export type Step = -1 | 1;

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: EventTarget | null;
}

const DOWN_KEYS = new Set(["ArrowDown", "Down"]);
const UP_KEYS = new Set(["ArrowUp", "Up"]);

function arrowStep(event: ShortcutEvent): Step | 0 {
  if (DOWN_KEYS.has(event.key)) return 1;
  if (UP_KEYS.has(event.key)) return -1;
  return 0;
}

/** ⌘↑ / ⌘↓：侧栏里看得见的会话，往前 / 往后一个。 */
export function stepSessionKey(event: ShortcutEvent): Step | 0 {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return 0;
  return arrowStep(event);
}

/** ⌘⇧↑ / ⌘⇧↓：下一个 / 上一个未读（跳过去就算读过）。 */
export function stepUnreadKey(event: ShortcutEvent): Step | 0 {
  if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey) return 0;
  return arrowStep(event);
}

/** ⌃⇧↑ / ⌃⇧↓：下一个 / 上一个项目（每个项目的第一条会话，整组跳过）。 */
export function stepProjectKey(event: ShortcutEvent): Step | 0 {
  if (event.metaKey || !event.ctrlKey || !event.shiftKey || event.altKey) return 0;
  return arrowStep(event);
}

/** ⌃⌥↑ / ⌃⌥↓：下一个 / 上一个还在转圈的会话。 */
export function stepRunningKey(event: ShortcutEvent): Step | 0 {
  if (event.metaKey || !event.ctrlKey || !event.altKey || event.shiftKey) return 0;
  return arrowStep(event);
}

/** ⌃N：在当前会话的项目下开一条新会话。 */
export function isNewSessionKey(event: ShortcutEvent): boolean {
  return !event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n";
}

/** ⌃E：退出编辑区，同时是下面一串命令的开头。 */
export function isLeaderKey(event: ShortcutEvent): boolean {
  return !event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "e";
}

/** ⌃↵：回到中间的对话输入框。 */
export function isFocusComposerKey(event: ShortcutEvent): boolean {
  return !event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Enter";
}

/** 裸 j / k：滚对话。 */
export function scrollChatKey(event: ShortcutEvent): Step | 0 {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return 0;
  const key = event.key.toLowerCase();
  if (key === "j") return 1;
  if (key === "k") return -1;
  return 0;
}

/** 裸 ↵：焦点回输入框。 */
export function isEnterFocusKey(event: ShortcutEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Enter";
}

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

/** 焦点在能打字的地方：那里的键是那个控件的。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return hasClosest(target, EDITABLE_SELECTOR);
}

/**
 * 焦点在一个自己吃键的地方：菜单、对话框、终端。终端里键盘归 shell，
 * 所以整块区域连 j / k 都不许我们碰。
 */
export function isOwnedByOverlay(target: EventTarget | null): boolean {
  return hasClosest(target, '[role="menu"], [role="dialog"], [aria-modal="true"], dialog[open], .xterm');
}

/**
 * ↵ 落在按钮上时是那个按钮的：不抢。侧栏的行、标签、菜单项都是按钮，
 * 抢了它们就等于把整块界面变哑。
 */
export function isActivatableTarget(target: EventTarget | null): boolean {
  return hasClosest(target, "button, a[href], summary, [role='button'], [role='tab'], [role='menuitem'], [role='option']");
}

function hasClosest(target: EventTarget | null, selector: string): boolean {
  const element = target as Element | null;
  return Boolean(element?.closest?.(selector));
}
