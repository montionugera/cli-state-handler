import * as net from "node:net";
import { spawn } from "node:child_process";
import * as path from "node:path";

export interface TutorialOptions {
  port?: number;
  host?: string;
  open?: boolean;
  dryRun?: boolean;
}

export interface TutorialRunResult {
  port: number;
  host: string;
  url: string;
  status: "ready" | "running";
}

/**
 * Checks if a port is currently available on the host.
 */
export function isPortAvailable(port: number, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Resolves the target port, silently falling back from 6006 to 6007 on collision (Rule 6).
 */
export async function resolvePort(preferredPort = 6006, host = "localhost"): Promise<number> {
  const preferredAvailable = await isPortAvailable(preferredPort, host);
  if (preferredAvailable) {
    return preferredPort;
  }
  // Fall back to 6007 silently if 6006 is occupied
  if (preferredPort === 6006) {
    const fallbackAvailable = await isPortAvailable(6007, host);
    if (fallbackAvailable) {
      return 6007;
    }
  }
  return preferredPort + 1;
}

export async function runTutorial(options: TutorialOptions = {}): Promise<TutorialRunResult> {
  const host = options.host || "localhost";
  const preferredPort = options.port || 6006;
  const resolvedPort = await resolvePort(preferredPort, host);
  const url = `http://${host}:${resolvedPort}`;

  console.log("⚡ UCSA Live Studio & Interactive Documentation");
  console.log(`📡 Local server URL: ${url}`);

  if (options.dryRun) {
    console.log("[ucsa] Dry-run validated cleanly. Server ready to launch.");
    return {
      port: resolvedPort,
      host,
      url,
      status: "ready"
    };
  }

  const docsDir = path.resolve(import.meta.dirname, "../../../docs");
  console.log(`📂 Serving documentation from: ${docsDir}`);
  console.log("ℹ️  Press Ctrl+C to terminate.");

  // Launch vite server for apps/docs
  const child = spawn("pnpm", ["--filter", "@ucsa/docs", "dev", "--port", String(resolvedPort), "--host", host], {
    stdio: "inherit",
    shell: true
  });

  child.on("error", (err) => {
    console.error("[ucsa] Failed to start documentation server:", err);
  });

  return {
    port: resolvedPort,
    host,
    url,
    status: "running"
  };
}
