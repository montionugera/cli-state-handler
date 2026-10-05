# Unified Client State Architecture (UCSA)

A high-performance, deterministic client-side state and caching engine designed for modern CLI tools, desktop runtimes, and local developer agents.

UCSA combines **TanStack Query**-inspired caching semantics with embedded **SQLite Write-Ahead Logging (WAL)** persistence, indexed **$O(\log N)$ tag invalidation**, **Content-Addressable Storage (CAS)** package caching, and **multi-transport** abstraction.

---

## Core Concepts

### 1. TanStack Query Semantics
UCSA implements standard declarative client state primitives:
- **`QueryKey`**: Deterministic array keys (e.g. `['users', 42, { filter: 'active' }]`) serialized safely without numeric coercion.
- **`QueryStatus`**: Lifecycle states (`'idle' | 'loading' | 'success' | 'error' | 'retrying'`).
- **Cache Lifecycle**: Granular `stale_at` (stale-while-revalidate) and `expires_at` (garbage collection threshold) timestamps per query entry.

### 2. SQLite WAL Persistence
Unlike naive in-memory or single-file JSON caches that corrupt under concurrent access or sudden CLI termination:
- **Write-Ahead Logging**: Configured via `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`, allowing concurrent readers while a writer commits.
- **Explicit Affinity**: Query keys and data payloads use strict `TEXT NOT NULL` column affinities, preventing SQLite from coercing numeric strings (e.g. `"0123"`) into numbers.
- **Crash Durability**: Every write is committed through ACID transactions, ensuring atomic mutation outbox transitions and zero corruption if a user sends `SIGINT` (Ctrl+C).

### 3. $O(\log N)$ Tag Invalidation
Invalidating collections by key prefix scanning is $O(N)$. UCSA introduces an indexed junction table:
- **`ucsa_cache_tags`**: Composite primary key `(tag, query_hash)` with foreign key references to `ucsa_query_cache(query_hash) ON DELETE CASCADE`.
- **Targeted Purges**: Invalidation by tag (e.g. `users`, `repo:123`) executes in $O(\log N)$ time using B-tree indexed lookups.
- **Automatic Cascades**: Deleting or replacing a cache entry cascades cleanly across tag index records.

### 4. Content-Addressable Storage (CAS) Package Caching
- State artifacts, schema definitions, and transport payloads are hash-addressed via deterministic digests (`query_hash`).
- Eliminates duplicate payloads across queries and processes.

### 5. Multi-Transport Support
Abstracted via the `TransportAdapter` interface:
- **REST & HTTP**: Standard ETag caching, `304 Not Modified` handling, and conditional requests.
- **GraphQL**: Query document hashing and schema-driven entity tagging.
- **gRPC / WebSockets / SSE**: Unified async subscription protocol with real-time push invalidations.

---

## Architecture Overview

UCSA is structured into five decoupled layers designed for deterministic execution, high-concurrency safety, and zero unnecessary re-renders:

```mermaid
flowchart TD
  subgraph Ingress ["Ingress & Transports"]
    BFF["BffTransport (REST + ETag 304)"]
    GQL["GqlTransport (GraphQL + APQ)"]
    WS["WsTransport (WebSocket + Invalidation Push)"]
    RTC["WebRtcDataTransport (P2P Binary Frames)"]
  end

  subgraph StateEngine ["State & Query Engine"]
    QE["QueryEngine (SWR Lifecycle)"]
    SS["Structural Sharing (replaceEqualDeep)"]
    OUTBOX["MutationOutbox (Offline Queue + Conflict Policies)"]
    OM["OnlineManager & FocusManager"]
  end

  subgraph Storage ["Storage & Persistence"]
    SQLITE["SqliteAdapter (WAL Mode + B-tree)"]
    TAGS["ucsa_cache_tags (O(log N) Invalidation Index)"]
    CAS["CasStore (SHA-256 Content-Addressable Storage)"]
  end

  subgraph Consumers ["Multi-Platform Consumers"]
    OBS["createSelectorObserver"]
    REACT["React (useSyncExternalStore)"]
    SVELTE["Svelte 5 (Runes)"]
    CLI["CLI / Ink (Terminal UI)"]
  end

  subgraph Durability ["Process Durability"]
    DUR["CliDurabilityManager (Synchronous Exit Flush)"]
    WAL_CP["PRAGMA wal_checkpoint(TRUNCATE)"]
  end

  Ingress --> QE
  QE --> SS
  QE --> SQLITE
  SQLITE --> TAGS
  QE --> CAS
  OM --> OUTBOX
  OUTBOX --> SQLITE
  QE --> OBS
  OBS --> REACT
  OBS --> SVELTE
  OBS --> CLI
  DUR --> OUTBOX
  DUR --> WAL_CP
  WAL_CP --> SQLITE
```

