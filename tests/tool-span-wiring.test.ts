import { describe, it, expect, vi } from "vitest";
import { AgyAcpAgent } from "../src/agy-agent.js";
import { initTelemetry } from "../src/telemetry.js";
import type { AgentContext } from "@agentclientprotocol/sdk";

// docs/028-05 & 028-07: Tool span wiring tests between AgyProcess, AgyAcpAgent, and TelemetryEngine.
const step = (step_index: number, state: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index,
      state,
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { parameters: { CommandLine: `cmd-${step_index}` }, ...extra },
    },
  });

describe("tool span wiring between AgyProcess and AgyAcpAgent", () => {
  it("opens and closes every tool span under its own step index", async () => {
    const agent = new AgyAcpAgent({ notify: vi.fn() } as unknown as AgentContext);
    const turnHandle = { startToolSpan: vi.fn(), endToolSpan: vi.fn(), recordUsage: vi.fn(), end: vi.fn() };
    (agent as any).telemetry = { startTurnSpan: () => turnHandle, backgroundFlush: vi.fn(), shutdown: vi.fn() };
    const { sessionId } = await agent.newSession({ cwd: "/workspace" });
    const proc = (agent as any).sessions.get(sessionId).process;
    proc.sendPrompt = vi.fn().mockImplementation(async (_prompt: string, callbacks: unknown) => {
      proc.currentTurnCallbacks = callbacks;
      for (const idx of [2, 4, 6]) {
        await proc.handleLine(step(idx, "ACTIVE"));
        await proc.handleLine(step(idx, "DONE", { output: `out-${idx}` }));
      }
      return "end_turn";
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

    expect(turnHandle.startToolSpan.mock.calls.map((c) => c[0])).toEqual([2, 4, 6]);
    expect(turnHandle.endToolSpan.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [2, "out-2"],
      [4, "out-4"],
      [6, "out-6"],
    ]);
    expect(turnHandle.end).toHaveBeenCalledWith("OK", "");
  });

  it("handles fast tools that emit DONE directly without preceding ACTIVE", async () => {
    const agent = new AgyAcpAgent({ notify: vi.fn() } as unknown as AgentContext);
    const turnHandle = { startToolSpan: vi.fn(), endToolSpan: vi.fn(), recordUsage: vi.fn(), end: vi.fn() };
    (agent as any).telemetry = { startTurnSpan: () => turnHandle, backgroundFlush: vi.fn(), shutdown: vi.fn() };
    const { sessionId } = await agent.newSession({ cwd: "/workspace" });
    const proc = (agent as any).sessions.get(sessionId).process;
    proc.sendPrompt = vi.fn().mockImplementation(async (_prompt: string, callbacks: unknown) => {
      proc.currentTurnCallbacks = callbacks;
      // Fast tool: directly DONE without ACTIVE
      await proc.handleLine(step(10, "DONE", { output: "fast-out" }));
      return "end_turn";
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "fast tool test" }] });

    expect(turnHandle.startToolSpan).toHaveBeenCalledWith(10, "run_command", { CommandLine: "cmd-10" });
    expect(turnHandle.endToolSpan).toHaveBeenCalledWith(10, "run_command", "fast-out", undefined);
  });

  it("records error when tool fails with ERROR state", async () => {
    const agent = new AgyAcpAgent({ notify: vi.fn() } as unknown as AgentContext);
    const turnHandle = { startToolSpan: vi.fn(), endToolSpan: vi.fn(), recordUsage: vi.fn(), end: vi.fn() };
    (agent as any).telemetry = { startTurnSpan: () => turnHandle, backgroundFlush: vi.fn(), shutdown: vi.fn() };
    const { sessionId } = await agent.newSession({ cwd: "/workspace" });
    const proc = (agent as any).sessions.get(sessionId).process;
    proc.sendPrompt = vi.fn().mockImplementation(async (_prompt: string, callbacks: unknown) => {
      proc.currentTurnCallbacks = callbacks;
      await proc.handleLine(step(2, "ACTIVE"));
      await proc.handleLine(step(2, "ERROR", { error: { message: "Command timed out" } }));
      return "end_turn";
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "error test" }] });

    expect(turnHandle.startToolSpan).toHaveBeenCalledWith(2, "run_command", { CommandLine: "cmd-2" });
    expect(turnHandle.endToolSpan).toHaveBeenCalledWith(2, "run_command", undefined, { message: "Command timed out" });
  });

  it("records ERROR on turn span when turn is cancelled", async () => {
    const agent = new AgyAcpAgent({ notify: vi.fn() } as unknown as AgentContext);
    const turnHandle = { startToolSpan: vi.fn(), endToolSpan: vi.fn(), recordUsage: vi.fn(), end: vi.fn() };
    (agent as any).telemetry = { startTurnSpan: () => turnHandle, backgroundFlush: vi.fn(), shutdown: vi.fn() };
    const { sessionId } = await agent.newSession({ cwd: "/workspace" });
    const proc = (agent as any).sessions.get(sessionId).process;
    proc.sendPrompt = vi.fn().mockImplementation(async () => {
      return "cancelled";
    });

    const stopReason = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "cancel test" }] });

    expect(stopReason.stopReason).toBe("cancelled");
    expect(turnHandle.end).toHaveBeenCalledWith("ERROR", "", "cancelled", "Turn was cancelled");
  });

  it("guarantees fail-open behavior in initTelemetry when endpoint is missing", async () => {
    const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const originalGeneral = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    try {
      const tel = await initTelemetry();
      expect(tel).toBeNull();
    } finally {
      if (originalEndpoint) {
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalEndpoint;
      }
      if (originalGeneral) {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalGeneral;
      }
    }
  });
});
