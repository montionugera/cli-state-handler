import { describe, it, expect, beforeEach } from 'vitest';
import {
  PayloadRegistry,
  MissingUpcasterError,
  InvalidVersionError,
  type UpcastContext,
} from '../../src/query/payload-upcaster.js';

describe('PayloadRegistry & Upcasting Pipeline', () => {
  let registry: PayloadRegistry;

  beforeEach(() => {
    registry = new PayloadRegistry();
  });

  it('performs single-step upcast (v1 -> v2)', () => {
    interface V1User {
      name: string;
    }
    interface V2User {
      fullName: string;
      migrated: boolean;
    }

    registry.register<V1User, V2User>(
      'users',
      1,
      2,
      (v1, ctx) => ({
        fullName: v1.name,
        migrated: true,
      })
    );

    const result = registry.upcast<V2User>(
      ['users', 101],
      { name: 'Alice' },
      1,
      2
    );

    expect(result.data).toEqual({ fullName: 'Alice', migrated: true });
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(result.stepsApplied).toBe(1);
  });

  it('performs multi-step sequential chaining (v1 -> v2 -> v3)', () => {
    // v1: { name: string }
    // v2: { firstName: string, lastName: string }
    // v3: { fullName: { first: string, last: string }, version: 3 }

    registry.register<{ name: string }, { firstName: string; lastName: string }>(
      ['users'],
      1,
      2,
      (v1) => {
        const parts = v1.name.split(' ');
        return { firstName: parts[0], lastName: parts[1] || '' };
      }
    );

    registry.register<{ firstName: string; lastName: string }, { fullName: { first: string; last: string }; version: number }>(
      ['users'],
      2,
      3,
      (v2) => ({
        fullName: { first: v2.firstName, last: v2.lastName },
        version: 3,
      })
    );

    const result = registry.upcast<{ fullName: { first: string; last: string }; version: number }>(
      ['users', 'profile', 42],
      { name: 'John Doe' },
      1,
      3
    );

    expect(result.data).toEqual({
      fullName: { first: 'John', last: 'Doe' },
      version: 3,
    });
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(3);
    expect(result.stepsApplied).toBe(2);
  });

  it('prefers direct transition over multi-step chain if registered', () => {
    registry.register('users', 1, 2, (v: any) => ({ ...v, v2: true }));
    registry.register('users', 2, 3, (v: any) => ({ ...v, v3: true }));
    registry.register('users', 1, 3, (v: any) => ({ ...v, shortcut: true }));

    const result = registry.upcast<any>(['users', 1], { val: 10 }, 1, 3);
    expect(result.data).toEqual({ val: 10, shortcut: true });
    expect(result.stepsApplied).toBe(1);
  });

  it('returns unchanged payload when fromVersion === targetVersion (no-op)', () => {
    const original = { id: 1, active: true };
    const result = registry.upcast(['items', 1], original, 2, 2);

    expect(result.data).toBe(original);
    expect(result.fromVersion).toBe(2);
    expect(result.toVersion).toBe(2);
    expect(result.stepsApplied).toBe(0);
  });

  it('matches query keys by prefix hierarchy and wildcard', () => {
    registry.register(['tenants', '*', 'settings'], 1, 2, (data: any) => ({
      ...data,
      upgraded: true,
    }));

    // Should match ['tenants', 't-123', 'settings', 'theme']
    const result = registry.upcast<any>(
      ['tenants', 't-123', 'settings', 'theme'],
      { theme: 'dark' },
      1,
      2
    );
    expect(result.data).toEqual({ theme: 'dark', upgraded: true });

    // Should not match ['tenants', 't-123', 'users']
    expect(() => {
      registry.upcast(['tenants', 't-123', 'users'], { user: 'Alice' }, 1, 2);
    }).toThrow(MissingUpcasterError);
  });

  it('throws MissingUpcasterError when a required intermediate version step is missing', () => {
    // Only 1 -> 2 is registered, but target is 3
    registry.register('users', 1, 2, (v1: any) => ({ ...v1, v: 2 }));

    expect(() => {
      registry.upcast(['users', 1], { name: 'Alice' }, 1, 3);
    }).toThrow(MissingUpcasterError);
  });

  it('throws InvalidVersionError when fromVersion > targetVersion (downgrades forbidden)', () => {
    expect(() => {
      registry.upcast(['users', 1], { name: 'Alice' }, 3, 2);
    }).toThrow(InvalidVersionError);
  });

  it('passes context metadata including queryKey and version steps to upcaster', () => {
    let capturedContext: UpcastContext | undefined;

    registry.register('items', 1, 2, (payload: any, ctx) => {
      capturedContext = ctx;
      return { ...payload, checked: true };
    });

    registry.upcast(['items', 'abc'], { value: 99 }, 1, 2);

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.queryKey).toEqual(['items', 'abc']);
    expect(capturedContext?.fromVersion).toBe(1);
    expect(capturedContext?.toVersion).toBe(2);
  });
});