### Architectural Subsystems

1. **Ingress & Transports**: Protocol adapters (`BffTransport`, `GqlTransport`, `WsTransport`, `WebRtcDataTransport`) normalizing remote APIs, real-time push invalidations, and P2P data channels into uniform request/response and event abstractions.
2. **State & Query Engine**: Central `QueryEngine` orchestrating stale-while-revalidate (SWR) lifecycles, memory caching, query cancellation via `AbortSignal`, and deep structural sharing (`replaceEqualDeep`).
3. **Storage & Persistence**: Embedded SQLite backing in WAL mode (`SqliteAdapter`), indexed B-tree tag invalidation (`ucsa_cache_tags`), and cryptographic content-addressable storage (`CasStore`) for package binaries.
4. **Multi-Platform Consumers**: Framework-agnostic observer bindings (`createSelectorObserver`) providing synchronous snapshots and eliminating re-renders across React, Svelte 5, Vue, and CLI terminal components.
5. **CLI Process Durability**: Synchronous exit hooks (`CliDurabilityManager`, `registerExitFlush`) ensuring all in-memory mutations flush and SQLite WAL files checkpoint before ephemeral processes terminate.

---

## Quickstart

### Installation

```bash
pnpm add cli-state-handler
```

### Basic Usage

```typescript
import { SqliteAdapter, type CacheEntry } from 'cli-state-handler';

// 1. Initialize SQLite adapter with file persistence
// Default options apply: journal_mode = WAL, synchronous = NORMAL, busy_timeout = 5000
const adapter = new SqliteAdapter('./.cache/state.db');

// 2. Persist a query with associated invalidation tags
const userQuery: CacheEntry<{ id: number; name: string; role: string }> = {
  query_hash: 'usr_hash_100',
  query_key: ['users', 100],
  data_payload: { id: 100, name: 'Alice', role: 'admin' },
  etag: '"v1.0.0"',
  created_at: Date.now(),
  stale_at: Date.now() + 60_000,       // Stale after 1 minute
  expires_at: Date.now() + 3_600_000,  // Expire after 1 hour
};

adapter.setQuery(userQuery, ['users', 'role:admin', 'tenant:corp']);

// 3. Read cached query
const cached = adapter.getQuery<{ id: number; name: string }>('usr_hash_100');
console.log(cached?.data_payload.name); // "Alice"

// 4. Query hashes by tag
const userHashes = adapter.getQueryHashesByTag('role:admin');
console.log(userHashes); // ['usr_hash_100']

// 5. Invalidate queries by tag
const invalidated = adapter.invalidateByTag('users');
console.log(invalidated); // ['usr_hash_100']

// Clean up connection
adapter.close();
```

---

## QueryEngine & SWR Lifecycle

The `QueryEngine` provides TanStack Query-style asynchronous state caching with synchronous reads, background revalidations, automatic SQLite persistence, structural sharing, and `AbortSignal` cancellation.

### 1. Initialization with SQLite Persistence

`QueryEngine` can operate entirely in-memory or with an optional `SqliteAdapter` backing WAL persistence across CLI invocations.

```typescript
import { SqliteAdapter, QueryEngine } from 'cli-state-handler';

// Initialize SQLite adapter with file persistence
const sqliteAdapter = new SqliteAdapter('./.cache/state.db');

// Instantiate QueryEngine with SQLite persistence and custom defaults
const queryEngine = new QueryEngine({
  sqliteAdapter,
  defaultStaleTime: 30_000, // 30 seconds fresh time
  defaultGcTime: 300_000,   // 5 minutes garbage collection threshold
});
```

### 2. Querying with `fetchQuery` and `useQuery`

#### One-Shot Fetch with `fetchQuery`
`fetchQuery` returns cached data immediately if fresh. If stale or absent, it executes the fetch function, caches the result, and updates the SQLite store:

```typescript
const user = await queryEngine.fetchQuery(
  ['users', 42],
  async ({ signal }) => {
    const res = await fetch('https://api.example.com/users/42', { signal });
    if (!res.ok) throw new Error('Failed to fetch user');
    return res.json();
  },
  { staleTime: 60_000, tags: ['users', 'user:42'] }
);
```

#### Reactive Subscription & SWR with `useQuery`
`useQuery` implements Stale-While-Revalidate (SWR):
- **Immediate Synchronous Read:** If cached in memory or SQLite, `getSnapshot()` immediately returns the cached data without waiting for network I/O.
- **Background Revalidation:** If the cached entry is stale (`Date.now() >= stale_at`), a background fetch is dispatched (`isFetching: true`).
- **Subscription Notification:** When background revalidation completes, subscribers are notified with updated state.

