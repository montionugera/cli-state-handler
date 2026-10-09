/**
 * Browser model of the UCSA content-addressable store.
 *
 * Hash-compatible with the real store (`packages/core/src/storage/cas-store.ts`
 * and `cas-lru.ts`): SHA-256 lowercase hex, key `objects/<hash[0..2]>/<hash>`,
 * put-of-existing-hash refreshes access time (dedupe), get refreshes access
 * time, and prune evicts `last_accessed_at ASC, insertion order ASC` until the
 * total is at or below floor(max * ratio).
 *
 * No Node imports: runs in the browser and in Node's vitest via WebCrypto.
 */

export interface CasEntry {
  hash: string;
  key: string;
  size: number;
  lastAccessedAt: number;
}

export interface PutResult {
  hash: string;
  key: string;
  size: number;
  deduped: boolean;
  /** Hashes evicted by the automatic prune that followed this put, in eviction order. */
  evicted: string[];
}

export interface CasModelOptions {
  maxBytes: number;
  /** Prune target as a fraction of maxBytes. Real store default: 0.7. */
  targetRatio?: number;
  /** Clock. Defaults to a strictly increasing logical counter. */
  now?: () => number;
}

interface Stored extends CasEntry {
  data: Uint8Array;
  seq: number;
}

const encoder = new TextEncoder();

export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = toBytes(data);
  // Copy into a fresh ArrayBuffer-backed view to satisfy BufferSource typing.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function keyOf(hash: string): string {
  return `objects/${hash.slice(0, 2)}/${hash}`;
}

export class CasModel {
  private readonly store = new Map<string, Stored>();
  private maxBytes: number;
  private readonly targetRatio: number;
  private readonly now: () => number;
  private seq = 0;
  private tick = 0;

  constructor(options: CasModelOptions) {
    this.maxBytes = options.maxBytes;
    this.targetRatio = options.targetRatio ?? 0.7;
    this.now = options.now ?? (() => ++this.tick);
  }

  async put(data: string | Uint8Array): Promise<PutResult> {
    const bytes = toBytes(data);
    const hash = await sha256Hex(bytes);
    const existing = this.store.get(hash);
    const deduped = existing !== undefined;
    if (existing) {
      existing.size = bytes.byteLength;
      existing.lastAccessedAt = this.now();
    } else {
      this.store.set(hash, {
        hash,
        key: keyOf(hash),
        size: bytes.byteLength,
        lastAccessedAt: this.now(),
        data: bytes.slice(),
        seq: this.seq++,
      });
    }
    const evicted = this.maxBytes > 0 && this.totalBytes() > this.maxBytes ? this.prune() : [];
    return { hash, key: keyOf(hash), size: bytes.byteLength, deduped, evicted };
  }

  get(hash: string): Uint8Array | null {
    const entry = this.store.get(hash);
    if (!entry) return null;
    entry.lastAccessedAt = this.now();
    return entry.data.slice();
  }

  has(hash: string): boolean {
    return this.store.has(hash);
  }

  delete(hash: string): boolean {
    return this.store.delete(hash);
  }

  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
  }

  totalBytes(): number {
    let total = 0;
    for (const e of this.store.values()) total += e.size;
    return total;
  }

  /** Entries in LRU-first order (oldest access first, insertion order breaks ties). */
  entries(): CasEntry[] {
    return [...this.store.values()]
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.seq - b.seq)
      .map(({ hash, key, size, lastAccessedAt }) => ({ hash, key, size, lastAccessedAt }));
  }

  /**
   * Evict least-recently-used entries until total <= floor(max * ratio).
   * No-op when total <= max (same guard as the real store). Returns evicted hashes in order.
   */
  prune(ratio: number = this.targetRatio): string[] {
    if (this.maxBytes <= 0 || this.totalBytes() <= this.maxBytes) return [];
    const target = Math.floor(this.maxBytes * ratio);
    let total = this.totalBytes();
    const evicted: string[] = [];
    for (const candidate of this.entries()) {
      if (total <= target) break;
      this.store.delete(candidate.hash);
      total -= candidate.size;
      evicted.push(candidate.hash);
    }
    return evicted;
  }
}
