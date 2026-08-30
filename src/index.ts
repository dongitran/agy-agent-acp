#!/usr/bin/env node
import { runAcp } from "./agy-agent.js";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
    process.stdout.write(`${pkg.version}\n`);
  } catch {
    process.stdout.write("0.1.1\n");
  }
  process.exit(0);
}

// Redirect all standard console logging to stderr to prevent corrupting ACP JSON-RPC on stdout
/* eslint-disable no-console */
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
/* eslint-enable no-console */

process.on("unhandledRejection", (reason, promise) => {
  console.error("[agy-agent-acp] Unhandled Rejection at:", promise, "reason:", reason);
});

const logDirectory = process.env.AGY_AGENT_LOGS || process.env.BUZZ_ACP_LOG_DIR;
const logger = logDirectory
  ? (() => {
      try {
        mkdirSync(logDirectory, { recursive: true });
        const logFile = join(logDirectory, "agy-acp.log");
        const writeLog = (...args: unknown[]) => {
          const rendered = args
            .map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)))
            .join(" ");
          appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} ${rendered}\n`);
        };
        return {
          log: writeLog,
          error: (...args: unknown[]) => {
            console.error(...args);
            writeLog(...args);
          },
        };
      } catch {
        return {
          log: (...args: unknown[]) => console.error(...args),
          error: (...args: unknown[]) => console.error(...args),
        };
      }
    })()
  : {
      log: (...args: unknown[]) => console.error(...args),
      error: (...args: unknown[]) => console.error(...args),
    };

logger.log("[agy-agent-acp] Starting Antigravity ACP Agent Bridge...");

const { connection, agent } = runAcp(logger);

async function shutdown() {
  logger.log("[agy-agent-acp] Shutting down...");
  await agent.dispose().catch((err: unknown) => {
    console.error("[agy-agent-acp] Error during cleanup:", err);
  });
  process.exit(0);
}

connection.closed.then(shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Keep process stdin alive
process.stdin.resume();
