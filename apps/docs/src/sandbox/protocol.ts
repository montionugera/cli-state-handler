/** Messages the sandbox frame posts to the parent page. */
export const MESSAGE_SOURCE = "ucsa-sandbox";
export const MAX_TEXT = 2000;
export const LOG_LEVELS = ["log", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type SandboxMessage =
  | { type: "log"; level: LogLevel; text: string }
  | { type: "error"; text: string }
  | { type: "done" };

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "… [truncated]" : text;
}

/**
 * Validates untrusted `event.data`. Returns null unless it is a well-formed message
 * tagged for the current run. (The caller must ALSO check `event.source`.)
 */
export function parseSandboxMessage(data: unknown, runId: number): SandboxMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.source !== MESSAGE_SOURCE || d.runId !== runId) return null;
  if (d.type === "done") return { type: "done" };
  if (d.type === "error" && typeof d.text === "string") return { type: "error", text: clip(d.text) };
  if (d.type === "log" && isLogLevel(d.level) && typeof d.text === "string") {
    return { type: "log", level: d.level, text: clip(d.text) };
  }
  return null;
}
