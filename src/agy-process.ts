import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { Logger } from "./utils.js";

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyEvent {
  event: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    duration_seconds?: number;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, unknown>;
      output?: string;
      error?: {
        type?: string;
        message?: string;
      };
    };
    usage?: AgyUsage;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AgyUsage;
  };
}

export interface TurnCallbacks {
  onTextDelta?: (text: string) => Promise<void> | void;
  onToolCall?: (toolName: string, params: unknown) => Promise<void> | void;
  onUsage?: (usage: AgyUsage) => Promise<void> | void;
}

/** How an agy run failed: a sign-in that did not finish, an ERROR result, or an agy that died before it answered. */
export type AgyFailureKind = "sign-in" | "error-result" | "exited";

/**
 * A turn that agy could not run. `beforeOutput` is true when agy reported nothing for the turn (no step, no text, no
 * tool call), so running the same prompt again cannot repeat anything the agent already did.
 */
export class AgyRunError extends Error {
  public readonly kind: AgyFailureKind;
  public readonly beforeOutput: boolean;

  constructor(message: string, kind: AgyFailureKind, beforeOutput: boolean) {
    super(message);
    this.name = "AgyRunError";
    this.kind = kind;
    this.beforeOutput = beforeOutput;
  }
}

/**
 * agy (1.3.1 through 1.4.8) gives its silent sign-in a fixed 10 seconds, with no flag, variable or setting to change
 * it. When the stored access token has expired, that window holds a token refresh and a user-info call; on a slow
 * network they can take longer, and agy ends the run with this error although the stored login is still valid.
 */
const SIGN_IN_ERROR = /authentication (failed|required)|not logged in|silent auth failed/i;

export function isSignInError(message: string | undefined): boolean {
  return typeof message === "string" && SIGN_IN_ERROR.test(message);
}

export class AgyProcess {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private cwd: string;
  private logger?: Logger;
  private conversationId?: string;
  private currentTurnResolve: ((stopReason: string) => void) | null = null;
  private currentTurnReject: ((err: Error) => void) | null = null;
  private currentTurnCallbacks: TurnCallbacks | null = null;
  private isKilled = false;
  private hasEmittedTextThisTurn = false;
  /** agy reported a step (text, tool call or other) for the current turn. */
  private hasOutputThisTurn = false;
  public onExit?: () => void;

  constructor(cwd: string, logger?: Logger) {
    this.cwd = cwd;
    this.logger = logger;
  }

  public start(): void {
    if (this.child && !this.child.killed) {
      return;
    }

    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];

    this.logger?.log(`[AgyProcess] Spawning agy in ${this.cwd} with args: ${args.join(" ")}`);

    this.child = spawn("agy", args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error("Failed to create pipes for agy process");
    }

    this.rl = readline.createInterface({
      input: this.child.stdout,
      terminal: false,
    });

    // An agy's listeners act only while it is this session's agy: once endProcess() has let it go (a restart, or the
    // end of a turn), its late output or exit must not touch the next agy's turn.
    const child = this.child;

    this.rl.on("line", (line: string) => {
      if (this.child !== child) {
        return;
      }
      this.handleLine(line);
    });

    this.child.on("error", (err: Error) => {
      if (this.child !== child) {
        return;
      }
      this.logger?.error("[AgyProcess] Child process error:", err);
      if (this.currentTurnReject) {
        this.currentTurnReject(err);
        this.currentTurnReject = null;
        this.currentTurnResolve = null;
      }
    });

