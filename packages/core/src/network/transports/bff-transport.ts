import type {
  TransportAdapter,
  TransportRequest,
  TransportResponse,
  InvalidationEvent,
  UnsubscribeFn,
} from '../../types.js';

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export class BffHttpError extends Error {
  readonly status: number;
  readonly problemDetails?: ProblemDetails;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    message: string,
    problemDetails?: ProblemDetails,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'BffHttpError';
    this.status = status;
    this.problemDetails = problemDetails;
    this.headers = headers;
  }
}

export type TokenGetter = () =>
  | string
  | undefined
  | Promise<string | undefined>;

export interface BffTransportOptions {
  baseUrl?: string;
  token?: string | TokenGetter;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  etagCache?: Map<string, { etag: string; data: unknown }>;
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
 * BFF REST Transport Adapter.
 * Supports Bearer token auth injection, ETag conditional revalidations (304 Not Modified),
 * and RFC 7807 Problem Details translation.
 */
export class BffTransport implements TransportAdapter {
  private readonly _baseUrl?: string;
  private readonly _token?: string | TokenGetter;
  private readonly _defaultHeaders: Record<string, string>;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _cache: Map<string, { etag: string; data: unknown }>;
  private readonly _invalidationSubscribers = new Set<
    (event: InvalidationEvent) => void
  >();

  constructor(options?: BffTransportOptions) {
    this._baseUrl = options?.baseUrl;
    this._token = options?.token;
    this._defaultHeaders = { ...(options?.headers ?? {}) };
    this._fetch =
      options?.fetch ??
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : (undefined as unknown as typeof globalThis.fetch));
    this._cache = options?.etagCache ?? new Map();
  }

  /**
   * Resolves endpoint URL with base URL if configured.
   */
  private resolveUrl(endpoint: string): string {
    if (!this._baseUrl) {
      return endpoint;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(endpoint)) {
      return endpoint;
    }
    return new URL(endpoint, this._baseUrl).toString();
  }

  /**
   * Returns cached ETag for an endpoint if present.
   */
  getCachedEtag(endpoint: string): string | undefined {
    return this._cache.get(endpoint)?.etag;
  }

  /**
   * Manually sets cached data and ETag for an endpoint.
   */
  setCachedData(endpoint: string, etag: string, data: unknown): void {
    this._cache.set(endpoint, { etag, data });
  }

  /**
   * Clears the internal ETag cache.
   */
  clearCache(): void {
    this._cache.clear();
  }

  /**
   * Performs an HTTP request with automatic auth token injection, ETag handling, and JSON parsing.
   */
  async fetch<TData = unknown, TPayload = unknown>(
    request: TransportRequest<TPayload>
  ): Promise<TransportResponse<TData>> {
    const url = this.resolveUrl(request.endpoint);
    const cacheKey = request.endpoint;
    const cachedEntry = this._cache.get(cacheKey);

    const mergedHeaders: Record<string, string> = {
      ...this._defaultHeaders,
      ...(request.headers ?? {}),
    };

    // 1. Inject Authorization header if token configured and not already set
    if (!findHeader(mergedHeaders, 'Authorization') && this._token) {
      const tokenValue =
        typeof this._token === 'function' ? await this._token() : this._token;
      if (tokenValue) {
        mergedHeaders['Authorization'] = `Bearer ${tokenValue}`;
      }
    }

    // 2. Inject If-None-Match header if cached ETag exists
    if (!findHeader(mergedHeaders, 'If-None-Match') && cachedEntry?.etag) {
      mergedHeaders['If-None-Match'] = cachedEntry.etag;
    }

    const method =
      request.method ?? (request.payload !== undefined ? 'POST' : 'GET');

    let body: string | undefined;
    if (request.payload !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (typeof request.payload === 'string') {
        body = request.payload;
      } else {
        body = JSON.stringify(request.payload);
        if (!findHeader(mergedHeaders, 'Content-Type')) {
          mergedHeaders['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await this._fetch(url, {
      method,
      headers: mergedHeaders,
      body,
      signal: request.signal,
    });

    const respHeaders = extractHeaders(response.headers as any);
    const etagHeader =
      (typeof response.headers?.get === 'function'
        ? response.headers.get('etag') ?? response.headers.get('ETag')
        : undefined) ?? undefined;

    // Handle 304 Not Modified
    if (response.status === 304) {
      return {
        status: 304,
        data: cachedEntry?.data as TData,
        etag: etagHeader ?? cachedEntry?.etag,
        headers: respHeaders,
      };
    }

    const responseText = await response.text();
    let parsedData: unknown;
    if (responseText) {
      try {
        parsedData = JSON.parse(responseText);
      } catch {
        parsedData = responseText;
      }
    }

    // Handle HTTP error responses
    if (!response.ok) {
      const problemDetails =
        typeof parsedData === 'object' && parsedData !== null
          ? (parsedData as ProblemDetails)
          : undefined;

      const errorMessage =
        problemDetails?.detail ||
        problemDetails?.title ||
        `HTTP Error ${response.status}: ${response.statusText || 'Request failed'}`;

      throw new BffHttpError(
        response.status,
        errorMessage,
        problemDetails,
        respHeaders
      );
    }

    // Update ETag cache on successful response
    if (etagHeader) {
      this._cache.set(cacheKey, { etag: etagHeader, data: parsedData });
    }

    return {
      status: response.status,
      data: parsedData as TData,
      etag: etagHeader,
      headers: respHeaders,
    };
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
