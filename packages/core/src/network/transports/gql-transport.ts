import type {
  TransportAdapter,
  TransportRequest,
  TransportResponse,
  InvalidationEvent,
  UnsubscribeFn,
} from '../../types.js';

export interface GqlErrorLocation {
  line: number;
  column: number;
}

export interface GqlGraphQLError {
  message: string;
  locations?: GqlErrorLocation[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

/**
 * Standard error thrown when a GraphQL response contains errors.
 */
export class GqlError extends Error {
  readonly errors: readonly GqlGraphQLError[];
  readonly data?: unknown;
  readonly status: number;

  constructor(
    errors: GqlGraphQLError[],
    data?: unknown,
    status: number = 200
  ) {
    const message = `GraphQL Error: ${errors.map((e) => e.message).join('; ')}`;
    super(message);
    this.name = 'GqlError';
    this.errors = errors;
    this.data = data;
    this.status = status;
  }
}

export interface GqlRequestPayload<TVariables = Record<string, unknown>> {
  query?: string;
  variables?: TVariables;
  operationName?: string;
  sha256Hash?: string;
  extensions?: {
    persistedQuery?: {
      version?: number;
      sha256Hash: string;
    };
    [key: string]: unknown;
  };
}

export type TokenGetter = () =>
  | string
  | undefined
  | Promise<string | undefined>;

export interface GqlTransportOptions {
  endpoint?: string;
  token?: string | TokenGetter;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

function extractHeaders(headers?: {
  forEach?: (cb: (val: string, key: string) => void) => void;
  [key: string]: any;
}): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((val: string, key: string) => {
      result[key.toLowerCase()] = val;
    });
  } else if (headers && typeof headers === 'object') {
    for (const [key, val] of Object.entries(headers)) {
      if (typeof val === 'string') {
        result[key.toLowerCase()] = val;
      }
    }
  }
  return result;
}

function findHeader(
  headers: Record<string, string>,
  targetName: string
): string | undefined {
  const targetLower = targetName.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === targetLower) {
      return val;
    }
  }
  return undefined;
}

/**
 * GraphQL Transport Adapter.
 * Supports query/variables payloads, Apollo Persisted Queries (sha256Hash),
 * data unwrapping, and GraphQL error formatting.
 */
export class GqlTransport implements TransportAdapter {
  private readonly _endpoint?: string;
  private readonly _token?: string | TokenGetter;
  private readonly _defaultHeaders: Record<string, string>;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _invalidationSubscribers = new Set<
    (event: InvalidationEvent) => void
  >();

  constructor(options?: GqlTransportOptions) {
    this._endpoint = options?.endpoint;
    this._token = options?.token;
    this._defaultHeaders = { ...(options?.headers ?? {}) };
    this._fetch =
      options?.fetch ??
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : (undefined as unknown as typeof globalThis.fetch));
  }

  /**
   * Executes a GraphQL request and unwraps the { data, errors } envelope.
   */
  async fetch<TData = unknown, TPayload = unknown>(
    request: TransportRequest<TPayload>
  ): Promise<TransportResponse<TData>> {
    const url = request.endpoint || this._endpoint;
    if (!url) {
      throw new Error('GqlTransport: No endpoint provided in request or options');
    }

    const mergedHeaders: Record<string, string> = {
      ...this._defaultHeaders,
      ...(request.headers ?? {}),
    };

    // 1. Inject Authorization header if token provided
    if (!findHeader(mergedHeaders, 'Authorization') && this._token) {
      const tokenValue =
        typeof this._token === 'function' ? await this._token() : this._token;
      if (tokenValue) {
        mergedHeaders['Authorization'] = `Bearer ${tokenValue}`;
      }
    }

    if (!findHeader(mergedHeaders, 'Content-Type')) {
      mergedHeaders['Content-Type'] = 'application/json';
    }

    // 2. Format GraphQL payload
    let bodyObj: Record<string, unknown> = {};
    if (typeof request.payload === 'string') {
      bodyObj = { query: request.payload };
    } else if (typeof request.payload === 'object' && request.payload !== null) {
      const payload = request.payload as GqlRequestPayload;
      if (payload.query) {
        bodyObj.query = payload.query;
      }
      if (payload.variables !== undefined) {
        bodyObj.variables = payload.variables;
      }
      if (payload.operationName) {
        bodyObj.operationName = payload.operationName;
      }

      const sha256Hash =
        payload.sha256Hash ?? payload.extensions?.persistedQuery?.sha256Hash;
      if (sha256Hash) {
        bodyObj.extensions = {
          ...(payload.extensions ?? {}),
          persistedQuery: {
            version: payload.extensions?.persistedQuery?.version ?? 1,
            sha256Hash,
          },
        };
      } else if (payload.extensions) {
        bodyObj.extensions = payload.extensions;
      }
    }

    const response = await this._fetch(url, {
      method: request.method ?? 'POST',
      headers: mergedHeaders,
      body: JSON.stringify(bodyObj),
      signal: request.signal,
    });

    const respHeaders = extractHeaders(response.headers as any);
    const responseText = await response.text();
    let json: { data?: unknown; errors?: GqlGraphQLError[] } = {};

    if (responseText) {
      try {
        json = JSON.parse(responseText);
      } catch {
        // Not a JSON response
        throw new Error(
          `GqlTransport: Server returned non-JSON response with status ${response.status}`
        );
      }
    }

    // 3. Check for GraphQL errors
    if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
      throw new GqlError(json.errors, json.data, response.status);
    }

    if (!response.ok) {
      throw new Error(
        `HTTP Error ${response.status}: ${response.statusText || 'GraphQL request failed'}`
      );
    }

    return {
      status: response.status,
      data: json.data as TData,
      headers: respHeaders,
    };
  }

  /**
   * Helper method for executing a GraphQL query directly.
   */
  async query<TData = unknown, TVariables = Record<string, unknown>>(
    query: string,
    variables?: TVariables,
    options?: { sha256Hash?: string; signal?: AbortSignal; endpoint?: string }
  ): Promise<TData> {
    const res = await this.fetch<TData>({
      endpoint: options?.endpoint ?? this._endpoint ?? '',
      payload: {
        query,
        variables,
        sha256Hash: options?.sha256Hash,
      },
      signal: options?.signal,
    });
    return res.data;
  }

  /**
   * Subscribes a listener to invalidation events.
   */
  subscribe(onEvent: (event: InvalidationEvent) => void): UnsubscribeFn {
    this._invalidationSubscribers.add(onEvent);
    return () => {
      this._invalidationSubscribers.delete(onEvent);
    };
  }

  /**
   * Emits an invalidation event to all registered subscribers.
   */
  emitInvalidation(event: InvalidationEvent): void {
    for (const subscriber of this._invalidationSubscribers) {
      try {
        subscriber(event);
      } catch {
        // Ignore subscriber errors
      }
    }
  }
}
