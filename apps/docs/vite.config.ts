import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6006,
    strictPort: false // silently falls back to 6007 if 6006 is occupied
  },
  resolve: {
    alias: {
      "@ucsa/core": path.resolve(import.meta.dirname, "../../packages/core/src/index.ts")
    }
  }
});
