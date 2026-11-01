import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode } from "@opentelemetry/api";

// The spans initTelemetry makes, caught by an in-memory exporter in place of the OTLP one; its shutdown would drop them.
class KeepingExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
const exporter = new KeepingExporter();

describe("span status of a turn (F3 / OTel Specification Compliance)", () => {
  beforeEach(() => {
    vi.resetModules();
    trace.disable();
    exporter.reset();
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:1/v1/traces");
    vi.doMock("@opentelemetry/exporter-trace-otlp-proto", () => ({
      OTLPTraceExporter: class { constructor() { return exporter; } },
    }));
  });
  afterEach(() => {
    vi.doUnmock("@opentelemetry/exporter-trace-otlp-proto");
    vi.unstubAllEnvs();
  });

  async function runTurn(end: (t: any) => void) {
    const { initTelemetry } = await import("../src/telemetry.js");
    const service = (await initTelemetry())!;
    const turn = service.startTurnSpan("test-session", "test prompt", "gemini-3.8-flash-high");
    turn.startToolSpan(1, "run_command", { command: "ls" });
    end(turn);
    await service.shutdown();
    return Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name.split(":")[0], s]));
  }

  it("a cancelled turn leaves every span's status unset and records agy.stop_reason = 'cancelled'", async () => {
    const spans = await runTurn((t) => t.end("CANCELLED", "partial assistant text"));
    expect(spans.agent_turn.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans.llm.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans.tool.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans.agent_turn.attributes["agy.stop_reason"]).toBe("cancelled");
    expect(spans.llm.attributes["agy.stop_reason"]).toBe("cancelled");
    expect(spans.tool.attributes["agy.stop_reason"]).toBe("cancelled");
    expect(spans.agent_turn.attributes["agy.failure_kind"]).toBeUndefined();
  });

  it("a failed turn is still ERROR, including its open tool span", async () => {
    const spans = await runTurn((t) => t.end("ERROR", undefined, "exited", "agy process terminated unexpectedly"));
    expect(spans.agent_turn.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans.agent_turn.attributes["agy.failure_kind"]).toBe("exited");
    expect(spans.llm.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans.tool.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("an OK turn sets OK status on agent and llm spans", async () => {
    const spans = await runTurn((t) => t.end("OK", "complete output"));
    expect(spans.agent_turn.status.code).toBe(SpanStatusCode.OK);
    expect(spans.llm.status.code).toBe(SpanStatusCode.OK);
  });
});

describe("fail-open when OTel SDK fails to initialize (F1)", () => {
  afterEach(() => {
    vi.doUnmock("@opentelemetry/sdk-trace-node");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("initTelemetry returns null and logs error instead of throwing when SDK load crashes", async () => {
    vi.resetModules();
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:1/v1/traces");
    vi.doMock("@opentelemetry/sdk-trace-node", () => {
      throw new Error("Simulated SDK NodeTracerProvider failure");
    });
    const { initTelemetry } = await import("../src/telemetry.js");
    const logger = { log: vi.fn(), error: vi.fn() };
    const result = await initTelemetry(logger);
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("fail-open"));
  });
});
