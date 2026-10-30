/**
 * 聊天区的滚动入口：ChatWindow 拥有那个滚动容器，这里只留一个函数位，
 * 让 j / k 不必知道 ChatWindow 长什么样（和 useKeyboardShortcuts 里 abort
 * 的处理方式一致）。
 */

/** 按一下 j / k 滚多少像素。 */
export const CHAT_SCROLL_STEP = 120;

type ChatScroller = (delta: number) => void;

let chatScroller: ChatScroller | null = null;

/** 注册（或清掉）聊天区的滚动函数。 */
export function registerChatScroller(next: ChatScroller | null): void {
  chatScroller = next;
}

/** 往 steps 个 `CHAT_SCROLL_STEP` 滚；正数向下。 */
export function scrollChatBy(steps: number): void {
  chatScroller?.(steps * CHAT_SCROLL_STEP);
}
