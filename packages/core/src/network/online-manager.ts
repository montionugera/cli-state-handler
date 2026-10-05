import type { UnsubscribeFn } from '../types.js';

export type OnlineEventListenerSetup = (
  setOnline: (online: boolean) => void
) => (() => void) | undefined;

/**
 * Manages network online/offline connectivity status and notifies subscribers upon state changes.
 */
export class OnlineManager {
  private _isOnline: boolean = true;
  private readonly _listeners = new Set<(isOnline: boolean) => void>();
  private _cleanupEventListener?: () => void;

  constructor() {
    const globalObj =
      typeof globalThis !== 'undefined'
        ? (globalThis as Record<string, any>)
        : undefined;
    if (
      globalObj?.navigator &&
      typeof globalObj.navigator.onLine === 'boolean'
    ) {
      this._isOnline = globalObj.navigator.onLine;
    }
    this.setupDefaultEventListener();
  }

  private setupDefaultEventListener(): void {
    const globalObj =
      typeof globalThis !== 'undefined'
        ? (globalThis as Record<string, any>)
        : undefined;
    if (
      globalObj?.window &&
      typeof globalObj.window.addEventListener === 'function'
    ) {
      this.setEventListener((setOnline) => {
        const win = globalObj.window;
        const onlineListener = () => setOnline(true);
        const offlineListener = () => setOnline(false);

        win.addEventListener('online', onlineListener);
        win.addEventListener('offline', offlineListener);

        return () => {
          win.removeEventListener('online', onlineListener);
          win.removeEventListener('offline', offlineListener);
        };
      });
    }
  }

  /**
   * Returns current online status.
   */
  isOnline(): boolean {
    return this._isOnline;
  }

  /**
   * Updates online state and notifies all subscribed listeners if state has changed.
   */
  setOnline(online: boolean): void {
    if (this._isOnline !== online) {
      this._isOnline = online;
      for (const listener of this._listeners) {
        try {
          listener(online);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  /**
   * Subscribes a listener callback to connectivity changes.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (isOnline: boolean) => void): UnsubscribeFn {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Configures a custom platform event listener setup (e.g. React Native NetInfo, Apple NWPathMonitor).
   */
  setEventListener(setup: OnlineEventListenerSetup): void {
    this._cleanupEventListener?.();
    this._cleanupEventListener = setup(this.setOnline.bind(this)) ?? undefined;
  }

  /**
   * Cleans up all registered event listeners and subscribers.
   */
  cleanup(): void {
    this._cleanupEventListener?.();
    this._cleanupEventListener = undefined;
    this._listeners.clear();
  }
}

/**
 * Default singleton OnlineManager instance.
 */
export const onlineManager = new OnlineManager();
