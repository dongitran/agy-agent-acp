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
  RequestError,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { AgyProcess, AgyRunError, ToolCallEvent, ToolResultEvent } from "./agy-process.js";
import { getPackageVersion, Logger, nodeToWebReadable, nodeToWebWritable, sleep } from "./utils.js";
import { initTelemetry, TelemetryEngine } from "./telemetry.js";

interface SessionData {
  sessionId: string;
  cwd: string;
  process: AgyProcess;
  isFirstPrompt: boolean;
  systemPrompt?: string;
  /** Set by cancel(); a prompt waiting to retry a sign-in stops instead. */
  cancelRequested: boolean;
}

/** JSON-RPC code of a failed turn: an implementation-defined server error, which ACP clients pass on with its message. */
const AGY_FAILED_TURN_CODE = -32000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * How often a turn whose agy could not finish its sign-in is run again on a fresh agy, and the first wait before it
 * (doubled for each further retry). agy's own sign-in limit is a fixed 10 seconds; the refresh it was waiting for
 * often lands just after it, so a second agy a few seconds later usually starts at once. Retried only when agy reported
 * nothing for the turn, so nothing the agent did can run twice.
 */
export function signInRetryPolicy(): { retries: number; firstDelayMs: number } {
  return {
    retries: envInt("AGY_ACP_SIGNIN_RETRIES", 2, 0, 5),
    firstDelayMs: envInt("AGY_ACP_SIGNIN_RETRY_DELAY_MS", 2000, 0, 30000),
  };
}

export class AgyAcpAgent {
  private client: AgentContext;
  private logger?: Logger;
  private sessions = new Map<string, SessionData>();
  private telemetry?: TelemetryEngine;
  private telemetryInitPromise?: Promise<TelemetryEngine | undefined>;

  constructor(client: AgentContext, logger?: Logger) {
    this.client = client;
    this.logger = logger;
  }

  private async getTelemetry(): Promise<TelemetryEngine | undefined> {
    if (this.telemetry) {return this.telemetry;}
    if (!this.telemetryInitPromise) {
      this.telemetryInitPromise = initTelemetry(this.logger).then((tel) => {
        this.telemetry = tel ?? undefined;
        return this.telemetry;
      });
    }
    return this.telemetryInitPromise;
  }

