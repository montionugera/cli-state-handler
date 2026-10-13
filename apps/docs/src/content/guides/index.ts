import { swr } from "./swr.js";
import { timing } from "./timing.js";
import { outbox } from "./outbox.js";
import { cas } from "./cas.js";
import { wal } from "./wal.js";
import { ucb1 } from "./ucb1.js";
import type { Guide, GuideId, PlatformId } from "./types.js";

export type { Guide, GuideId, PlatformId, Snippet } from "./types.js";

export const guides: Record<GuideId, Guide> = { swr, timing, outbox, cas, wal, ucb1 };
export const guideIds: GuideId[] = ["swr", "timing", "outbox", "cas", "wal", "ucb1"];
export const platforms: PlatformId[] = ["ts", "dart", "csharp", "godot"];
