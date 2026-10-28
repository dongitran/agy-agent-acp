import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { RequestError } from "@agentclientprotocol/sdk";
import { AgyProcess, AgyRunError, isSignInError } from "../src/agy-process.js";
import { AgyAcpAgent, signInRetryPolicy } from "../src/agy-agent.js";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

/** A child whose exit comes only when the test says so (agy exits on its own a moment after its result). */
class MockChild extends EventEmitter {
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public killed = false;
  public kill(): boolean {
    this.killed = true;
    return true;
  }
}

const SIGN_IN_FAILURE = "authentication failed or timed out";
const line = (event: unknown): string => JSON.stringify(event) + "\n";
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const logger = { log: vi.fn(), error: vi.fn() };

describe("isSignInError", () => {
  it("matches agy's sign-in failures and nothing else", () => {
    expect(isSignInError("authentication failed or timed out")).toBe(true);
    expect(isSignInError("Error: authentication required. Run 'agy-real' to log in, then retry.")).toBe(true);
    expect(isSignInError("Print mode: silent auth failed")).toBe(true);
    expect(isSignInError("503 No capacity available for model")).toBe(false);
    expect(isSignInError("401 Unauthorized")).toBe(false);
    expect(isSignInError(undefined)).toBe(false);
  });
});

describe("AgyProcess: a run agy could not finish fails the turn", () => {
  let children: MockChild[];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGY_ACP_EXIT_AFTER_TURN;
    children = [];
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new MockChild();
      children.push(child);
      return child as never;
    });
  });

  afterEach(() => {
    delete process.env.AGY_ACP_EXIT_AFTER_TURN;
  });

  it("an ERROR result with a sign-in failure before any step rejects as a retryable sign-in", async () => {
    const agy = new AgyProcess("/w", logger);
    const turn = agy.sendPrompt("hello", {});
    children[0].stdout.write(line({ event: "result", result: { status: "ERROR", error: SIGN_IN_FAILURE } }));

    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgyRunError);
    expect(err).toMatchObject({ kind: "sign-in", beforeOutput: true, message: SIGN_IN_FAILURE });
  });

  it("an ERROR result after a step is an error-result with output", async () => {
    const agy = new AgyProcess("/w", logger);
    const turn = agy.sendPrompt("hello", {});
    children[0].stdout.write(line({ event: "step_update", step_update: { step_type: "tool", tool_name: "run_command" } }));
    children[0].stdout.write(line({ event: "result", result: { status: "ERROR", error: "503 No capacity" } }));

    await expect(turn).rejects.toMatchObject({ kind: "error-result", beforeOutput: false, message: "503 No capacity" });
  });

  it("an agy that exits non-zero with the turn open rejects as exited; a clean exit still ends the turn", async () => {
    const agy = new AgyProcess("/w", logger);
    const failed = agy.sendPrompt("one", {});
    children[0].emit("exit", 1, null);
    await expect(failed).rejects.toMatchObject({ kind: "exited", beforeOutput: true });

    const ended = agy.sendPrompt("two", {});
    children[1].emit("exit", 0, null);
    await expect(ended).resolves.toBe("end_turn");
  });

  it("a SUCCESS result still resolves end_turn, and the exit that follows an ERROR result changes nothing", async () => {
    const agy = new AgyProcess("/w", logger);
    const failed = agy.sendPrompt("one", {});
    children[0].stdout.write(line({ event: "result", result: { status: "ERROR", error: SIGN_IN_FAILURE } }));
    await expect(failed).rejects.toBeInstanceOf(AgyRunError);
    children[0].emit("exit", 1, null);

    const ok = agy.sendPrompt("two", {});
    children[1].stdout.write(line({ event: "result", result: { status: "SUCCESS" } }));
    await expect(ok).resolves.toBe("end_turn");
  });

  it("endProcess lets the agy go at once: its late output and exit cannot touch the next agy's turn", async () => {
    const agy = new AgyProcess("/w", logger);
    const onExit = vi.fn();
    agy.onExit = onExit;
    agy.start();
    agy.endProcess("test");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(children[0].killed).toBe(true);

    const turn = agy.sendPrompt("next", {});
    expect(children).toHaveLength(2);
    children[0].stdout.write(line({ event: "result", result: { status: "ERROR", error: "late" } }));
    children[0].emit("exit", 1, null);
    await tick();
    expect(onExit).toHaveBeenCalledTimes(1);

    children[1].stdout.write(line({ event: "result", result: { status: "SUCCESS" } }));
    await expect(turn).resolves.toBe("end_turn");
  });

  it("AGY_ACP_EXIT_AFTER_TURN=1 ends the agy after each result; the next prompt starts a fresh one", async () => {
    process.env.AGY_ACP_EXIT_AFTER_TURN = "1";
    const agy = new AgyProcess("/w", logger);
    const onExit = vi.fn();
    agy.onExit = onExit;

    const one = agy.sendPrompt("one", {});
    children[0].stdout.write(line({ event: "result", result: { status: "SUCCESS" } }));
    await expect(one).resolves.toBe("end_turn");
    await tick();
    expect(children[0].killed).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);

    const two = agy.sendPrompt("two", {});
    expect(children).toHaveLength(2);
    children[1].stdout.write(line({ event: "result", result: { status: "SUCCESS" } }));
    await expect(two).resolves.toBe("end_turn");
  });

  it("without AGY_ACP_EXIT_AFTER_TURN the agy stays up between turns", async () => {
    const agy = new AgyProcess("/w", logger);
    const one = agy.sendPrompt("one", {});
    children[0].stdout.write(line({ event: "result", result: { status: "SUCCESS" } }));
    await one;
    const two = agy.sendPrompt("two", {});
    children[0].stdout.write(line({ event: "result", result: { status: "SUCCESS" } }));
    await two;
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
  });
});

