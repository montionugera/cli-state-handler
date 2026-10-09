import { FrameDecoder, FrameType, type Frame } from "./ucb1-codec.js";

export interface SimProcess {
  name: string;
  /** Topic filters. Empty set = receives every event (bus-hub.ts:482). "*" = everything. */
  filters: readonly string[];
}
export interface Delivery {
  process: string;
  frame: Frame;
}
export interface PublishResult {
  /** True when the bytes decoded (or are still incomplete); false when the decoder threw. */
  ok: boolean;
  /** Decoder error that the real hub swallows before destroying the publisher's socket (bus-hub.ts:303-308). */
  error?: string;
  /** The publisher's connection was dropped; the real hub sends no ERROR frame. */
  dropped?: boolean;
  /** Model-only: bytes ended mid-frame, so the hub just waits for more. */
  waiting?: boolean;
  /** Name of the frame type that was published, when one decoded. */
  frameType?: string;
  delivered: Delivery[];
}

const typeName = (t: number): string =>
  Object.entries(FrameType).find(([, v]) => v === t)?.[0] ??
  `0x${t.toString(16)}`;

/** Mirrors the receive filter of bus-hub.ts:482-495 on the payload's kind / tags / topic. */
export function matchesFilters(
  filters: readonly string[],
  payload: unknown,
): boolean {
  if (filters.length === 0 || filters.includes("*")) return true;
  const obj = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind : undefined;
  const topic = typeof obj.topic === "string" ? obj.topic : undefined;
  const tags = Array.isArray(obj.tags) ? (obj.tags as unknown[]) : [];
  if (kind && filters.includes(kind)) return true;
  if (topic && filters.includes(topic)) return true;
  return tags.some((t) => typeof t === "string" && filters.includes(t));
}

/**
 * Simulated hub: decodes the publisher's bytes, fans PUBLISH out as EVENT to every
 * process except the publisher whose filters match. Decode errors drop the publisher.
 */
export function hubPublish(
  bytes: Uint8Array,
  processes: readonly SimProcess[],
  publisher: string,
): PublishResult {
  let frames: Frame[];
  try {
    frames = new FrameDecoder().feed(bytes);
  } catch (err) {
    return {
      ok: false,
      dropped: true,
      error:
        err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error",
      delivered: [],
    };
  }
  if (frames.length === 0) {
    return { ok: true, waiting: true, delivered: [] };
  }
  const delivered: Delivery[] = [];
  for (const f of frames) {
    if (f.type !== FrameType.PUBLISH) continue;
    for (const p of processes) {
      if (p.name === publisher) continue;
      if (!matchesFilters(p.filters, f.payload)) continue;
      delivered.push({
        process: p.name,
        frame: { type: FrameType.EVENT, payload: f.payload },
      });
    }
  }
  return { ok: true, frameType: typeName(frames[0]!.type), delivered };
}
