import vm from "node:vm";
import type { SandboxMessage } from "../src/sandbox/protocol.js";

/**
 * Runs a sandbox program (core bundle + runtime + user code) in a Node vm context.
 * jsdom does not execute iframe srcdoc scripts, so this is the closest faithful run:
 * the same program string the frame would execute, with `parent.postMessage` captured.
 */
export function runProgramInVm(program: string): Promise<unknown[]> {
  const messages: unknown[] = [];
  return new Promise((resolve) => {
    const finish = () => resolve(messages);
    const guard = setTimeout(finish, 4000);
    const context = vm.createContext({
      console: { log() {}, info() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      AbortController,
      AbortSignal,
      queueMicrotask,
      parent: {
        postMessage(message: unknown) {
          messages.push(message);
          if (typeof message === "object" && message !== null && (message as SandboxMessage).type === "done") {
            clearTimeout(guard);
            finish();
          }
        }
      }
    });
    vm.runInContext(program, context);
  });
}
