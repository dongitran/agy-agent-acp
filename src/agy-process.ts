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

    this.rl.on("line", (line: string) => {
      this.handleLine(line);
    });

    this.child.on("error", (err: Error) => {
      this.logger?.error("[AgyProcess] Child process error:", err);
      if (this.currentTurnReject) {
        this.currentTurnReject(err);
        this.currentTurnReject = null;
        this.currentTurnResolve = null;
      }
    });

    this.child.on("exit", (code: number | null, signal: string | null) => {
      this.logger?.log(`[AgyProcess] Child exited with code ${code}, signal ${signal}`);
      if (this.currentTurnResolve && !this.isKilled) {
        this.currentTurnResolve("end_turn");
        this.currentTurnResolve = null;
        this.currentTurnReject = null;
      }
      this.child = null;
      this.rl = null;
    });
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

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
      if (step.step_type === "agent_response" && step.text_delta) {
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

      if (res.usage && this.currentTurnCallbacks?.onUsage) {
        await this.currentTurnCallbacks.onUsage(res.usage);
      }

      if (this.currentTurnResolve) {
        const stopReason = res.status === "SUCCESS" ? "end_turn" : "end_turn";
        this.currentTurnResolve(stopReason);
        this.currentTurnResolve = null;
        this.currentTurnReject = null;
        this.currentTurnCallbacks = null;
      }
    }
  }

  public async sendPrompt(prompt: string, callbacks: TurnCallbacks): Promise<string> {
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
    if (this.child && !this.child.killed) {
      this.logger?.log("[AgyProcess] Cancelling active turn via SIGINT");
      this.child.kill("SIGINT");
    }
    if (this.currentTurnResolve) {
      this.currentTurnResolve("cancelled");
      this.currentTurnResolve = null;
      this.currentTurnReject = null;
      this.currentTurnCallbacks = null;
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
