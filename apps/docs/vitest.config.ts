import { defineConfig } from "vitest/config";
import { ucsaCoreIife } from "./vite-plugins/ucsa-core-iife.js";
import { joyAlias } from "./joy-alias.js";

export default defineConfig({
  plugins: [ucsaCoreIife()],
  resolve: { dedupe: ["react", "react-dom"], alias: joyAlias },
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 15000
  }
});
