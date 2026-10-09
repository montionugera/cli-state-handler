import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Emits version.json so a deployed docs build can be matched to a library release. */
export function versionJson(): Plugin {
  return {
    name: "ucsa-version-json",
    apply: "build",
    generateBundle() {
      const manifest = fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url));
      const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ version })}\n` });
    },
  };
}
