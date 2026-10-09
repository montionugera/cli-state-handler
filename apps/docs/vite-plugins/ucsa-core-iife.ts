import path from "node:path";
import { build, type Plugin } from "vite";

const VIRTUAL_ID = "virtual:ucsa-core-iife";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const ENTRY = path.resolve(import.meta.dirname, "../../../packages/core/src/browser.ts");

/**
 * Exposes `virtual:ucsa-core-iife`: the browser-safe @montionugera/ucsa-core entry bundled to a
 * single IIFE (global `UcsaCore`) and exported as a string, so the sandbox can inline
 * it into an iframe `srcdoc` (the frame has an opaque origin and cannot fetch modules).
 */
export function ucsaCoreIife(): Plugin {
  return {
    name: "ucsa-core-iife",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      this.addWatchFile(ENTRY);
      const out = await build({
        configFile: false,
        logLevel: "silent",
        build: {
          write: false,
          minify: true,
          lib: { entry: ENTRY, name: "UcsaCore", formats: ["iife"], fileName: "ucsa-core" }
        }
      });
      const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
      const chunk = outputs.find((o) => o.type === "chunk");
      if (!chunk || chunk.type !== "chunk") throw new Error("ucsa-core-iife: no chunk produced");
      return `export default ${JSON.stringify(chunk.code)};`;
    }
  };
}
