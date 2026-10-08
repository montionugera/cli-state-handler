import type { QueryKey } from '../types.js';

export class MissingUpcasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingUpcasterError';
  }
}

export class InvalidVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVersionError';
  }
}

export class IncompatiblePayloadError extends Error {
  readonly queryKey?: QueryKey;
  readonly payloadVersion?: number;
  readonly targetVersion?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options?: {
      queryKey?: QueryKey;
      payloadVersion?: number;
      targetVersion?: number;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = 'IncompatiblePayloadError';
    this.queryKey = options?.queryKey;
    this.payloadVersion = options?.payloadVersion;
    this.targetVersion = options?.targetVersion;
    this.cause = options?.cause;
  }
}

export interface UpcastContext {
  queryKey: QueryKey;
  fromVersion: number;
  toVersion: number;
}

export type PayloadUpcaster<TIn = unknown, TOut = unknown> = (
  payload: TIn,
  context: UpcastContext
) => TOut;

export interface UpcastResult<T = unknown> {
  data: T;
  fromVersion: number;
  toVersion: number;
  stepsApplied: number;
}

interface UpcasterRegistration {
  prefix: readonly unknown[];
  fromVersion: number;
  toVersion: number;
  upcaster: PayloadUpcaster<any, any>;
}

export class PayloadRegistry {
  private _registrations: UpcasterRegistration[] = [];

  /**
   * Registers a transformation step from fromVersion to toVersion for a query key prefix.
   */
  register<TIn = unknown, TOut = unknown>(
    queryKeyPrefix: string | QueryKey,
    fromVersion: number,
    toVersion: number,
    upcaster: PayloadUpcaster<TIn, TOut>
  ): void {
    if (fromVersion >= toVersion) {
      throw new InvalidVersionError(
        `Invalid upcaster registration: fromVersion (${fromVersion}) must be less than toVersion (${toVersion})`
      );
    }
    const prefix = Array.isArray(queryKeyPrefix)
      ? queryKeyPrefix
      : [queryKeyPrefix];

    this._registrations.push({
      prefix,
      fromVersion,
      toVersion,
      upcaster: upcaster as PayloadUpcaster<any, any>,
    });
  }

  /**
   * Chains and executes sequential upcaster functions from fromVersion to targetVersion.
   */
  upcast<T = unknown>(
    queryKey: QueryKey,
    payload: unknown,
    fromVersion: number,
    targetVersion: number
  ): UpcastResult<T> {
    if (fromVersion > targetVersion) {
      throw new InvalidVersionError(
        `Cannot downcast payload from version ${fromVersion} to ${targetVersion}`
      );
    }

    if (fromVersion === targetVersion) {
      return {
        data: payload as T,
        fromVersion,
        toVersion: targetVersion,
        stepsApplied: 0,
      };
    }

    // Find all matching registrations for this queryKey
    const matchingRegistrations = this._getMatchingRegistrations(queryKey);

    // Find path using BFS (shortest path of transformations)
    const path = this._findShortestPath(
      fromVersion,
      targetVersion,
      matchingRegistrations
    );

    if (!path) {
      throw new MissingUpcasterError(
        `No upcaster path found for query key ${JSON.stringify(queryKey)} from version ${fromVersion} to ${targetVersion}`
      );
    }

    // Apply sequentially
    let currentData = payload;
    for (const step of path) {
      currentData = step.upcaster(currentData, {
        queryKey,
        fromVersion: step.fromVersion,
        toVersion: step.toVersion,
      });
    }

    return {
      data: currentData as T,
      fromVersion,
      toVersion: targetVersion,
      stepsApplied: path.length,
    };
  }

  private _getMatchingRegistrations(queryKey: QueryKey): UpcasterRegistration[] {
    return this._registrations.filter((reg) =>
      this._matchesPrefix(queryKey, reg.prefix)
    );
  }

  private _matchesPrefix(
    queryKey: QueryKey,
    prefix: readonly unknown[]
  ): boolean {
    if (prefix.length > queryKey.length) return false;

    for (let i = 0; i < prefix.length; i++) {
      const p = prefix[i];
      const k = queryKey[i];
      if (p === '*') continue;
      if (p !== k) return false;
    }

    return true;
  }

  private _findShortestPath(
    start: number,
    target: number,
    registrations: UpcasterRegistration[]
  ): UpcasterRegistration[] | null {
    // Sort registrations by specificity: longer prefixes first
    const sorted = [...registrations].sort(
      (a, b) => b.prefix.length - a.prefix.length
    );

    const adj = new Map<number, UpcasterRegistration[]>();
    for (const reg of sorted) {
      if (!adj.has(reg.fromVersion)) {
        adj.set(reg.fromVersion, []);
      }
      adj.get(reg.fromVersion)!.push(reg);
    }

    // BFS queue: [currentVersion, path]
    const queue: Array<{ version: number; path: UpcasterRegistration[] }> = [
      { version: start, path: [] },
    ];
    const visited = new Set<number>([start]);

    while (queue.length > 0) {
      const { version, path } = queue.shift()!;

      if (version === target) {
        return path;
      }

      const edges = adj.get(version) ?? [];
      for (const edge of edges) {
        if (!visited.has(edge.toVersion)) {
          visited.add(edge.toVersion);
          queue.push({
            version: edge.toVersion,
            path: [...path, edge],
          });
        }
      }
    }

    return null;
  }
}