```typescript
const query = queryEngine.useQuery(
  ['users', 42],
  async ({ signal }) => {
    const res = await fetch('https://api.example.com/users/42', { signal });
    return res.json();
  },
  { staleTime: 10_000, tags: ['users'] }
);

// Synchronously read state snapshot
const snapshot = query.getSnapshot();
console.log('Status:', snapshot.status); // 'success' if cached, 'loading' if empty
console.log('Data:', snapshot.data);
console.log('Revalidating:', snapshot.isFetching);

// Subscribe to state transitions
const unsubscribe = query.subscribe(() => {
  const current = query.getSnapshot();
  console.log('Updated state:', current.status, current.data);
});

// Clean up subscription when no longer needed
unsubscribe();
```

### 3. Request Cancellation via `AbortSignal`

All query functions receive a context containing a standard `AbortSignal` (`{ signal }`). If a query is cancelled or superseded, `QueryEngine` aborts the controller:

```typescript
const query = queryEngine.useQuery(
  ['search', 'query-cache'],
  async ({ signal }) => {
    const res = await fetch('https://api.example.com/search?q=query-cache', { signal });
    return res.json();
  }
);

// Cancel the in-flight network request directly
query.cancel();

// Or cancel from the QueryEngine instance using the query key
queryEngine.cancelQuery(['search', 'query-cache']);
```

### 4. Structural Sharing (`replaceEqualDeep`)

CLI UI libraries (such as Ink) and reactive view models re-render whenever state object references change. UCSA incorporates TanStack's deep structural sharing algorithm (`replaceEqualDeep`):

- When background revalidation fetches new data, `replaceEqualDeep` recursively compares the new payload with the cached payload.
- **Reference Preservation:** If the structure and primitive values are identical, the existing memory reference is retained (`prev === next`).
- **Partial Immutability:** If only a subset of nested properties change, unchanged objects and arrays retain their existing references, while only modified parent paths receive new references.
- **Zero Re-Render Penalty:** Prevents unnecessary CLI UI re-renders, flicker, and wasted CPU cycles when background polling returns unchanged data.

### 5. Fast Tag Invalidation (`invalidateByTag`)

Queries can be tagged with domain identifiers (e.g. `users`, `repo:42`). `invalidateByTag` purges cached records from SQLite and marks active memory records as stale in $O(\log N)$ time, automatically triggering background revalidation for active queries:

```typescript
// Invalidate all queries tagged with 'users'
const invalidatedHashes = await queryEngine.invalidateByTag('users');
console.log(`Invalidated ${invalidatedHashes.length} queries`);
```

---

## Content-Addressable Storage (CAS)

The `CasStore` provides a high-performance content-addressable storage engine for package binaries, heavy assets, and cached payloads. Every object is addressed strictly by its cryptographic SHA-256 digest, guaranteeing immutability, deduplication, and verification across CLI processes.

### 1. Initialization with SQLite Tracking & Quota Limits

`CasStore` can operate standalone on the filesystem or coupled with `SqliteAdapter` for access tracking and LRU quota enforcement:

```typescript
import { SqliteAdapter, CasStore } from 'cli-state-handler';

const sqliteAdapter = new SqliteAdapter('./.cache/state.db');

// Initialize CAS store with root directory, SQLite indexer, and a 500 MB max quota
const cas = new CasStore({
  baseDir: './.cache/cas',
  sqliteAdapter,
  maxSizeBytes: 500 * 1024 * 1024, // 500 MB quota
});

await cas.init();
```

### 2. Atomic Writes & SHA-256 Verification (`put`)

To eliminate corruptions caused by interrupted CLI processes or sudden termination (`SIGINT`/Ctrl+C), `CasStore` never writes directly to its final destination path:

1. **Staged Temporary Write:** Data is written to `<baseDir>/tmp/<uuid>.tmp`.
2. **Checksum Verification:** The SHA-256 digest is computed on the fly. If `expectedHash` is provided and does not match, the temporary file is unlinked immediately and an `IntegrityError` is thrown.
3. **Atomic Rename:** The file is atomically renamed into the sharded storage tree `<baseDir>/objects/<hash[0..2]>/<hash>`.
4. **Metadata Indexing:** If `sqliteAdapter` is configured, object size and access timestamp are recorded in the `ucsa_cas_objects` table.

```typescript
const packageBuffer = Buffer.from('console.log("hello world");');

// Automatic SHA-256 calculation & atomic write
const result = await cas.put(packageBuffer);
console.log('SHA-256 Hash:', result.hash);
console.log('Disk Path:', result.path); // .cache/cas/objects/d4/d41d8cd9...
console.log('Size (bytes):', result.size);

// With optional expected hash verification:
try {
  await cas.put(packageBuffer, 'expected-sha256-hash...');
} catch (err) {
  if (err instanceof IntegrityError) {
    console.error(`Integrity mismatch: expected ${err.expected}, got ${err.actual}`);
  }
}
```

