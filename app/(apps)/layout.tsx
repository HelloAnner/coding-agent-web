import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";

/**
 * Coding and the dashboard share this layout, so a route change between them
 * keeps the shell (and both apps inside it) mounted. The pages are empty:
 * AppShell renders the app in view from the pathname.
 */
export default function AppsLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense>
      <I18nProvider>
        <AppShell />
        {children}
      </I18nProvider>
    </Suspense>
  );
}
