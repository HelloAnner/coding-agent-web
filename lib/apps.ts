/**
 * The web apps this server hosts and the switcher in the sidebar's brand.
 * Each is a page of its own: "coding" is this coding agent's UI, "dashboard"
 * is the standalone app under dashboard/ with its own frontend and backend.
 */
export interface WebApp {
  id: "coding" | "dashboard";
  label: string;
  href: string;
}

export const WEB_APPS: readonly WebApp[] = [
  { id: "coding", label: "Coding", href: "/" },
  { id: "dashboard", label: "Dashboard", href: "/dashboard" },
];

/** The app whose page `pathname` is, from the registry's hrefs. */
export function webAppForPath(pathname: string): WebApp {
  const path = pathname.replace(/\/+$/, "") || "/";
  const match = WEB_APPS.find((app) => {
    const href = app.href.replace(/\/+$/, "") || "/";
    return href !== "/" && (path === href || path.startsWith(`${href}/`));
  });
  return match ?? WEB_APPS[0];
}