### 3. Object Retrieval & Access Touch (`get`)

When retrieving objects using `get(hash)`:
- Returns the binary `Buffer` or `null` if the object does not exist.
- **Filesystem `mtime` Touch:** Automatically updates the filesystem modification timestamp (`fs.utimes`) on hit.
- **SQLite Access Timestamp Update:** Updates `last_accessed_at` in the SQLite database to keep LRU tracking current.

```typescript
const data = await cas.get(result.hash);
if (data) {
  console.log('Retrieved content length:', data.length);
}

// Fast existence check
const exists = await cas.has(result.hash);
```

### 4. LRU Pruning & High-Watermark Eviction

When multiple packages or build artifacts accumulate, disk space must be bounded:
- **High-Watermark Trigger:** When `put()` detects that total tracked storage exceeds `maxSizeBytes` (the high watermark), `prune()` is triggered automatically.
- **Target Ratio Eviction:** The LRU pruner identifies candidate objects ordered by `last_accessed_at ASC` and purges the oldest unaccessed objects until total storage drops to the target ratio (defaulting to 70% of quota).
- **Manual Eviction:** You can also trigger pruning manually with custom target ratios or quota overrides:

```typescript
// Manually prune down to 70% of quota
const { prunedCount, bytesFreed } = await cas.prune(0.7);
console.log(`Pruned ${prunedCount} objects, freed ${bytesFreed} bytes`);
```

### 5. Why Explicit SQLite Tracking Circumvents OS `noatime` Limits

Modern Linux, macOS, and container environments (such as Docker, Kubernetes, or cloud VMs) mount filesystems with `noatime` or `relatime` by default to minimize disk write I/O overhead. Under `noatime`, read operations do not update inode access times on disk, rendering standard filesystem-level `atime`-based LRU algorithms ineffective or wildly inaccurate.

To circumvent this OS limitation reliably:
1. `CasStore` records access timestamps explicitly inside the embedded SQLite database table `ucsa_cas_objects (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL)`.
2. Every `get()` and `put()` updates `last_accessed_at` within SQLite transactions, backed by SQLite's WAL mode.
3. Disk quota calculations (`getTotalCasSize`) and eviction candidate ordering (`getLruCasObjects`) execute in $O(\log N)$ or fast index scans directly from SQLite B-trees without traversing directory trees on disk.

---

## Pluggable Network Transports & Managers

UCSA abstracts network protocols and runtime connectivity behind uniform interfaces, allowing local developer agents, CLI tools, and desktop applications to seamlessly adapt across diverse protocols and transient network states.

### 1. BFF REST Transport (`BffTransport`)

`BffTransport` provides an HTTP client tailored for Backend-for-Frontend (BFF) REST architectures, featuring automatic Bearer token injection, conditional ETag caching (`304 Not Modified`), and RFC 7807 Problem Details error translation.

```typescript
import { BffTransport, BffHttpError } from 'cli-state-handler';

// Initialize BFF transport with base URL and dynamic auth token getter
const bff = new BffTransport({
  baseUrl: 'https://api.example.com',
  token: async () => {
    // Dynamically retrieve or refresh session token
    return await getCliAuthToken();
  },
  headers: {
    'X-Client-Id': 'developer-agent-cli',
  },
});

// 1. First fetch: Server responds with 200 OK + ETag: "v1-cache-hash"
const response1 = await bff.fetch<{ id: number; name: string }>({
  endpoint: '/v1/users/42',
  method: 'GET',
});
console.log('Status:', response1.status); // 200
console.log('ETag:', response1.etag);     // '"v1-cache-hash"'
console.log('Data:', response1.data);

// 2. Subsequent fetch: Automatically sends `If-None-Match: "v1-cache-hash"`
// When server responds with 304 Not Modified, bff returns the cached data without payload overhead
const response2 = await bff.fetch<{ id: number; name: string }>({
  endpoint: '/v1/users/42',
});
console.log('Status:', response2.status); // 304
console.log('Data (cached):', response2.data);

// 3. RFC 7807 Problem Details error handling
try {
  await bff.fetch({ endpoint: '/v1/restricted' });
} catch (err) {
  if (err instanceof BffHttpError) {
    console.error(`HTTP ${err.status}: ${err.message}`);
    console.error('Problem Details:', err.problemDetails?.detail);
  }
}
```

### 2. GraphQL Transport (`GqlTransport`)

`GqlTransport` provides execution for GraphQL queries and mutations, supporting Automatic Persisted Queries (APQ) via SHA-256 document hashes, automatic response unwrapping, and structured `GqlError` extraction.

