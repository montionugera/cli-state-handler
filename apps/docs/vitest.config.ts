import { defineConfig } from "vitest/config";
import { ucsaCoreIife } from "./vite-plugins/ucsa-core-iife.js";

export default defineConfig({
  plugins: [ucsaCoreIife()],
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 15000
  }
});
