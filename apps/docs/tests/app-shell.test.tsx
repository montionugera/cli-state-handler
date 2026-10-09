// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { App } from "../src/App.js";
import { routes, groups } from "../src/routes.js";
import { parseHash, parseLocation, useHashRoute } from "../src/router.js";

function setHash(hash: string) {
  window.location.hash = hash;
}

function mainEl(): HTMLElement {
  return screen.getByRole("main");
}

describe("docs app shell", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setHash("");
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  });
  afterEach(() => cleanup());

  it("parseHash maps hashes to route ids", () => {
    expect(parseHash("")).toBe("home");
    expect(parseHash("#")).toBe("home");
    expect(parseHash("#/")).toBe("home");
    expect(parseHash("#/swr")).toBe("swr");
    expect(parseHash("#/a/b")).toBe("a/b");
  });

  it("parseHash ignores the query string, a trailing slash and case, and decodes the id", () => {
    expect(parseHash("#/sandbox?preset=x")).toBe("sandbox");
    expect(parseHash("#/swr/")).toBe("swr");
    expect(parseHash("#/SWR")).toBe("swr");
    expect(parseHash("#/sw%72")).toBe("swr");
    expect(parseHash("#/?preset=x")).toBe("home");
    expect(parseHash("#/%E0%A4%A")).toBe("%e0%a4%a"); // malformed escape does not throw
    expect(parseLocation("#/sandbox?preset=x&a=b").query.get("preset")).toBe("x");
    expect(parseLocation("#/swr").query.toString()).toBe("");
  });

  it("useHashRoute exposes the query string", () => {
    setHash("#/swr?preset=x");
    let seen: ReturnType<typeof useHashRoute> | undefined;
    function Probe() {
      seen = useHashRoute();
      return null;
    }
    render(<Probe />);
    expect(seen?.id).toBe("swr");
    expect(seen?.query.get("preset")).toBe("x");
  });

  it("resolves a route from a query/case/trailing-slash hash", () => {
    setHash("#/SWR/?preset=x");
    render(<App />);
    expect(mainEl().getAttribute("data-route-id")).toBe("swr");
  });

  it("registry covers the sidebar groups and unique ids", () => {
    const firstAppearance = [...new Set(routes.map((r) => r.group))];
    expect(groups).toEqual(firstAppearance);
    for (const r of routes) expect(groups).toContain(r.group);
    const ids = routes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["home", "swr", "timing", "outbox", "cas", "multiplatform"]) {
      expect(ids).toContain(id);
    }
  });

  for (const route of routes) {
    it(`renders route "${route.id}" from its hash with its title and active marker`, () => {
      setHash(route.id === "home" ? "#/" : `#/${route.id}`);
      render(<App />);

      expect(mainEl().getAttribute("data-route-id")).toBe(route.id);
      expect(within(mainEl()).getAllByRole("heading").length).toBeGreaterThan(0);
      expect(document.title).toContain(route.title);

      const nav = screen.getByRole("navigation", { name: "Documentation" });
      const current = nav.querySelectorAll('[aria-current="page"]');
      expect(current.length).toBe(1);
      expect(current[0]?.textContent).toContain(route.title);
    });
  }

  it("renders exactly one h1 for every route", () => {
    for (const route of routes) {
      const Page = route.component;
      const { unmount } = render(<Page />);
      expect(screen.getAllByRole("heading", { level: 1 }), route.id).toHaveLength(1);
      unmount();
    }
  });

  it("renders the not-found page for an unknown hash", () => {
    setHash("#/does-not-exist");
    render(<App />);

    expect(mainEl().getAttribute("data-route-id")).toBe("not-found");
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeDefined();
    expect(document.querySelectorAll('[aria-current="page"]').length).toBe(0);
  });

  it("switches page on hashchange without reload", () => {
    setHash("#/swr");
    render(<App />);
    expect(mainEl().getAttribute("data-route-id")).toBe("swr");

    act(() => {
      setHash("#/cas");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(mainEl().getAttribute("data-route-id")).toBe("cas");
  });

  it("navigates synchronously when a sidebar link is clicked", () => {
    render(<App />);
    fireEvent.click(screen.getByText("💾 CAS Storage & LRU"));
    expect(mainEl().getAttribute("data-route-id")).toBe("cas");
    expect(window.location.hash).toBe("#/cas");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement).toBe(mainEl());
  });

  it("leaves modified clicks to the browser", () => {
    render(<App />);
    const link = screen.getByText("💾 CAS Storage & LRU");
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, init)).toBe(true); // not default-prevented
    }
    expect(mainEl().getAttribute("data-route-id")).toBe("home");
  });

  it("groups links under Start, Visualisers and Guides headings", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    for (const g of groups) {
      expect(within(nav).getByText(g)).toBeDefined();
    }
  });

  it("has a skip link that moves focus to main", () => {
    render(<App />);
    const skip = screen.getByText("Skip to content");
    fireEvent.click(skip);
    expect(document.activeElement).toBe(mainEl());
  });

  it("toggles the mobile drawer and closes it on Escape", () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("moves focus into the drawer on open and back to the toggle on Escape", () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    expect(document.activeElement).toBe(nav.querySelector("a"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(toggle);
  });

  it("closes the drawer from the scrim and returns focus to the toggle", () => {
    const { container } = render(<App />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);
    fireEvent.click(container.querySelector(".scrim") as Element);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes the drawer when the current page's link is tapped", () => {
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText(/Architecture Overview/, { selector: "a" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(document.querySelector("main"));
  });

  it("closes the drawer when the viewport grows past the drawer breakpoint", () => {
    let onChange: (() => void) | undefined;
    vi.stubGlobal("matchMedia", () => ({
      addEventListener: (_: string, cb: () => void) => { onChange = cb; },
      removeEventListener: () => {},
    }));
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);
    act(() => onChange?.());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    vi.unstubAllGlobals();
  });

  it("makes the content inert and locks body scroll while the drawer is open", () => {
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(mainEl().hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mainEl().hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
