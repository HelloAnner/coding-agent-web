export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopyText(text));
  }
  return legacyCopyText(text);
}

/** Insecure contexts (plain http on the LAN) still allow execCommand. */
function legacyCopyText(text: string): Promise<void> {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

/**
 * Puts an image on the clipboard of the machine the user is sitting at.
 *
 * https/localhost: the browser writes its own clipboard. Any plain-http origin
 * has no async clipboard, and execCommand cannot carry image bytes, so the
 * image goes to the clipboard of the host running this app instead.
 */
export async function copyImage(blob: Blob): Promise<void> {
  if (navigator.clipboard?.write && "ClipboardItem" in window) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return;
    } catch {
      // Insecure origin or a denied permission: fall through to the host.
    }
  }
  const response = await fetch("/api/clipboard", {
    method: "POST",
    headers: { "content-type": blob.type },
    body: blob,
  });
  if (!response.ok) throw new Error(await response.text());
}
