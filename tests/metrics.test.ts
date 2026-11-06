import { describe, it, expect, afterEach } from "vitest";
import { InMemoryMetricExporter, AggregationTemporality, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { classifyAgyError, initMetrics, metricLabels } from "../src/metrics.js";

// Every message below is one agy really ended a run with on the fleet (nuc1 + wsl32, 2026-10-28 .. 2026-11-06).
const REAL_FAILURES: Array<[string, string, string | undefined, string]> = [
  // [message, AgyRunError kind, expected http_code, expected error_class]
  ["API error (attempt 2): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server", "error-result", "503", "capacity"],
  ["Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)", "error-result", "503", "capacity"],
  ["API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.", "error-result", "503", "unavailable"],
  ["Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 5h44m49s.", "error-result", "429", "quota"],
  ["authentication failed or timed out", "sign-in", undefined, "auth"],
  ["API error (attempt 1): UNKNOWN (code 500): Authentication backend unknown error.", "error-result", "500", "server_error"],
  ["INVALID_ARGUMENT (code 400): Request contains an invalid argument.", "error-result", "400", "invalid_request"],
  ["Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.", "error-result", undefined, "malformed_output"],
  ['Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": dial tcp: lookup daily-cloudcode-pa.googleapis.com on 172.17.0.1:53: server misbehaving', "error-result", undefined, "network"],
  ["The stream was interrupted. Please continue the task you were working on.", "error-result", undefined, "network"],
  ["There was a network issue connecting to the server, please try again.", "error-result", undefined, "network"],
  ["request failed: stream idle timeout (5m0s): context deadline exceeded", "error-result", undefined, "timeout"],
  ["agy exited with code 3, signal null before it answered", "exited", undefined, "exited"],
];

describe("classifyAgyError", () => {
  it.each(REAL_FAILURES)("%s", (message, kind, httpCode, errorClass) => {
    expect(classifyAgyError(message, kind)).toEqual({ errorClass, httpCode: httpCode ?? "" });
  });

  it("puts anything it does not recognise under other, keeping a status code it can read", () => {
    expect(classifyAgyError("something new (code 418): teapot", "error-result")).toEqual({ errorClass: "other", httpCode: "418" });
    expect(classifyAgyError("", "error")).toEqual({ errorClass: "other", httpCode: "" });
    expect(classifyAgyError(undefined, undefined)).toEqual({ errorClass: "other", httpCode: "" });
  });

  it("reads the status from RESOURCE_EXHAUSTED and UNAUTHENTICATED without a code in the message", () => {
    expect(classifyAgyError("RESOURCE_EXHAUSTED: rate limited", "error-result")).toEqual({ errorClass: "quota", httpCode: "429" });
    expect(classifyAgyError("UNAUTHENTICATED: token expired", "error-result")).toEqual({ errorClass: "auth", httpCode: "401" });
    expect(classifyAgyError("PERMISSION_DENIED (code 403): nope", "error-result")).toEqual({ errorClass: "auth", httpCode: "403" });
  });
});

describe("metricLabels", () => {
  it("names the agent, community, model and account from the container env, never the token", () => {
    const env = {
      AGENT_ID: "design-lead-agent",
      AGENT_COMMUNITY: "mobile",
      AGY_MODEL: "gemini-3.8-flash-high",
      AGY_ACCOUNT: "8",
      AGY_OAUTH_TOKEN_B64: "c2VjcmV0LXRva2Vu",
    };
    const labels = metricLabels(env);
    expect(labels).toEqual({ agent: "design-lead-agent", community: "mobile", model: "gemini-3.8-flash-high", account: "8" });
    expect(JSON.stringify(labels)).not.toContain("c2VjcmV0LXRva2Vu");
  });

  it("leaves a label empty rather than guessing when the env does not say", () => {
    expect(metricLabels({})).toEqual({ agent: "", community: "", model: "", account: "" });
  });
});

describe("initMetrics", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null and loads nothing when OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is unset", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    expect(await initMetrics()).toBeNull();
  });

  function collect(exporter: InMemoryMetricExporter): Map<string, Array<{ attributes: Record<string, unknown>; value: unknown }>> {
    const out = new Map<string, Array<{ attributes: Record<string, unknown>; value: unknown }>>();
    const batches: ResourceMetrics[] = exporter.getMetrics();
    const last = batches[batches.length - 1];
    for (const scope of last?.scopeMetrics ?? []) {
      for (const metric of scope.metrics) {
        out.set(
          metric.descriptor.name,
          metric.dataPoints.map((dp) => ({ attributes: dp.attributes as Record<string, unknown>, value: dp.value }))
        );
      }
    }
    return out;
  }

  async function service(env: Record<string, string>): Promise<{ exporter: InMemoryMetricExporter; m: NonNullable<Awaited<ReturnType<typeof initMetrics>>> }> {
    process.env = { ...saved, ...env, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://unused.invalid/opentelemetry/v1/metrics" };
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const m = await initMetrics(undefined, { reader });
    expect(m).not.toBeNull();
    return { exporter, m: m! };
  }

  const ENV = { AGENT_ID: "analyst-agent", AGENT_COMMUNITY: "mobile", AGY_MODEL: "gemini-3.8-flash-high", AGY_ACCOUNT: "3" };
  const BASE = { agent: "analyst-agent", community: "mobile", model: "gemini-3.8-flash-high", account: "3" };

  it("counts every agy run by outcome and error class, with its duration", async () => {
    const { exporter, m } = await service(ENV);
    m.recordRun({ outcome: "ok", durationSeconds: 42 });
    m.recordRun({ outcome: "ok", durationSeconds: 8 });
    m.recordRun({
      outcome: "error",
      durationSeconds: 180,
      errorMessage: "API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server",
      failureKind: "error-result",
    });
    m.recordRun({ outcome: "cancelled", durationSeconds: 3 });
    await m.flush();

    const metrics = collect(exporter);
    const runs = metrics.get("agy_runs_total")!;
    expect(runs).toEqual(
      expect.arrayContaining([
        { attributes: { ...BASE, outcome: "ok", error_class: "", http_code: "" }, value: 2 },
        { attributes: { ...BASE, outcome: "error", error_class: "capacity", http_code: "503" }, value: 1 },
        { attributes: { ...BASE, outcome: "cancelled", error_class: "", http_code: "" }, value: 1 },
      ])
    );
    expect(runs).toHaveLength(3);

    const durations = metrics.get("agy_run_duration_seconds")!;
    const ok = durations.find((d) => d.attributes.outcome === "ok")!;
    expect(ok.attributes).toEqual({ ...BASE, outcome: "ok" });
    expect(ok.value).toMatchObject({ count: 2, sum: 50 });
    await m.shutdown();
  });

  it("adds the tokens of a run by type", async () => {
    const { exporter, m } = await service(ENV);
    m.recordRun({
      outcome: "ok",
      durationSeconds: 1,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, thinking_tokens: 300 },
    });
    m.recordRun({ outcome: "ok", durationSeconds: 1, usage: { input_tokens: 10, output_tokens: 0 } });
    await m.flush();

    const tokens = collect(exporter).get("agy_tokens_total")!;
    const byType = Object.fromEntries(tokens.map((t) => [t.attributes.type, t.value]));
    expect(byType).toEqual({ input: 1010, output: 200, cache_read: 5000, thinking: 300 });
    for (const t of tokens) {
      expect(t.attributes).toMatchObject(BASE);
    }
    await m.shutdown();
  });

  it("never throws into a turn when the exporter cannot reach the endpoint", async () => {
    process.env = { ...saved, ...ENV, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:9/opentelemetry/v1/metrics" };
    const errors: unknown[] = [];
    const m = await initMetrics({ log: () => {}, error: (...a: unknown[]) => errors.push(a) });
    expect(m).not.toBeNull();
    m!.recordRun({ outcome: "error", durationSeconds: 1, errorMessage: "boom", failureKind: "error-result" });
    const started = Date.now();
    await expect(m!.flush(300)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(m!.shutdown()).resolves.toBeUndefined();
  }, 10_000);
});