    this.child.on("exit", (code: number | null, signal: string | null) => {
      if (this.child !== child) {
        return;
      }
      this.logger?.log(`[AgyProcess] Child exited with code ${code}, signal ${signal}`);
      if (this.currentTurnReject && !this.isKilled && signal !== "SIGINT" && code !== 0) {
        // agy died with the turn still open: fail the turn rather than end it as if agy had answered
        const reject = this.currentTurnReject;
        this.currentTurnResolve = null;
        this.currentTurnReject = null;
        this.currentTurnCallbacks = null;
        reject(new AgyRunError(`agy exited with code ${code}, signal ${signal} before it answered`, "exited",
          !this.hasOutputThisTurn));
      } else if (this.currentTurnResolve && !this.isKilled) {
        const stopReason = signal === "SIGINT" ? "cancelled" : "end_turn";
        this.currentTurnResolve(stopReason);
        this.currentTurnResolve = null;
        this.currentTurnReject = null;
      }
      this.child = null;
      this.rl = null;
      this.onExit?.();
    });
  }

  /**
   * Lets the current agy go at once and stops it: the next prompt starts a fresh agy, and onExit tells the session to
   * send the system prompt again. Its listeners stop acting the moment it is let go.
   */
  public endProcess(reason: string): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    this.rl = null;
    this.onExit?.();
    this.logger?.log(`[AgyProcess] Ending agy: ${reason}`);
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event: AgyEvent;
    try {
      event = JSON.parse(trimmed) as AgyEvent;
    } catch {
      this.logger?.error("[AgyProcess] Failed to parse JSON line from agy:", trimmed);
      return;
    }

    if (event.event === "init") {
      this.conversationId = event.conversation_id;
      this.logger?.log(`[AgyProcess] Init event: conversation_id=${this.conversationId}`);
    } else if (event.event === "step_update" && event.step_update) {
      const step = event.step_update;
      this.hasOutputThisTurn = true;
      if (step.step_type === "agent_response" && step.text_delta) {
        this.hasEmittedTextThisTurn = true;
        if (this.currentTurnCallbacks?.onTextDelta) {
          await this.currentTurnCallbacks.onTextDelta(step.text_delta);
        }
      } else if (step.step_type === "tool" && step.tool_name) {
        if (this.currentTurnCallbacks?.onToolCall) {
          await this.currentTurnCallbacks.onToolCall(step.tool_name, step.tool_info?.parameters);
        }
      }

      if (step.usage && this.currentTurnCallbacks?.onUsage) {
        await this.currentTurnCallbacks.onUsage(step.usage);
      }
    } else if (event.event === "result" && event.result) {
      const res = event.result;
      this.logger?.log(`[AgyProcess] Result event: status=${res.status}`);
      if (res.error) {
        this.logger?.error(`[AgyProcess] Result error: ${res.error}`);
      }

      if (res.status === "ERROR" && this.currentTurnReject) {
        // agy could not run the turn (a sign-in that did not finish, a 401 or 503 from the model API, …): fail it with
        // agy's own message, so the ACP client can retry it or say so, instead of ending it as if agy had answered
        const reject = this.currentTurnReject;
        this.currentTurnResolve = null;
        this.currentTurnReject = null;
        this.currentTurnCallbacks = null;
        const message = String(res.error || "agy ended the run with an error").slice(0, 500);
        reject(new AgyRunError(message, isSignInError(res.error) ? "sign-in" : "error-result", !this.hasOutputThisTurn));
      } else {
        // If text was not streamed via text_delta but arrived in res.response, deliver it
        if (!this.hasEmittedTextThisTurn && res.response && this.currentTurnCallbacks?.onTextDelta) {
          this.logger?.log(`[AgyProcess] Emitting response from result event (${res.response.length} chars)`);
          await this.currentTurnCallbacks.onTextDelta(res.response);
        }

        if (res.usage && this.currentTurnCallbacks?.onUsage) {
          await this.currentTurnCallbacks.onUsage(res.usage);
        }

        if (this.currentTurnResolve) {
          const stopReason = res.status === "CANCELLED" ? "cancelled" : "end_turn";
          this.currentTurnResolve(stopReason);
          this.currentTurnResolve = null;
          this.currentTurnReject = null;
          this.currentTurnCallbacks = null;
        }
      }

      // AGY_ACP_EXIT_AFTER_TURN=1: one agy per turn. An ACP client may keep every session for good, and each idle agy
      // holds 75-100 MB; the next prompt starts a fresh agy, which gets the system prompt again.
      if (process.env.AGY_ACP_EXIT_AFTER_TURN === "1") {
        this.endProcess("turn over (AGY_ACP_EXIT_AFTER_TURN)");
      }
    }
  }

  public async sendPrompt(prompt: string, callbacks: TurnCallbacks): Promise<string> {
    this.hasEmittedTextThisTurn = false;
    this.hasOutputThisTurn = false;
    this.start();

    if (!this.child || !this.child.stdin) {
      throw new Error("Agy process is not running");
    }

    this.currentTurnCallbacks = callbacks;

    const payload = JSON.stringify({
      event: "user",
      message: {
        content: prompt,
      },
    }) + "\n";

    return new Promise<string>((resolve, reject) => {
      this.currentTurnResolve = resolve;
      this.currentTurnReject = reject;

      this.child!.stdin!.write(payload, (err) => {
        if (err) {
          this.logger?.error("[AgyProcess] Failed to write prompt to agy stdin:", err);
          reject(err);
        }
      });
    });
  }

  public cancel(): void {
    const resolve = this.currentTurnResolve;
    this.currentTurnResolve = null;
    this.currentTurnReject = null;
    this.currentTurnCallbacks = null;

    if (this.child && !this.child.killed) {
      this.logger?.log("[AgyProcess] Cancelling active turn via SIGINT");
      this.child.kill("SIGINT");
    }

    if (resolve) {
      resolve("cancelled");
    }
  }

  public dispose(): void {
    this.isKilled = true;
    if (this.child && !this.child.killed) {
      this.logger?.log("[AgyProcess] Disposing agy process");
      this.child.kill("SIGTERM");
    }
  }
}
