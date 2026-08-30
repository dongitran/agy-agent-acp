import { describe, it, expect, vi } from "vitest";
import {
  client as acpClient,
  agent as acpAgent,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { AgyAcpAgent } from "../src/agy-agent.js";
import { PassThrough } from "node:stream";
import { nodeToWebReadable, nodeToWebWritable } from "../src/utils.js";

// Mock child_process for agy spawn
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

describe("ACP Protocol Wire Integration", () => {
  it("should handle full client-agent handshake and session lifecycle over ndJson stream", async () => {
    // Duplex pipe pair
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();

    const agentStream = ndJsonStream(
      nodeToWebWritable(agentToClient),
      nodeToWebReadable(clientToAgent)
    );

    const clientStream = ndJsonStream(
      nodeToWebWritable(clientToAgent),
      nodeToWebReadable(agentToClient)
    );

    let agyAgent: AgyAcpAgent | undefined = undefined;
    const agentConnection = acpAgent({ name: "agy-agent-acp" })
      .onRequest(methods.agent.initialize, (ctx) => agyAgent!.initialize(ctx.params))
      .onRequest(methods.agent.session.new, (ctx) => agyAgent!.newSession(ctx.params))
      .onRequest(methods.agent.session.prompt, (ctx) => agyAgent!.prompt(ctx.params))
      .onRequest(methods.agent.session.close, (ctx) => agyAgent!.closeSession(ctx.params))
      .onRequest(methods.agent.session.delete, (ctx) => agyAgent!.deleteSession(ctx.params))
      .onNotification(methods.agent.session.cancel, (ctx) => agyAgent!.cancel(ctx.params))
      .connect(agentStream);

    agyAgent = new AgyAcpAgent(agentConnection.client);

    const notifications: unknown[] = [];
    const clientConnection = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (ctx) => {
        notifications.push(ctx.params);
      })
      .connect(clientStream);

    // 1. Initialize
    const initRes = await clientConnection.agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test-runner", version: "1.0.0" },
      capabilities: {},
    });

    expect(initRes.protocolVersion).toBe(2);
    expect(initRes.info?.name ?? (initRes as any).agentInfo?.name).toBe("agy-agent-acp");

    // 2. New Session
    const newSessionRes = await clientConnection.agent.request(methods.agent.session.new, {
      cwd: "/test/path",
      mcpServers: [],
    });

    expect(newSessionRes.sessionId).toBeDefined();

    // 3. Cancel Notification
    await clientConnection.agent.notify(methods.agent.session.cancel, {
      sessionId: newSessionRes.sessionId,
    });

    // 4. Close Session
    const closeRes = await clientConnection.agent.request(methods.agent.session.close, {
      sessionId: newSessionRes.sessionId,
    });

    expect(closeRes).toEqual({});

    await agyAgent.dispose();
  });
});
