import { useMemo, useSyncExternalStore } from "react";
import { routes, type RouteDef } from "./routes.js";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "#/Swr/?preset=x" -> { id: "swr", query: preset=x }. Empty id means "home". */
export function parseLocation(hash: string): { id: string; query: URLSearchParams } {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  const id = safeDecode(path.replace(/\/+$/, "")).toLowerCase();
  return { id: id === "" ? "home" : id, query };
}

/** "", "#", "#/" -> "home"; "#/swr" -> "swr". Ignores query string, trailing slash and case. */
export function parseHash(hash: string): string {
  return parseLocation(hash).id;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const getHash = () => window.location.hash;

export function useHashRoute(): { id: string; query: URLSearchParams; route: RouteDef | undefined } {
  const hash = useSyncExternalStore(subscribe, getHash, () => "");
  return useMemo(() => {
    const { id, query } = parseLocation(hash);
    return { id, query, route: routes.find((r) => r.id === id) };
  }, [hash]);
}
