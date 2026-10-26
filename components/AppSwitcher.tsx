import { useLayoutEffect, useRef, useState } from "react";
import { WEB_APPS, type WebApp } from "@/lib/apps";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SidebarMenu, type SidebarMenuAnchor } from "./SidebarMenu";
import { ChevronIcon } from "./SidebarIcons";

/**
 * The brands' shared control: the app in view, with a menu of the apps this
 * server hosts. Switching is the shell's (no navigation: the other app is a
 * view beside this one).
 */
export function AppSwitcher({
  current,
  onSwitch,
  onWidthChange,
}: {
  current: WebApp;
  onSwitch: (app: WebApp) => void;
  onWidthChange?: () => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [anchor, setAnchor] = useState<SidebarMenuAnchor | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    onWidthChange?.();
  }, [current.label, onWidthChange]);

  const open = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setAnchor({
      kind: "rect",
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      align: "start",
    });
    onWidthChange?.();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sidebar-app-switcher"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={t("sidebar.switchApp")}
        onClick={() => (anchor ? setAnchor(null) : open())}
      >
        <span className="sidebar-app-switcher-label">{current.label}</span>
        <ChevronIcon size={11} className="sidebar-app-switcher-chevron" />
      </button>
      <SidebarMenu
        open={anchor !== null}
        anchor={anchor}
        sheet={isMobile}
        ariaLabel={t("sidebar.switchApp")}
        cancelLabel={t("sidebar.cancel")}
        returnFocusTo={buttonRef.current}
        width={200}
        items={WEB_APPS.map((app) => ({
          type: "item" as const,
          id: app.id,
          label: app.label,
          checked: app.id === current.id,
          onSelect: () => {
            if (app.id !== current.id) onSwitch(app);
          },
        }))}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}
