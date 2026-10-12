export const THEME_KEY = "ucsa-docs-theme";
export type ThemeChoice = "system" | "light" | "dark";
/** The saved choice. Anything else, or blocked storage, means "follow the system". */
export function readTheme(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
/** Light and dark set `data-theme`; system removes it so the tokens follow `prefers-color-scheme`. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage can be blocked (private mode). The choice then lasts for this page only.
  }
}