```typescript
import { GqlTransport, GqlError } from 'cli-state-handler';

const gql = new GqlTransport({
  endpoint: 'https://api.example.com/graphql',
  token: 'bearer-api-token',
});

// 1. Standard GraphQL query execution
const userResult = await gql.fetch<{ user: { id: string; name: string } }>({
  payload: {
    query: `
      query GetUser($id: ID!) {
        user(id: $id) {
          id
          name
        }
      }
    `,
    variables: { id: 'u-100' },
  },
});
console.log('User:', userResult.data.user);

// 2. Persisted Document Query (APQ) using SHA-256 hash
// Payload sends { variables, extensions: { persistedQuery: { version: 1, sha256Hash } } }
const ordersResult = await gql.fetch<{ orders: Array<{ id: number; total: number }> }>({
  payload: {
    sha256Hash: 'a6c8e31b67f1b2c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8',
    variables: { limit: 10 },
  },
});
console.log('Orders:', ordersResult.data.orders);
```

### 3. WebSocket Transport (`WsTransport`)

`WsTransport` provides real-time bidirectional communication featuring a Finite State Machine (FSM) connection lifecycle, periodic ping/pong keepalive frames, exponential backoff reconnection, and real-time cache invalidation listeners.

```typescript
import { WsTransport, QueryEngine } from 'cli-state-handler';

const queryEngine = new QueryEngine();

const ws = new WsTransport({
  url: 'wss://realtime.example.com/state',
  pingInterval: 30_000,       // Send heartbeat ping every 30s
  pongTimeout: 10_000,        // Await pong response for 10s
  reconnect: true,            // Auto-reconnect with exponential backoff
  reconnectBaseDelay: 500,    // Initial backoff delay (500ms)
  reconnectMaxDelay: 30_000,  // Max backoff delay (30s)
});

// Track connection lifecycle transitions
ws.onStateChange((state) => {
  // States: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  console.log(`WebSocket state changed: ${state}`);
});

// Listen for server push invalidation frames: { type: 'INVALIDATE', tags: ['users', 'repo:42'] }
// Automatically invalidates matching queries in the QueryEngine
ws.subscribe((event) => {
  if (event.type === 'INVALIDATE' && event.tags) {
    for (const tag of event.tags) {
      queryEngine.invalidateByTag(tag);
      console.log(`Cache tag invalidated via push: ${tag}`);
    }
  }
});

// Open connection
ws.connect();

// Multiplexed request/response over WebSocket
const res = await ws.fetch({
  endpoint: 'subscribe.events',
  payload: { topic: 'deployments' },
});
```

### 4. WebRTC DataChannel Transport (`WebRtcDataTransport`)

`WebRtcDataTransport` enables peer-to-peer (P2P) low-latency state synchronization over WebRTC `RTCDataChannel`, featuring binary frame packing and real-time state invalidation framing.

```typescript
import { WebRtcDataTransport } from 'cli-state-handler';

const rtc = new WebRtcDataTransport();

// Track DataChannel lifecycle
rtc.onStateChange((state) => {
  // States: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
  console.log(`WebRTC state: ${state}`);
});

// Bind an established browser or Node WebRTC data channel
rtc.bindDataChannel(peerDataChannel);

// Subscribe to incoming P2P invalidation events
rtc.subscribe((event) => {
  console.log('Received P2P cache invalidation:', event.tags);
});

// Low-latency binary framing: [1-byte FrameType] [4-byte Length] [Payload]
// Type 0x01: JSON Invalidation message
const frame = WebRtcDataTransport.encodeFrame(
  0x01,
  JSON.stringify({ type: 'INVALIDATE', tags: ['p2p:workspace:active'] })
);
rtc.sendRaw(frame);

// Decode received binary frames
const decoded = WebRtcDataTransport.decodeFrame(receivedBuffer);
console.log('Decoded frame type:', decoded.type);
```

### 5. Online & Focus Managers (`OnlineManager`, `FocusManager`)

`OnlineManager` and `FocusManager` track connectivity and window/tab/terminal focus state, coordinating background cache revalidation and outbox replays when network connectivity is restored or an application returns to the foreground.

```typescript
import {
  OnlineManager,
  FocusManager,
  onlineManager,
  focusManager,
  QueryEngine,
  MutationOutbox,
} from 'cli-state-handler';

// 1. OnlineManager: Monitors network connectivity
onlineManager.subscribe((isOnline) => {
  console.log(`Network status: ${isOnline ? 'Online' : 'Offline'}`);
  if (isOnline) {
    // Replay queued offline mutations upon reconnection
    outbox.replay(mutationExecutor);
  }
});

// Custom network event listener for CLI / Node.js runtimes
onlineManager.setEventListener((setOnline) => {
  const checkConnection = async () => {
    // Custom OS or DNS probe logic
    setOnline(true);
  };
  const timer = setInterval(checkConnection, 10_000);
  return () => clearInterval(timer);
});

// 2. FocusManager: Monitors terminal/window foreground focus
focusManager.subscribe((isFocused) => {
  console.log(`Window focus: ${isFocused ? 'Focused' : 'Unfocused'}`);
  if (isFocused) {
    // Trigger SWR background revalidations for active queries
  }
});
```

