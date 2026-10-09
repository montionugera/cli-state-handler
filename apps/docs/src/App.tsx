import React, { useCallback, useEffect, useRef, useState } from "react";
import { groups, routes } from "./routes.js";
import { useHashRoute } from "./router.js";
import { NotFound } from "./pages/NotFound.js";
import "./shell.css";

export function App() {
  const { id, route } = useHashRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the drawer has closed and the content is no longer inert.
  const focusOnClose = useRef<"toggle" | "main" | null>(null);
  const mounted = useRef(false);
  const routeId = route ? route.id : "not-found";
  const Page = route ? route.component : NotFound;
  const pageTitle = route ? route.title : "Page not found";

  useEffect(() => {
    document.title = `${pageTitle} - UCSA Docs`;
    setDrawerOpen(false);
    window.scrollTo?.(0, 0);
    // Skip the initial load so a fresh page does not steal focus.
    if (mounted.current) mainRef.current?.focus({ preventScroll: true });
    mounted.current = true;
  }, [pageTitle, id]);

  useEffect(() => {
    if (!drawerOpen) {
      const target = focusOnClose.current;
      focusOnClose.current = null;
      if (target === "toggle") toggleRef.current?.focus();
      if (target === "main") mainRef.current?.focus({ preventScroll: true });
      return;
    }
    sidebarRef.current?.querySelector<HTMLElement>(".navlink")?.focus();

    const behind = [mainRef.current, topbarRef.current];
    for (const el of behind) el?.setAttribute("inert", "");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        focusOnClose.current = "toggle";
        setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    // Above the drawer breakpoint (shell.css) the scrim and toggle are hidden.
    const wide = window.matchMedia?.("(min-width: 768px)");
    const onWide = () => {
      focusOnClose.current = null;
      setDrawerOpen(false);
    };
    wide?.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKey);
      wide?.removeEventListener("change", onWide);
      for (const el of behind) el?.removeAttribute("inert");
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen]);

  const closeFromScrim = useCallback(() => {
    focusOnClose.current = "toggle";
    setDrawerOpen(false);
  }, []);

  const onNavClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    // Modified clicks (new tab/window) and non-primary buttons belong to the browser.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // Navigate synchronously; the browser's own hashchange later is a no-op.
    e.preventDefault();
    const href = e.currentTarget.getAttribute("href") ?? "#/";
    if (window.location.hash !== href) {
      window.location.hash = href;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    // Re-tapping the current page changes no route, so close the drawer here.
    focusOnClose.current = "main";
    setDrawerOpen(false);
  }, []);

  const focusMain = useCallback((e: React.MouseEvent) => {
    // A "#main" href would clobber the hash router, so focus programmatically.
    e.preventDefault();
    mainRef.current?.focus();
  }, []);

  return (
    <div className="shell">
      <a href="#/" className="skip-link" onClick={focusMain}>
        Skip to content
      </a>

      <header className="topbar" ref={topbarRef}>
        <button
          ref={toggleRef}
          type="button"
          className="topbar__toggle"
          aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={drawerOpen}
          aria-controls="sidebar"
          onClick={() => setDrawerOpen((o) => !o)}
        >
          <span aria-hidden="true" className="topbar__bars" />
        </button>
        <span className="topbar__title">{pageTitle}</span>
      </header>

      {drawerOpen && <div className="scrim" onClick={closeFromScrim} aria-hidden="true" />}

      <aside id="sidebar" ref={sidebarRef} className={`sidebar${drawerOpen ? " sidebar--open" : ""}`}>
        <div className="sidebar__brand">
          <span className="sidebar__name">UCSA Studio</span>
          <span className="badge badge-emerald">v1.4</span>
          <p>Unified Client State Architecture</p>
        </div>

        <nav className="sidebar__nav" aria-label="Documentation">
          {groups.map((group) => (
            <section key={group} className="navgroup">
              <h2 className="navgroup__title">{group}</h2>
              <ul>
                {routes
                  .filter((r) => r.group === group)
                  .map((r) => (
                    <li key={r.id}>
                      <a
                        className="navlink"
                        href={r.id === "home" ? "#/" : `#/${r.id}`}
                        aria-current={r.id === routeId ? "page" : undefined}
                        onClick={onNavClick}
                      >
                        {r.icon ? `${r.icon} ${r.title}` : r.title}
                      </a>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </nav>

        <div className="sidebar__foot">
          <div>Terminal launcher</div>
          <code>ucsa tutorial</code>
        </div>
      </aside>

      <main id="main" ref={mainRef} tabIndex={-1} className="content" data-route-id={routeId}>
        <Page />
      </main>
    </div>
  );
}
