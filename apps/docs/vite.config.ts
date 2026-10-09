import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { ucsaCoreIife } from "./vite-plugins/ucsa-core-iife.js";

export default defineConfig({
  base: "/cli-state-handler/",
  plugins: [react(), ucsaCoreIife()],
  server: {
    port: 6006,
    strictPort: false // silently falls back to 6007 if 6006 is occupied
  },
  resolve: {
    alias: {
      "@montionugera/ucsa-core": path.resolve(import.meta.dirname, "../../packages/core/src/browser.ts")
    }
  }
});
