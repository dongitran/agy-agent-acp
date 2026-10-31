import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgyProcess } from "../src/agy-process.js";
import { AgyAcpAgent } from "../src/agy-agent.js";
import type { AgentContext } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

describe("AgyProcess Stateful Tool Tracking", () => {
  it("dispatches onToolCall on ACTIVE state and onToolResult on DONE state", async () => {
    const proc = new AgyProcess();
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    (proc as any).currentTurnCallbacks = {
      onToolCall,
      onToolResult
    };

    // 1. Tool starts: state = ACTIVE
    const lineActive = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          parameters: { CommandLine: "echo 42" }
        }
      }
    });
    await (proc as any).handleLine(lineActive);

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      stepIndex: 2,
      toolName: "run_command",
      parameters: { CommandLine: "echo 42" }
    });
    expect(onToolResult).not.toHaveBeenCalled();

    // 2. Tool completes: state = DONE
    const lineDone = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        duration_seconds: 0.05,
        tool_info: {
          parameters: { CommandLine: "echo 42" },
          output: "42\n"
        }
      }
    });
    await (proc as any).handleLine(lineDone);

    // onToolCall should NOT be called again (no duplicate tool span)
    expect(onToolCall).toHaveBeenCalledTimes(1);

    // onToolResult must be called with output and stepIndex
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      stepIndex: 2,
      toolName: "run_command",
      durationSeconds: 0.05,
      output: "42\n",
      error: undefined
    });
  });
});

describe("AgyAcpAgent Dynamic Versioning", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports package.json version in initialize handshake rather than hardcoded 0.1.4", async () => {
    const mockContext = { notify: vi.fn() } as unknown as AgentContext;
    const agent = new AgyAcpAgent(mockContext);

    const initRes = await agent.initialize({ protocolVersion: 2 });
    expect(initRes.agentInfo?.version).toBe(pkg.version);
    expect(initRes.info?.version).toBe(pkg.version);
  });
});

describe("AgyAcpAgent Telemetry Lifecycle", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("hooks turn lifecycle into telemetry engine and triggers background flush", async () => {
    const mockContext = { notify: vi.fn() } as unknown as AgentContext;
    const agent = new AgyAcpAgent(mockContext);

    const mockTurnHandle = {
      startToolSpan: vi.fn(),
      endToolSpan: vi.fn(),
      recordUsage: vi.fn(),
      end: vi.fn(),
    };
    const mockTelemetry = {
      startTurnSpan: vi.fn().mockReturnValue(mockTurnHandle),
      backgroundFlush: vi.fn().mockReturnValue(Promise.resolve()),
      shutdown: vi.fn().mockReturnValue(Promise.resolve()),
    };

    (agent as any).telemetry = mockTelemetry;

    const { sessionId } = await agent.newSession({ cwd: "/workspace" });
    const session = (agent as any).sessions.get(sessionId);

    session.process.sendPrompt = vi.fn().mockImplementation(async (_prompt, callbacks) => {
      await callbacks.onToolCall({
        stepIndex: 1,
        toolName: "run_command",
        parameters: { CommandLine: "ls" },
      });
      await callbacks.onToolResult({
        stepIndex: 1,
        toolName: "run_command",
        output: "file.txt\n",
      });
      await callbacks.onUsage({ input_tokens: 10, output_tokens: 5 });
      await callbacks.onTextDelta("All done!");
      return "end_turn";
    });

    const res = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "List files" }],
    });

    expect(res.stopReason).toBe("end_turn");
    expect(mockTelemetry.startTurnSpan).toHaveBeenCalledWith(sessionId, "List files", undefined);
    expect(mockTurnHandle.startToolSpan).toHaveBeenCalledWith(1, "run_command", { CommandLine: "ls" });
    expect(mockTurnHandle.endToolSpan).toHaveBeenCalledWith(1, "run_command", "file.txt\n", undefined);
    expect(mockTurnHandle.recordUsage).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 5 });
    expect(mockTurnHandle.end).toHaveBeenCalledWith("OK", "All done!");
    expect(mockTelemetry.backgroundFlush).toHaveBeenCalledWith(1000);
  });
});