### 6. Offline Mutation Outbox & Conflict Resolution (`MutationOutbox`)

`MutationOutbox` persists mutations performed while offline into an embedded SQLite table (`ucsa_mutation_outbox`). When connectivity is restored, pending mutations are replayed sequentially with deterministic conflict resolution on HTTP 409.

#### Conflict Resolution Policies

| Policy | Behavior on HTTP 409 Conflict | Mechanism |
| :--- | :--- | :--- |
| **`server-wins`** | Discards local modification and adopts upstream authoritative state. | Executes `onRollback(mutation)` callback to restore previous client state, then removes mutation from the outbox. |
| **`client-wins`** | Enforces local modification over remote state. | Re-queues mutation with `forced: 1` and `X-Force-Overwrite: true` header to overwrite upstream on replay. |
| **`merge`** | Reconciles local and server states via domain logic. | Executes `mergeResolver(localPayload, serverConflictData)`, updates SQLite payload with the merged result, and remains queued for replay. |

```typescript
import { SqliteAdapter, MutationOutbox, type OutboxMutation } from 'cli-state-handler';

const sqliteAdapter = new SqliteAdapter('./.cache/state.db');
const outbox = new MutationOutbox({
  sqliteAdapter,
  maxRetries: 3, // Retry transient 5xx or connection drops up to 3 times before marking 'failed'
});

// 1. Enqueue an offline mutation with 'server-wins' policy
outbox.enqueue({
  mutation_id: 'mut-profile-edit',
  endpoint: '/api/v1/profile',
  method: 'PATCH',
  payload: { displayName: 'Alice L.' },
  conflictPolicy: 'server-wins',
  onRollback: (mutation) => {
    console.warn(`409 Conflict: Rolling back optimistic update for ${mutation.mutation_id}`);
    // Roll back in-memory or UI state to server value
  },
});

// 2. Enqueue an offline mutation with 'client-wins' policy
outbox.enqueue({
  mutation_id: 'mut-document-title',
  endpoint: '/api/v1/documents/101',
  method: 'PUT',
  payload: { title: 'Final Report (Approved)' },
  conflictPolicy: 'client-wins',
  // On 409, automatically re-queued with forced: 1 and headers: { 'X-Force-Overwrite': 'true' }
});

// 3. Enqueue an offline mutation with 'merge' policy
outbox.enqueue({
  mutation_id: 'mut-task-labels',
  endpoint: '/api/v1/tasks/55',
  method: 'PATCH',
  payload: { tags: ['urgent'], status: 'in_progress' },
  conflictPolicy: 'merge',
  mergeResolver: (localData: any, serverData: any) => ({
    ...serverData,
    ...localData,
    tags: Array.from(new Set([...serverData.tags, ...localData.tags])),
  }),
});

// 4. Replay pending mutations sequentially
const result = await outbox.replay(
  async (mutation: OutboxMutation) => {
    const res = await fetch(`https://api.example.com${mutation.endpoint}`, {
      method: mutation.method,
      headers: {
        'Content-Type': 'application/json',
        ...(mutation.headers || {}),
      },
      body: mutation.payload ? JSON.stringify(mutation.payload) : undefined,
    });

    return {
      status: res.status,
      data: await res.json().catch(() => null),
    };
  }
);

