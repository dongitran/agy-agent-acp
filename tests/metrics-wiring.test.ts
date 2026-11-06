import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgyAcpAgent } from "../src/agy-agent.js";
import { AgyRunError } from "../src/agy-process.js";
import type { MetricsService, RunRecord } from "../src/metrics.js";
import type { AgyUsage } from "../src/agy-process.js";
import * as fs from "node:fs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

const logger = { log: vi.fn(), error: vi.fn() };
const client = { notify: vi.fn().mockResolvedValue(undefined) };

function fakeMetrics(): MetricsService & { runs: RunRecord[]; flushes: number; shutdowns: number } {
  const m = {
    runs: [] as RunRecord[],
    flushes: 0,
    shutdowns: 0,
    recordRun(run: RunRecord) {
      m.runs.push(run);
    },
    async flush() {
      m.flushes++;
    },
    async shutdown() {
      m.shutdowns++;
    },
  };
  return m;
}

type Outcome = { stop?: string; error?: Error; usage?: AgyUsage; cancel?: boolean };

/** An agent whose session's agy answers each run with the next outcome, reporting usage first when given. */
async function agentWith(outcomes: Outcome[], metrics: MetricsService | null) {
  const agent = new AgyAcpAgent(client as never, logger, { metrics });
  const { sessionId } = await agent.newSession({ cwd: "/w" } as never);
  const session = (agent as unknown as { sessions: Map<string, any> }).sessions.get(sessionId);
  session.process.sendPrompt = vi.fn(async (_prompt: string, callbacks: { onUsage?: (u: AgyUsage) => Promise<void> }) => {
    const next = outcomes.shift() ?? {};
    if (next.usage) {
      await callbacks.onUsage?.(next.usage);
    }
    if (next.cancel) {
      session.cancelRequested = true;
    }
    if (next.error) {
      throw next.error;
    }
    return next.stop ?? "end_turn";
  });
  session.process.drainQueue = vi.fn(async () => {});
  session.process.endProcess = vi.fn(() => session.process.onExit?.());
  const ask = () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] } as never);
  return { agent, ask };
}

describe("AgyAcpAgent records one run metric per agy run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGY_ACP_SIGNIN_RETRY_DELAY_MS = "0";
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });
  afterEach(() => {
    delete process.env.AGY_ACP_SIGNIN_RETRY_DELAY_MS;
  });

  it("records an answered run as ok with its duration and last usage, and flushes", async () => {
    const metrics = fakeMetrics();
    const usage = { input_tokens: 10, output_tokens: 5 };
    const { ask } = await agentWith([{ usage }], metrics);

    await expect(ask()).resolves.toEqual({ stopReason: "end_turn" });

    expect(metrics.runs).toHaveLength(1);
    expect(metrics.runs[0]).toMatchObject({ outcome: "ok", usage });
    expect(metrics.runs[0].durationSeconds).toBeGreaterThanOrEqual(0);
    expect(metrics.runs[0].errorMessage).toBeUndefined();
    expect(metrics.flushes).toBe(1);
  });

  it("records a cancelled run as cancelled", async () => {
    const metrics = fakeMetrics();
    const { ask } = await agentWith([{ stop: "cancelled" }], metrics);
    await expect(ask()).resolves.toEqual({ stopReason: "cancelled" });
    expect(metrics.runs.map((r) => r.outcome)).toEqual(["cancelled"]);
  });

  it("records a failed run as an error with agy's message and kind, and the turn still fails the same way", async () => {
    const metrics = fakeMetrics();
    const message = "API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";
    const { ask } = await agentWith([{ error: new AgyRunError(message, "error-result", false) }], metrics);

    const err = await ask().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as Error).message).toBe(`agy: ${message}`);

    expect(metrics.runs).toEqual([
      expect.objectContaining({ outcome: "error", errorMessage: message, failureKind: "error-result" }),
    ]);
  });

  it("records each run of a retried sign-in: the failure, then the answer", async () => {
    const metrics = fakeMetrics();
    const { ask } = await agentWith(
      [{ error: new AgyRunError("authentication failed or timed out", "sign-in", true) }, {}],
      metrics
    );
    await expect(ask()).resolves.toEqual({ stopReason: "end_turn" });
    expect(metrics.runs.map((r) => [r.outcome, r.failureKind])).toEqual([
      ["error", "sign-in"],
      ["ok", undefined],
    ]);
  });

  it("records a run that failed after a cancel as cancelled, not as an error", async () => {
    const metrics = fakeMetrics();
    const { ask } = await agentWith([{ cancel: true, error: new AgyRunError("agy exited with code 143", "exited", false) }], metrics);
    await expect(ask()).resolves.toEqual({ stopReason: "cancelled" });
    expect(metrics.runs.map((r) => r.outcome)).toEqual(["cancelled"]);
  });

  it("classifies a plain Error thrown by a run under kind error", async () => {
    const metrics = fakeMetrics();
    const { ask } = await agentWith([{ error: new Error("socket hang up") }], metrics);
    await ask().catch(() => {});
    expect(metrics.runs[0]).toMatchObject({ outcome: "error", failureKind: "error", errorMessage: "socket hang up" });
  });

  it("runs without metrics when they are off", async () => {
    const { ask } = await agentWith([{}], null);
    await expect(ask()).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("a metrics service that throws never fails the turn", async () => {
    const metrics = fakeMetrics();
    metrics.recordRun = () => {
      throw new Error("broken metrics");
    };
    const { ask } = await agentWith([{}], metrics);
    await expect(ask()).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("shuts the metrics down with the agent", async () => {
    const metrics = fakeMetrics();
    const { agent } = await agentWith([], metrics);
    await agent.dispose();
    expect(metrics.shutdowns).toBe(1);
  });
});
