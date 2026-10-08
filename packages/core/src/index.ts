export type {
  QueryKey,
  QueryStatus,
  CacheEntry,
  OutboxMutationStatus,
  OutboxMutation,
  ConflictPolicy,
  TransportRequest,
  TransportResponse,
  InvalidationEvent,
  UnsubscribeFn,
  TransportAdapter,
  QueryState,
} from './types.js';

export { SqliteAdapter } from './storage/sqlite-adapter.js';
export type {
  SqliteAdapterOptions,
  SqliteCheckpointMode,
  CheckpointMode,
} from './storage/sqlite-adapter.js';
export {
  MigrationRunner,
  DatabaseVersionTooNewError,
  MigrationChecksumMismatchError,
  MigrationError,
  TARGET_SCHEMA_VERSION,
  BASELINE_SQL,
  CANONICAL_MIGRATIONS,
  computeSqlChecksum,
} from './storage/migration-runner.js';
export type {
  MigrationDefinition,
  AppliedMigrationRecord,
} from './storage/migration-runner.js';
export {
  insertTags,
  getQueryHashesByTag,
  deleteTagsForQuery,
} from './storage/tag-index.js';
export {
  CasStore,
  IntegrityError,
} from './storage/cas-store.js';
export type {
  CasStoreOptions,
  CasPutResult,
} from './storage/cas-store.js';
export {
  initCasTable,
  upsertCasObject,
  updateCasAccessTime,
  getCasObject,
  deleteCasObject,
  getTotalCasSize,
  getLruCasObjects,
} from './storage/cas-lru.js';
export type {
  CasObjectRecord,
  PruneResult,
} from './storage/cas-lru.js';

export { LifecycleFSM } from './query/lifecycle-fsm.js';
export type { LifecycleFSMOptions } from './query/lifecycle-fsm.js';

export {
  replaceEqualDeep,
  isPlainObject,
} from './query/structural-sharing.js';

export {
  QueryEngine,
  debounceQuery,
  hashQueryKey,
  matchQueryKey,
} from './query/query-engine.js';
export type {
  QueryEngineOptions,
  QueryOptions,
  UseQueryResult,
  QueryFunction,
} from './query/query-engine.js';

export { MutationOutbox } from './query/mutation-outbox.js';
export type {
  MutationOutboxOptions,
  ReplayResult,
  ReplayOptions,
  ConflictResolution,
  MutationExecutor,
  ConflictResolver,
} from './query/mutation-outbox.js';

export {
  OnlineManager,
  onlineManager,
} from './network/online-manager.js';
export type { OnlineEventListenerSetup } from './network/online-manager.js';

export {
  FocusManager,
  focusManager,
} from './network/focus-manager.js';
export type { FocusEventListenerSetup } from './network/focus-manager.js';

export {
  BffTransport,
  BffHttpError,
} from './network/transports/bff-transport.js';
export type {
  ProblemDetails,
  TokenGetter as BffTokenGetter,
  BffTransportOptions,
} from './network/transports/bff-transport.js';

export {
  GqlTransport,
  GqlError,
} from './network/transports/gql-transport.js';
export type {
  GqlErrorLocation,
  GqlGraphQLError,
  GqlRequestPayload,
  TokenGetter as GqlTokenGetter,
  GqlTransportOptions,
} from './network/transports/gql-transport.js';

export { WsTransport } from './network/transports/ws-transport.js';
export type {
  WsConnectionState,
  WebSocketLike,
  WsTransportOptions,
} from './network/transports/ws-transport.js';

export { WebRtcDataTransport } from './network/transports/webrtc-transport.js';
export type {
  WebRtcConnectionState,
  RTCDataChannelLike,
  DecodedFrame,
  WebRtcTransportOptions,
} from './network/transports/webrtc-transport.js';

export {
  createSelectorObserver,
  defaultIsEqual,
} from './consumer/observer.js';
export type {
  SelectorObserver,
  SelectorObserverOptions,
} from './consumer/observer.js';

export {
  CliDurabilityManager,
  registerExitFlush,
  getDefaultDurabilityManager,
  resetDefaultDurabilityManager,
} from './cli/durability.js';
export type {
  FlushFn,
  ProcessLike,
  CliDurabilityManagerOptions,
} from './cli/durability.js';

export {
  PayloadRegistry,
  MissingUpcasterError,
  InvalidVersionError,
  IncompatiblePayloadError,
} from './query/payload-upcaster.js';
export type {
  PayloadUpcaster,
  UpcastContext,
  UpcastResult,
} from './query/payload-upcaster.js';