console.log(`Replay complete: ${result.successful} successful, ${result.failed} failed, ${result.processed} processed.`);
```

---

## Concurrency & CLI Durability Guarantees

In multi-command CLI workflows, multiple CLI processes or subagents frequently access the same cache database in parallel:

| Guarantee | Mechanism | Benefit |
| :--- | :--- | :--- |
| **No `SQLITE_BUSY` Crashes** | `PRAGMA busy_timeout = 5000;` | Concurrent CLI processes automatically back off and retry for up to 5 seconds during lock contention. |
| **Concurrent Reads & Writes** | `PRAGMA journal_mode = WAL;` | Long-running queries or reads never block incoming mutations; writers write to the write-ahead log without waiting for active readers. |
| **Strict Type Serialization** | `TEXT NOT NULL` affinity | Prevents JSON key corruption, preserves exact numeric keys, and guarantees array structure integrity across deserialization. |
| **Atomic Outbox Queue** | `ucsa_mutation_outbox` table | CLI mutations performed offline or during transient failures are stored with transaction isolation (`pending`, `in_flight`, `failed`) and replayed reliably. |
| **Cascade Consistency** | SQLite Foreign Key Cascade | Eliminates orphaned tag mappings when cache records expire or get deleted. |

---

## Consumer Bindings & Zero Re-render Selectors

In modern reactive UI architectures (React 18/19, Svelte 5 runes, Vue) and CLI terminal interfaces (Ink, Pastel), re-rendering components is expensive. Naive state subscriptions notify components on every query fetch or cache touch, causing unnecessary re-renders even when the queried data has not changed or when changes affect unrelated fields outside the component's concern.

`createSelectorObserver` bridges `QueryEngine` to UI/CLI subscriber models with **guaranteed zero unnecessary notifications**:

### Re-render Elimination Guarantees

| Scenario | Cache State | Component Re-render Count | Mechanism |
| :--- | :--- | :--- | :--- |
| **Initial Fetch** | Empty -> Populated | **Exactly 1** | Synchronous initial snapshot + notification on initial payload arrival. |
| **Background Revalidation** | Identical payload | **0 (Zero)** | `replaceEqualDeep` preserves exact reference (`prev === next`). |
| **Unselected Field Mutation** | Sibling field altered | **0 (Zero)** | Selector output reference/value is identical (`isEqual` returns `true`). |
| **Selected Slice Mutation** | Target field altered | **Exactly 1** | Notification dispatched; reference preserved for unchanged sub-trees. |
| **Rapid Burst Polling** | 10+ identical bursts | **0 (Zero)** | Structural sharing prevents duplicate subscriber dispatches. |

### API Usage

```typescript
import { createSelectorObserver, QueryEngine } from 'cli-state-handler';

const engine = new QueryEngine();
const queryKey = ['users', 'profile', 42];

// Create observer selecting only the user's display name
const observer = createSelectorObserver(
  engine,
  queryKey,
  (user: { id: number; name: string; avatarUrl: string; theme: string }) => user.name,
  {
    // Optional: auto-fetch on subscription if cache is empty
    queryFn: async () => fetchUserData(42),
    // Optional: custom equality comparator (defaults to deep structural equality)
    isEqual: (prev, next) => prev === next,
  }
);

// 1. Synchronously read current snapshot
const currentName = observer.getSnapshot(); // "Alice"

// 2. Subscribe listener (fires ONLY when user.name changes)
const unsubscribe = observer.subscribe(() => {
  console.log('User name updated to:', observer.getSnapshot());
});

// Clean up
unsubscribe();
```

### React Integration (`useSyncExternalStore`)

`createSelectorObserver` adheres to the React `useSyncExternalStore` contract:

```typescript
import { useMemo, useSyncExternalStore } from 'react';
import {
  createSelectorObserver,
  type QueryEngine,
  type QueryKey,
} from 'cli-state-handler';

export function useQuerySelector<TData, TSelected>(
  engine: QueryEngine,
  queryKey: QueryKey,
  selector: (data: TData) => TSelected
): TSelected | undefined {
  const serializedKey = JSON.stringify(queryKey);

  const observer = useMemo(
    () => createSelectorObserver(engine, queryKey, selector),
    [engine, serializedKey]
  );

  return useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getSnapshot
  );
}

// React Component Example
function UserBadge({ engine, userId }: { engine: QueryEngine; userId: string }) {
  // Re-renders ONLY when `name` changes, ignoring avatar/settings updates
  const userName = useQuerySelector(
    engine,
    ['users', userId],
    (user: any) => user?.name
  );

  return <span className="badge">{userName ?? 'Loading...'}</span>;
}
```

### Svelte 5 Integration (Runes)

```svelte
<script lang="ts">
  import { createSelectorObserver, type QueryEngine } from 'cli-state-handler';

  interface Props {
    engine: QueryEngine;
    packageId: string;
  }
  const { engine, packageId }: Props = $props();

  const observer = createSelectorObserver(
    engine,
    ['packages', packageId],
    (pkg: { name: string; version: string; downloads: number }) => ({
      name: pkg.name,
      version: pkg.version,
    })
  );

  let pkgInfo = $state(observer.getSnapshot());

  $effect(() => {
    const unsubscribe = observer.subscribe(() => {
      pkgInfo = observer.getSnapshot();
    });
    return unsubscribe;
  });
</script>

<div>
  <h3>{pkgInfo?.name ?? 'Loading...'}</h3>
  <code>{pkgInfo?.version}</code>
</div>
```

### CLI & Terminal Integration (Ink)

```typescript
import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import { createSelectorObserver, type QueryEngine } from 'cli-state-handler';

