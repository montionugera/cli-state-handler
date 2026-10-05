import type { UnsubscribeFn } from '../types.js';

export type FocusEventListenerSetup = (
  setFocused: (focused?: boolean) => void
) => (() => void) | undefined;

/**
 * Manages window/tab foreground focus state and notifies listeners on change.
 */
export class FocusManager {
  private _isFocused: boolean = true;
  private readonly _listeners = new Set<(isFocused: boolean) => void>();
  private _cleanupEventListener?: () => void;

  constructor() {
    const globalObj =
      typeof globalThis !== 'undefined'
        ? (globalThis as Record<string, any>)
        : undefined;
    if (
      globalObj?.document &&
      typeof globalObj.document.visibilityState === 'string'
    ) {
      this._isFocused = globalObj.document.visibilityState !== 'hidden';
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
      typeof globalObj.window.addEventListener === 'function' &&
      globalObj?.document &&
      typeof globalObj.document.addEventListener === 'function'
    ) {
      this.setEventListener((setFocused) => {
        const win = globalObj.window;
        const doc = globalObj.document;

        const visibilityListener = () => {
          setFocused(doc.visibilityState !== 'hidden');
        };
        const focusListener = () => setFocused(true);

        doc.addEventListener('visibilitychange', visibilityListener);
        win.addEventListener('focus', focusListener);

        return () => {
          doc.removeEventListener('visibilitychange', visibilityListener);
          win.removeEventListener('focus', focusListener);
        };
      });
    }
  }

  /**
   * Returns current focus status.
   */
  isFocused(): boolean {
    return this._isFocused;
  }

  /**
   * Sets foreground focus status and notifies subscribers if status changed.
   */
  setFocused(focused?: boolean): void {
    const globalObj =
      typeof globalThis !== 'undefined'
        ? (globalThis as Record<string, any>)
        : undefined;
    const nextFocused =
      focused !== undefined
        ? focused
        : globalObj?.document &&
            typeof globalObj.document.visibilityState === 'string'
          ? globalObj.document.visibilityState !== 'hidden'
          : true;

    if (this._isFocused !== nextFocused) {
      this._isFocused = nextFocused;
      for (const listener of this._listeners) {
        try {
          listener(nextFocused);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  /**
   * Subscribes a listener to focus status changes.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (isFocused: boolean) => void): UnsubscribeFn {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Configures a custom platform focus event listener (e.g. electron window focus, native didBecomeActive).
   */
  setEventListener(setup: FocusEventListenerSetup): void {
    this._cleanupEventListener?.();
    this._cleanupEventListener = setup(this.setFocused.bind(this)) ?? undefined;
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
 * Default singleton FocusManager instance.
 */
export const focusManager = new FocusManager();
