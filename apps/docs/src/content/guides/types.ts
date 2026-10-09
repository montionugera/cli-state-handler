export type PlatformId = "ts" | "dart" | "csharp";
export type GuideId = "swr" | "timing" | "outbox" | "cas" | "wal" | "ucb1";

/**
 * One platform's snippet for one subsystem.
 * `available: false` means the platform has no such API; `code` is then empty and
 * `notes` say what was searched for. `sources` are repo-root-relative files the
 * snippet was taken from or checked against (a test asserts they exist).
 */
export interface Snippet {
  title: string;
  lang: string;
  available: boolean;
  code: string;
  sources: string[];
  notes: string[];
}

export interface Guide {
  id: GuideId;
  label: string;
  ts: Snippet;
  dart: Snippet;
  csharp: Snippet;
}

export const CORE = "packages/core/src";
export const DART = "packages/ucsa_dart/lib/src";
export const CS = "packages/com.ucsa.unity/Runtime";