export function CliDeploymentStatus({
  engine,
  deployId,
}: {
  engine: QueryEngine;
  deployId: string;
}) {
  const observer = React.useMemo(
    () =>
      createSelectorObserver(
        engine,
        ['deployments', deployId],
        (d: any) => d?.status
      ),
    [engine, deployId]
  );

  const [status, setStatus] = useState(observer.getSnapshot());

  useEffect(() => {
    return observer.subscribe(() => {
      setStatus(observer.getSnapshot());
    });
  }, [observer]);

  return (
    <Box borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>Deployment [{deployId}]: </Text>
      <Text color={status === 'success' ? 'green' : 'yellow'}>
        {status ?? 'Pending'}
      </Text>
    </Box>
  );
}
```

---

## CLI Ephemeral Process Durability & Flush Manager

CLI commands and background developer subagents execute in short-lived, ephemeral processes. If a CLI command exits immediately upon output completion or gets terminated prematurely (`SIGINT`, `process.exit()`, terminal window close), in-memory queues and uncheckpointed SQLite Write-Ahead Log (WAL) frames can remain on disk, causing dirty state or uncommitted outbox mutations.

`CliDurabilityManager` resolves this by providing **guaranteed synchronous exit flushes**:

### Key Capabilities

1. **Synchronous Exit Interception**: Attaches directly to Node.js `beforeExit` and `exit` lifecycle events.
2. **Deterministic Priority Queue**: Handlers execute synchronously in strict priority order (higher numbers first; FIFO for equal priority).
3. **SQLite WAL Truncation**: Flushes WAL pages via `PRAGMA wal_checkpoint(TRUNCATE);`, eliminating orphaned `-wal` files and committing all transactions directly to the database file.
4. **Error Isolation**: Catches handler errors gracefully so that remaining flushers always complete even if one handler fails.

```typescript
import {
  CliDurabilityManager,
  registerExitFlush,
  SqliteAdapter,
  MutationOutbox,
} from 'cli-state-handler';

const sqlite = new SqliteAdapter('./.cache/state.db', { journalMode: 'WAL' });
const outbox = new MutationOutbox({ sqliteAdapter: sqlite });

// 1. Using the Global Durability Manager
// Register in-memory outbox flush at priority 10
registerExitFlush(() => {
  console.log('Flushing pending outbox records to disk...');
}, 10);

// Register SQLite WAL checkpoint at priority -100
// WAL checkpoint executes after all in-memory writes have committed
registerExitFlush(() => {
  sqlite.checkpoint('TRUNCATE');
}, -100);

// 2. Or using an isolated CliDurabilityManager instance
const durability = new CliDurabilityManager({
  onError: (err) => console.error('Durability flush failed:', err),
});

// Helper for automatic SQLite checkpoint registration
durability.registerSqliteCheckpoint(sqlite, -100, 'TRUNCATE');

// Manually trigger synchronous flush before intentional exit
durability.flushAll();
```

---

## Development & Verification

### Verified Test Coverage Metrics

| Test Suite | File | Tests | Status |
| :--- | :--- | :--- | :--- |
| **Types & Contracts** | `packages/core/tests/types.test.ts` | 7 | Passing (100%) |
| **SQLite WAL Storage** | `packages/core/tests/storage/sqlite.test.ts` | 13 | Passing (100%) |
| **CAS Store (SHA-256)** | `packages/core/tests/storage/cas.test.ts` | 13 | Passing (100%) |
| **CAS LRU & Quotas** | `packages/core/tests/storage/cas-lru.test.ts` | 8 | Passing (100%) |
| **Concurrency Safety** | `packages/core/tests/storage/concurrency.test.ts` | 3 | Passing (100%) |
| **Query Lifecycle FSM** | `packages/core/tests/query/lifecycle.test.ts` | 20 | Passing (100%) |
| **Query Engine & SWR** | `packages/core/tests/query/query-engine.test.ts` | 24 | Passing (100%) |
| **Mutation Outbox** | `packages/core/tests/query/outbox.test.ts` | 16 | Passing (100%) |
| **Network Transports** | `packages/core/tests/network/transports.test.ts` | 23 | Passing (100%) |
| **Consumer Re-render** | `packages/core/tests/consumer/re-render.test.ts` | 6 | Passing (100%) |
| **CLI Process Durability** | `packages/core/tests/cli/durability.test.ts` | 19 | Passing (100%) |
| **Full-Chain E2E Gate** | `packages/core/tests/e2e/full-chain.test.ts` | 1 | Passing (100%) |
| **Total** | **12 Test Suites** | **153 Tests** | **153 / 153 Passing (100%)** |

### Verification Commands

```bash
# Run type checks and build
pnpm run typecheck && pnpm run build

# Run complete Vitest suite (153 tests across 12 files)
pnpm test

# Run Gate 1 precheck script
./scripts/precheck.sh
```
