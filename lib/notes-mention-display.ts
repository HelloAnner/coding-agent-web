/**
 * The Notes @ menu inserts a quoted absolute path (`@"<path>"`) so the harness
 * receives a path it can read. In the transcript, show that token as a
 * highlighted file link instead of the whole path. The stored message and the
 * copy/edit actions keep the original absolute path.
 */
export function highlightAbsoluteAtMentions(text: string): string {
  return text.replace(/@"((?:\/|[A-Za-z]:[\\/])[^"\n]+)"/g, (match, filePath: string) => {
    const base = filePath.split(/[\\/]/).pop() ?? filePath;
    const label = base.replace(/([\\[\]])/g, "\\$1");
    const hrefPath = /^[A-Za-z]:[\\/]/.test(filePath) ? `/${filePath.replaceAll("\\", "/")}` : filePath;
    const href = `file://${encodeURI(hrefPath).replace(/[?#()]/g, (character) => encodeURIComponent(character))}`;
    return `[${label}](${href})`;
  });
}
