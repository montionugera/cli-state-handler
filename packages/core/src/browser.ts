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
  createSelectorObserver,
  defaultIsEqual,
} from './consumer/observer.js';
export type {
  SelectorObserver,
  SelectorObserverOptions,
} from './consumer/observer.js';
