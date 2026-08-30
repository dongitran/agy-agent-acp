import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { AgyProcess, TurnCallbacks, AgyUsage } from "../src/agy-process.js";
import * as childProcess from "node:child_process";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

class MockChildProcess extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public killed = false;
  public pid = 12345;

  public kill(signal?: string): boolean {
    this.killed = true;
    this.emit("exit", 0, signal || "SIGTERM");
    return true;
  }
}

describe("AgyProcess Module", () => {
  let mockChild: MockChildProcess;
  let loggerMock: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = new MockChildProcess();
    vi.mocked(childProcess.spawn).mockReturnValue(mockChild as any);
    loggerMock = {
      log: vi.fn(),
      error: vi.fn(),
    };
  });

  it("should spawn agy process with stream-json arguments and skip permissions", () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    agy.start();

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "agy",
      [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ],
      expect.objectContaining({
        cwd: "/test/workspace",
        stdio: ["pipe", "pipe", "inherit"],
      })
    );
  });

  it("should not spawn a second process if already running", () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    agy.start();
    agy.start();

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  it("should send prompt formatted as JSON to child process stdin", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const callbacks: TurnCallbacks = {};

    let writtenData = "";
    mockChild.stdin.on("data", (chunk: Buffer) => {
      writtenData += chunk.toString("utf-8");
    });

    const promptPromise = agy.sendPrompt("Hello Antigravity", callbacks);

    expect(JSON.parse(writtenData.trim())).toEqual({
      event: "user",
      message: {
        content: "Hello Antigravity",
      },
    });

    // Simulate completion
    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS" },
      }) + "\n"
    );

    const stopReason = await promptPromise;
    expect(stopReason).toBe("end_turn");
  });

  it("should parse text deltas and invoke onTextDelta callback", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const deltas: string[] = [];

    const callbacks: TurnCallbacks = {
      onTextDelta: (text) => {
        deltas.push(text);
      },
    };

    const promptPromise = agy.sendPrompt("Generate text", callbacks);

    // Stream step updates
    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          text_delta: "Chunk 1",
        },
      }) + "\n"
    );

    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          text_delta: " Chunk 2",
        },
      }) + "\n"
    );

    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS" },
      }) + "\n"
    );

    await promptPromise;
    expect(deltas).toEqual(["Chunk 1", " Chunk 2"]);
  });

  it("should parse tool calls and invoke onToolCall callback", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const toolCalls: Array<{ name: string; params: unknown }> = [];

    const callbacks: TurnCallbacks = {
      onToolCall: (toolName, params) => {
        toolCalls.push({ name: toolName, params });
      },
    };

    const promptPromise = agy.sendPrompt("Execute tool", callbacks);

    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          tool_name: "view_file",
          tool_info: {
            parameters: { AbsolutePath: "/foo/bar.ts" },
          },
        },
      }) + "\n"
    );

    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS" },
      }) + "\n"
    );

    await promptPromise;
    expect(toolCalls).toEqual([
      {
        name: "view_file",
        params: { AbsolutePath: "/foo/bar.ts" },
      },
    ]);
  });

  it("should parse usage metrics from step_update and result events", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const usageReports: AgyUsage[] = [];

    const callbacks: TurnCallbacks = {
      onUsage: (usage) => {
        usageReports.push(usage);
      },
    };

    const promptPromise = agy.sendPrompt("Check usage", callbacks);

    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      }) + "\n"
    );

    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        },
      }) + "\n"
    );

    await promptPromise;
    expect(usageReports).toHaveLength(2);
    expect(usageReports[0]).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(usageReports[1]).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it("should gracefully ignore malformed non-JSON lines and empty lines", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const promptPromise = agy.sendPrompt("Test malformed", {});

    mockChild.stdout.write("   \n");
    mockChild.stdout.write("MALFORMED_NON_JSON_LINE\n");
    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS" },
      }) + "\n"
    );

    const stopReason = await promptPromise;
    expect(stopReason).toBe("end_turn");
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse JSON line from agy:"),
      "MALFORMED_NON_JSON_LINE"
    );
  });

  it("should handle cancel() by sending SIGINT and resolving with cancelled", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const killSpy = vi.spyOn(mockChild, "kill");

    const promptPromise = agy.sendPrompt("Long task", {});
    agy.cancel();

    expect(killSpy).toHaveBeenCalledWith("SIGINT");
    const stopReason = await promptPromise;
    expect(stopReason).toBe("cancelled");
  });

  it("should handle dispose() by setting isKilled and sending SIGTERM", () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    agy.start();

    const killSpy = vi.spyOn(mockChild, "kill");
    agy.dispose();

    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
  });

  it("should reject sendPrompt if child process emits error", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const promptPromise = agy.sendPrompt("Task failing", {});

    mockChild.emit("error", new Error("Spawn failure"));

    await expect(promptPromise).rejects.toThrow("Spawn failure");
  });
});
