import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { AgyProcess, TurnCallbacks } from "../src/agy-process.js";
import * as childProcess from "node:child_process";

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

describe("Concurrency, Fast-Tool & Sequential Queue Safeguards (F2, F2b, F4)", () => {
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

  it("preserves onToolResult when DONE and result arrive in the same stdout flush (F2b)", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const toolCallCalls: number[] = [];
    const toolResultCalls: number[] = [];

    const callbacks: TurnCallbacks = {
      onToolCall: async (ev) => {
        // Simulate asynchronous IPC delay
        await new Promise((r) => setTimeout(r, 10));
        toolCallCalls.push(ev.stepIndex);
      },
      onToolResult: async (ev) => {
        await new Promise((r) => setTimeout(r, 10));
        toolResultCalls.push(ev.stepIndex);
      },
    };

    const promptPromise = agy.sendPrompt("run test", callbacks);

    // Fast tool: emit DONE directly and result immediately after
    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "tool",
          tool_name: "run_command",
          state: "DONE",
          tool_info: { parameters: { cmd: "echo 1" }, output: "1" },
        },
      }) + "\n"
    );

    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done",
        },
      }) + "\n"
    );

    const stopReason = await promptPromise;
    await agy.drainQueue();

    expect(stopReason).toBe("end_turn");
    expect(toolCallCalls).toEqual([1]);
    expect(toolResultCalls).toEqual([1]);
  });

  it("deduplicates repeated DONE events for the same tool step (F2)", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    let toolCallCount = 0;
    let toolResultCount = 0;

    const callbacks: TurnCallbacks = {
      onToolCall: () => {
        toolCallCount++;
      },
      onToolResult: () => {
        toolResultCount++;
      },
    };

    const promptPromise = agy.sendPrompt("dedup test", callbacks);

    // First DONE
    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          tool_name: "read_file",
          state: "DONE",
          tool_info: { output: "content" },
        },
      }) + "\n"
    );

    // Repeated duplicate DONE
    mockChild.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          tool_name: "read_file",
          state: "DONE",
          tool_info: { output: "content" },
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
    await agy.drainQueue();

    expect(toolCallCount).toBe(1);
    expect(toolResultCount).toBe(1);
    expect(loggerMock.log).toHaveBeenCalledWith(expect.stringContaining("Ignoring repeated DONE for tool step 2"));
  });

  it("handles fast-path text streaming without waiting for queued operations", async () => {
    const agy = new AgyProcess("/test/workspace", loggerMock);
    const textChunks: string[] = [];

    const callbacks: TurnCallbacks = {
      onTextDelta: (chunk) => {
        textChunks.push(chunk);
      },
    };

    const promptPromise = agy.sendPrompt("stream test", callbacks);

    for (let i = 0; i < 5; i++) {
      mockChild.stdout.write(
        JSON.stringify({
          event: "step_update",
          step_update: {
            step_type: "agent_response",
            text_delta: `token_${i} `,
          },
        }) + "\n"
      );
    }

    mockChild.stdout.write(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS" },
      }) + "\n"
    );

    await promptPromise;
    await agy.drainQueue();

    expect(textChunks).toEqual(["token_0 ", "token_1 ", "token_2 ", "token_3 ", "token_4 "]);
  });
});