  public async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.logger?.log("[AgyAcpAgent] Initialize called with params:", params);
    this.telemetry = await this.getTelemetry();
    const version = getPackageVersion();
    return {
      protocolVersion: 2,
      capabilities: {
        loadSession: false,
      },
      info: {
        name: "agy-agent-acp",
        version,
      },
      // Backward-compatible fields
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: "agy-agent-acp",
        version,
      },
    } as unknown as InitializeResponse;
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

    // ACP protocol & buzz-acp system prompt support:
    // Extract incoming system prompt from top-level params.systemPrompt or _meta.systemPrompt
    const pAny = params as unknown as Record<string, unknown>;
    const metaObj = pAny._meta as Record<string, unknown> | undefined;
    const metaSystemPrompt = metaObj?.systemPrompt;
    const incomingPrompt =
      (typeof pAny.systemPrompt === "string" && pAny.systemPrompt) ||
      (typeof metaSystemPrompt === "string" && metaSystemPrompt) ||
      (typeof (metaSystemPrompt as Record<string, unknown>)?.append === "string" &&
        (metaSystemPrompt as Record<string, unknown>).append as string) ||
      undefined;

    if (incomingPrompt) {
      this.logger?.log(`[AgyAcpAgent] Loaded system prompt from ACP params (${incomingPrompt.length} chars)`);
      if (!systemPrompt) {
        systemPrompt = incomingPrompt;
      } else if (!incomingPrompt.includes(systemPrompt)) {
        systemPrompt = `${systemPrompt}\n\n${incomingPrompt}`;
      } else {
        systemPrompt = incomingPrompt;
      }
    }

    const sessionData: SessionData = {
      sessionId,
      cwd,
      process: agyProc,
      isFirstPrompt: true,
      systemPrompt,
      cancelRequested: false,
    };

    agyProc.onExit = () => {
      sessionData.isFirstPrompt = true;
    };

    this.sessions.set(sessionId, sessionData);

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
        if (block.type === "text") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    session.cancelRequested = false;
    const { retries, firstDelayMs } = signInRetryPolicy();
    for (let attempt = 0; ; attempt++) {
      try {
        const stopReasonStr = await this.runTurn(session, params.sessionId, rawText);
        return {
          stopReason: (stopReasonStr as StopReason) || "end_turn",
        };
      } catch (err) {
        const retryable = err instanceof AgyRunError && err.kind === "sign-in" && err.beforeOutput;
        if (retryable && attempt < retries && !session.cancelRequested) {
          const delayMs = firstDelayMs * 2 ** attempt;
          this.logger?.error(
            `[AgyAcpAgent] agy could not sign in (${err.message}); retry ${attempt + 1} of ${retries} on a fresh agy in ${delayMs} ms`
          );
          session.process.endProcess("its sign-in did not finish");
          await sleep(delayMs);
          if (!session.cancelRequested) {
            continue;
          }
        }
        if (session.cancelRequested) {
          return { stopReason: "cancelled" };
        }
        // A plain Error would reach the client as "Internal error"; this keeps agy's reason, so buzz-acp can retry the
        // turn with backoff and, when its retries are spent, tell the thread why.
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[AgyAcpAgent] Turn failed: ${message}`);
        throw new RequestError(AGY_FAILED_TURN_CODE, `agy: ${message}`);
      }
    }
  }

  /** One run of a prompt on the session's agy; the system prompt goes first whenever that agy is new. */
  private async runTurn(session: SessionData, sessionId: string, rawText: string): Promise<string> {
    let fullPrompt = rawText;
    if (session.isFirstPrompt && session.systemPrompt) {
      fullPrompt = `[SYSTEM INSTRUCTIONS]\n${session.systemPrompt}\n[END SYSTEM INSTRUCTIONS]\n\n${rawText}`;
      session.isFirstPrompt = false;
    }

    this.logger?.log(`[AgyAcpAgent] Sending prompt to agy (length: ${fullPrompt.length})`);

    const telemetry = await this.getTelemetry();
    const turnHandle = telemetry?.startTurnSpan(sessionId, fullPrompt, process.env.AGY_MODEL);
    let assistantResponseText = "";

    const params = { sessionId };
    try {
      const stopReason = await session.process.sendPrompt(fullPrompt, {
        onTextDelta: async (text: string): Promise<void> => {
          assistantResponseText += text;
          await this.client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text,
              },
            },
          } as unknown as Parameters<AgentContext["notify"]>[1]);
        },
        onToolCall: async (first: ToolCallEvent | string, second?: unknown): Promise<void> => {
          const isObj = typeof first === "object" && first !== null;
          const toolName = isObj ? (first as ToolCallEvent).toolName : (first as string);
          const toolParams = isObj ? (first as ToolCallEvent).parameters : (second as Record<string, unknown> | undefined);
          const stepIndex = isObj ? (first as ToolCallEvent).stepIndex : 0;

          this.logger?.log(`[AgyAcpAgent] Tool call: ${toolName}`);
          turnHandle?.startToolSpan(stepIndex, toolName, toolParams);
          await this.client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              title: toolName,
              kind: "tool",
              toolInput: toolParams,
            },
          } as unknown as Parameters<AgentContext["notify"]>[1]);
        },
        onToolResult: async (event: ToolResultEvent): Promise<void> => {
          this.logger?.log(`[AgyAcpAgent] Tool result: ${event.toolName} (step ${event.stepIndex})`);
          turnHandle?.endToolSpan(event.stepIndex, event.toolName, event.output, event.error);
        },
        onUsage: async (usage): Promise<void> => {
          turnHandle?.recordUsage(usage);
          await this.client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "usage_update",
              usage: {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                totalTokens: usage.total_tokens ?? 0,
              },
            },
          } as unknown as Parameters<AgentContext["notify"]>[1]);
        },
      });

      turnHandle?.end("OK", assistantResponseText);
      telemetry?.backgroundFlush(1000);
      return stopReason;
    } catch (err: unknown) {
      const failureKind = err instanceof AgyRunError ? err.kind : "error";
      const failureMessage = err instanceof Error ? err.message : String(err);
      turnHandle?.end("ERROR", undefined, failureKind, failureMessage);
      telemetry?.backgroundFlush(1000);
      throw err;
    }
  }

  public cancel(params: { sessionId: string }): void {
    this.logger?.log(`[AgyAcpAgent] Cancel called for session ${params.sessionId}`);
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.cancelRequested = true;
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
    await this.telemetry?.shutdown();
  }
}

export function runAcp(logger?: Logger): {
  connection: ReturnType<ReturnType<typeof acpAgent>["connect"]>;
  agent: AgyAcpAgent;
} {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);

  let agentInstance: AgyAcpAgent | undefined = undefined;
  const connection = acpAgent({ name: "agy-agent-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agentInstance!.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agentInstance!.newSession(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => agentInstance!.prompt(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agentInstance!.closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => agentInstance!.deleteSession(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => agentInstance!.cancel(ctx.params))
    .connect(stream);

  agentInstance = new AgyAcpAgent(connection.client, logger);

  return { connection, agent: agentInstance };
}
