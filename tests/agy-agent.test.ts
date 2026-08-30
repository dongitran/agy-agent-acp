import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgyAcpAgent } from "../src/agy-agent.js";
import { methods } from "@agentclientprotocol/sdk";
import * as fs from "node:fs";

// Mock child_process so AgyProcess won't try to spawn real binary
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn((_data, cb) => cb && cb(null)) },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
  })),
}));

// Mock fs for system prompt checks
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe("AgyAcpAgent Module", () => {
  let mockClient: { notify: ReturnType<typeof vi.fn> };
  let loggerMock: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      notify: vi.fn().mockResolvedValue(undefined),
    };
    loggerMock = {
      log: vi.fn(),
      error: vi.fn(),
    };
    delete process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE;
  });

  describe("initialize", () => {
    it("should return compliant ACP initialize response", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const res = await agent.initialize({
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      expect(res.protocolVersion).toBe(2);
      expect(res.agentInfo.name).toBe("agy-agent-acp");
      expect(res.agentCapabilities.loadSession).toBe(false);
    });
  });

  describe("newSession", () => {
    it("should create a new session with unique UUID and specified cwd", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const res = await agent.newSession({
        cwd: "/custom/project/dir",
      });

      expect(res.sessionId).toBeDefined();
      expect(typeof res.sessionId).toBe("string");
      expect(res.sessionId.length).toBeGreaterThan(10);
    });

    it("should load system prompt if BUZZ_ACP_SYSTEM_PROMPT_FILE is set and exists", async () => {
      process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE = "/path/to/prompt.md";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("You are an expert autonomous coder.");

      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const res = await agent.newSession({ cwd: "/workspace" });

      expect(fs.existsSync).toHaveBeenCalledWith("/path/to/prompt.md");
      expect(fs.readFileSync).toHaveBeenCalledWith("/path/to/prompt.md", "utf8");
      expect(res.sessionId).toBeDefined();
    });
  });

  describe("prompt", () => {
    it("should throw error if session does not exist", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      await expect(
        agent.prompt({
          sessionId: "non-existent-session",
          prompt: [{ type: "text", text: "Hello" }],
        })
      ).rejects.toThrow("Session non-existent-session not found");
    });

    it("should inject system prompt on first prompt turn only", async () => {
      process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE = "/path/to/prompt.md";
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("You are an expert autonomous coder.");

      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const { sessionId } = await agent.newSession({ cwd: "/workspace" });

      // Mock session's internal process sendPrompt
      const session = (agent as any).sessions.get(sessionId);
      let capturedPrompt1 = "";
      let capturedPrompt2 = "";

      session.process.sendPrompt = vi.fn().mockImplementation((prompt: string) => {
        if (!capturedPrompt1) {
          capturedPrompt1 = prompt;
        } else {
          capturedPrompt2 = prompt;
        }
        return Promise.resolve("end_turn");
      });

      // First turn
      await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Turn 1" }],
      });

      expect(capturedPrompt1).toContain("[SYSTEM INSTRUCTIONS]");
      expect(capturedPrompt1).toContain("You are an expert autonomous coder.");
      expect(capturedPrompt1).toContain("Turn 1");

      // Second turn
      await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Turn 2" }],
      });

      expect(capturedPrompt2).not.toContain("[SYSTEM INSTRUCTIONS]");
      expect(capturedPrompt2).toBe("Turn 2");
    });

    it("should emit ACP session/update notifications for text deltas, tools, and usage", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const { sessionId } = await agent.newSession({ cwd: "/workspace" });

      const session = (agent as any).sessions.get(sessionId);
      session.process.sendPrompt = vi.fn().mockImplementation(async (_prompt, callbacks) => {
        // Trigger callbacks
        if (callbacks.onTextDelta) {
          await callbacks.onTextDelta("Streaming response text");
        }
        if (callbacks.onToolCall) {
          await callbacks.onToolCall("grep_search", { Query: "foo" });
        }
        if (callbacks.onUsage) {
          await callbacks.onUsage({ input_tokens: 50, output_tokens: 10, total_tokens: 60 });
        }
        return "end_turn";
      });

      const response = await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Execute full cycle" }],
      });

      expect(response.stopReason).toBe("end_turn");

      // Verify ACP notifications
      expect(mockClient.notify).toHaveBeenCalledWith(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Streaming response text",
          },
        },
      });

      expect(mockClient.notify).toHaveBeenCalledWith(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          title: "grep_search",
          kind: "tool",
          toolInput: { Query: "foo" },
        },
      });

      expect(mockClient.notify).toHaveBeenCalledWith(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          usage: {
            inputTokens: 50,
            outputTokens: 10,
            totalTokens: 60,
          },
        },
      });
    });
  });

  describe("cancel, closeSession, deleteSession, and dispose", () => {
    it("should cancel active turn in session process", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const { sessionId } = await agent.newSession({ cwd: "/workspace" });

      const session = (agent as any).sessions.get(sessionId);
      const cancelSpy = vi.spyOn(session.process, "cancel");

      agent.cancel({ sessionId });
      expect(cancelSpy).toHaveBeenCalled();
    });

    it("should close and delete session resources", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const { sessionId } = await agent.newSession({ cwd: "/workspace" });

      const session = (agent as any).sessions.get(sessionId);
      const disposeSpy = vi.spyOn(session.process, "dispose");

      await agent.closeSession({ sessionId });
      expect(disposeSpy).toHaveBeenCalled();
      expect((agent as any).sessions.has(sessionId)).toBe(false);
    });

    it("should delete session via deleteSession", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const { sessionId } = await agent.newSession({ cwd: "/workspace" });

      await agent.deleteSession({ sessionId });
      expect((agent as any).sessions.has(sessionId)).toBe(false);
    });

    it("should dispose all sessions on agent.dispose()", async () => {
      const agent = new AgyAcpAgent(mockClient as any, loggerMock);
      const s1 = await agent.newSession({ cwd: "/workspace1" });
      const s2 = await agent.newSession({ cwd: "/workspace2" });

      const proc1 = (agent as any).sessions.get(s1.sessionId).process;
      const proc2 = (agent as any).sessions.get(s2.sessionId).process;

      const spy1 = vi.spyOn(proc1, "dispose");
      const spy2 = vi.spyOn(proc2, "dispose");

      await agent.dispose();

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
      expect((agent as any).sessions.size).toBe(0);
    });
  });
});