describe("AgyAcpAgent: a sign-in that did not finish is run again on a fresh agy", () => {
  const client = { notify: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGY_ACP_SIGNIN_RETRY_DELAY_MS = "0";
    delete process.env.AGY_ACP_SIGNIN_RETRIES;
    process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE = "/prompt.md";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("SYSTEM");
  });

  afterEach(() => {
    delete process.env.AGY_ACP_SIGNIN_RETRY_DELAY_MS;
    delete process.env.AGY_ACP_SIGNIN_RETRIES;
    delete process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE;
  });

  /** A session whose agy answers each run with the next outcome; endProcess behaves like the real one (onExit). */
  async function sessionWith(outcomes: Array<string | Error>) {
    const agent = new AgyAcpAgent(client as never, logger);
    const { sessionId } = await agent.newSession({ cwd: "/w" } as never);
    const session = (agent as unknown as { sessions: Map<string, any> }).sessions.get(sessionId);
    const prompts: string[] = [];
    session.process.sendPrompt = vi.fn((prompt: string) => {
      prompts.push(prompt);
      const next = outcomes.shift() ?? "end_turn";
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    session.process.endProcess = vi.fn(() => session.process.onExit?.());
    return { agent, sessionId, session, prompts };
  }

  const ask = (agent: AgyAcpAgent, sessionId: string) =>
    agent.prompt({ sessionId, prompt: [{ type: "text", text: "health check" }] } as never);

  it("retries a sign-in failure and sends the system prompt again to the fresh agy", async () => {
    const { agent, sessionId, session, prompts } = await sessionWith([
      new AgyRunError(SIGN_IN_FAILURE, "sign-in", true),
      "end_turn",
    ]);

    await expect(ask(agent, sessionId)).resolves.toEqual({ stopReason: "end_turn" });
    expect(prompts).toHaveLength(2);
    expect(session.process.endProcess).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain("[SYSTEM INSTRUCTIONS]");
    expect(prompts[1]).toContain("[SYSTEM INSTRUCTIONS]");
    expect(prompts[1]).toContain("health check");
  });

  it("after its retries (two by default) it fails the turn with agy's reason as a JSON-RPC error", async () => {
    const { agent, sessionId, prompts } = await sessionWith([
      new AgyRunError(SIGN_IN_FAILURE, "sign-in", true),
      new AgyRunError(SIGN_IN_FAILURE, "sign-in", true),
      new AgyRunError(SIGN_IN_FAILURE, "sign-in", true),
    ]);

    const err = await ask(agent, sessionId).catch((e: unknown) => e);
    expect(prompts).toHaveLength(3);
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toMatchObject({ code: -32000, message: `agy: ${SIGN_IN_FAILURE}` });
  });

  it("does not retry another failure, nor a sign-in failure after agy produced output", async () => {
    const other = await sessionWith([new AgyRunError("503 No capacity", "error-result", true)]);
    await expect(ask(other.agent, other.sessionId)).rejects.toMatchObject({ code: -32000, message: "agy: 503 No capacity" });
    expect(other.prompts).toHaveLength(1);

    const late = await sessionWith([new AgyRunError(SIGN_IN_FAILURE, "sign-in", false)]);
    await expect(ask(late.agent, late.sessionId)).rejects.toBeInstanceOf(RequestError);
    expect(late.prompts).toHaveLength(1);
  });

  it("AGY_ACP_SIGNIN_RETRIES=0 turns the retry off", async () => {
    process.env.AGY_ACP_SIGNIN_RETRIES = "0";
    const { agent, sessionId, prompts } = await sessionWith([new AgyRunError(SIGN_IN_FAILURE, "sign-in", true)]);
    await expect(ask(agent, sessionId)).rejects.toBeInstanceOf(RequestError);
    expect(prompts).toHaveLength(1);
  });

  it("a cancel during the wait ends the turn as cancelled without another run", async () => {
    process.env.AGY_ACP_SIGNIN_RETRY_DELAY_MS = "200";
    const { agent, sessionId, session, prompts } = await sessionWith([
      new AgyRunError(SIGN_IN_FAILURE, "sign-in", true),
      "end_turn",
    ]);
    session.process.cancel = vi.fn();

    const turn = ask(agent, sessionId);
    await tick();
    agent.cancel({ sessionId });
    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
    expect(prompts).toHaveLength(1);
  });

  it("reads its policy from the environment, within bounds", () => {
    expect(signInRetryPolicy()).toEqual({ retries: 2, firstDelayMs: 0 });
    process.env.AGY_ACP_SIGNIN_RETRIES = "9";
    process.env.AGY_ACP_SIGNIN_RETRY_DELAY_MS = "not a number";
    expect(signInRetryPolicy()).toEqual({ retries: 5, firstDelayMs: 2000 });
  });
});
