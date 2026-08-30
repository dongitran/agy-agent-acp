import {
  agent as acpAgent,
  AgentContext,
  InitializeRequest,
  InitializeResponse,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  StopReason,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { AgyProcess } from "./agy-process.js";
import { Logger, nodeToWebReadable, nodeToWebWritable } from "./utils.js";

interface SessionData {
  sessionId: string;
  cwd: string;
  process: AgyProcess;
  isFirstPrompt: boolean;
  systemPrompt?: string;
}

export class AgyAcpAgent {
  private client: AgentContext;
  private logger?: Logger;
  private sessions = new Map<string, SessionData>();

  constructor(client: AgentContext, logger?: Logger) {
    this.client = client;
    this.logger = logger;
  }

  public async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.logger?.log("[AgyAcpAgent] Initialize called with capabilities:", params.clientCapabilities);
    return {
      protocolVersion: 2,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: "agy-agent-acp",
        version: "0.1.0",
      },
    };
  }

  public async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
    const cwd = params.cwd || process.cwd();

    this.logger?.log(`[AgyAcpAgent] New session requested: id=${sessionId}, cwd=${cwd}`);

    let systemPrompt: string | undefined;
    const systemPromptFile = process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE;
    if (systemPromptFile && fs.existsSync(systemPromptFile)) {
      try {
        systemPrompt = fs.readFileSync(systemPromptFile, "utf8");
        this.logger?.log(`[AgyAcpAgent] Loaded system prompt from ${systemPromptFile} (${systemPrompt.length} chars)`);
      } catch (err) {
        this.logger?.error(`[AgyAcpAgent] Failed to read system prompt file ${systemPromptFile}:`, err);
      }
    }

    const agyProc = new AgyProcess(cwd, this.logger);
    this.sessions.set(sessionId, {
      sessionId,
      cwd,
      process: agyProc,
      isFirstPrompt: true,
      systemPrompt,
    });

    return {
      sessionId,
    };
  }

  public async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      this.logger?.error(`[AgyAcpAgent] Session not found: ${params.sessionId}`);
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const rawText = params.prompt
      .map((block) => {
        if (block.type === "text") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");

    let fullPrompt = rawText;
    if (session.isFirstPrompt && session.systemPrompt) {
      fullPrompt = `[SYSTEM INSTRUCTIONS]\n${session.systemPrompt}\n[END SYSTEM INSTRUCTIONS]\n\n${rawText}`;
      session.isFirstPrompt = false;
    }

    this.logger?.log(`[AgyAcpAgent] Sending prompt to agy (length: ${fullPrompt.length})`);

    const stopReasonStr = await session.process.sendPrompt(fullPrompt, {
      onTextDelta: async (text: string) => {
        await this.client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text,
            },
          } as any,
        });
      },
      onToolCall: async (toolName: string, toolParams: unknown) => {
        this.logger?.log(`[AgyAcpAgent] Tool call: ${toolName}`);
        await this.client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            title: toolName,
            kind: "tool",
            toolInput: toolParams,
          } as any,
        });
      },
      onUsage: async (usage) => {
        await this.client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "usage_update",
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              totalTokens: usage.total_tokens ?? 0,
            },
          } as any,
        });
      },
    });

    return {
      stopReason: (stopReasonStr as StopReason) || "end_turn",
    };
  }

  public cancel(params: { sessionId: string }): void {
    this.logger?.log(`[AgyAcpAgent] Cancel called for session ${params.sessionId}`);
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.process.cancel();
    }
  }

  public async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.logger?.log(`[AgyAcpAgent] Close session: ${params.sessionId}`);
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.process.dispose();
      this.sessions.delete(params.sessionId);
    }
    return {};
  }

  public async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    this.logger?.log(`[AgyAcpAgent] Delete session: ${params.sessionId}`);
    return this.closeSession(params);
  }

  public async dispose(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.process.dispose();
    }
    this.sessions.clear();
  }
}

export function runAcp(logger?: Logger) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);

  let agent: AgyAcpAgent;
  const connection = acpAgent({ name: "agy-agent-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(stream);

  agent = new AgyAcpAgent(connection.client, logger);

  return { connection, agent };
}
