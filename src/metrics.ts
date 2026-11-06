/**
 * Run metrics: how every agy run ended, pushed as OpenTelemetry metrics over OTLP/HTTP (protobuf).
 *
 * Off unless OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set, and then fail-open: nothing here may fail or delay a turn.
 * The SDK is imported lazily, so an adapter without the variable loads none of it.
 *
 * Series (Prometheus names, as VictoriaMetrics stores them without -opentelemetry.usePrometheusNaming):
 *   agy_runs_total{agent,community,model,account,outcome,error_class,http_code}   one per agy run
 *   agy_run_duration_seconds{agent,community,model,account,outcome}               histogram
 *   agy_tokens_total{agent,community,model,account,type}                          input|output|cache_read|thinking
 *
 * Labels carry no secret and no free text: `account` is the number of the agy login (AGY_ACCOUNT, set by agent-infra
 * from the name of the token's CI/CD variable), never the token or the e-mail; an error is reduced to a fixed class
 * and its HTTP status, never its message.
 */
import type { AgyUsage } from "./agy-process.js";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import type { Logger } from "./utils.js";

export type RunOutcome = "ok" | "error" | "cancelled";

export type ErrorClass =
  | "capacity" // 503 MODEL_CAPACITY_EXHAUSTED: the model has no capacity on the server
  | "unavailable" // any other 503
  | "quota" // 429 / RESOURCE_EXHAUSTED: the account's quota is spent
  | "auth" // sign-in did not finish, 401, 403
  | "invalid_request" // 400
  | "server_error" // 5xx but 503
  | "malformed_output" // the model's own function call could not be parsed
  | "timeout" // a stream idle timeout or deadline
  | "network" // DNS, connection, interrupted stream
  | "exited" // agy died before it answered
  | "other";

export interface ErrorClassification {
  errorClass: ErrorClass;
  /** The HTTP status the message names (or implies), "" when none. */
  httpCode: string;
}

const STATUS_CODE: Record<string, string> = {
  INVALID_ARGUMENT: "400",
  UNAUTHENTICATED: "401",
  PERMISSION_DENIED: "403",
  RESOURCE_EXHAUSTED: "429",
  INTERNAL: "500",
  UNAVAILABLE: "503",
};

function httpCodeOf(message: string): string {
  const code = /\(code (\d{3})\)/i.exec(message) ?? /\b(?:HTTP|status)[ :]+(\d{3})\b/i.exec(message);
  if (code) {
    return code[1];
  }
  const status = /\b(INVALID_ARGUMENT|UNAUTHENTICATED|PERMISSION_DENIED|RESOURCE_EXHAUSTED|INTERNAL|UNAVAILABLE)\b/.exec(message);
  return status ? STATUS_CODE[status[1]] : "";
}

/**
 * Reduces how an agy run failed to a fixed class. `kind` is AgyRunError's (sign-in | error-result | exited) or
 * "error" for anything else the turn threw. The order matters: a capacity 503 is a 503, and a message can name both a
 * network failure and a status.
 */
export function classifyAgyError(message: string | undefined, kind: string | undefined): ErrorClassification {
  const text = message ?? "";
  let httpCode = httpCodeOf(text);

  let errorClass: ErrorClass;
  if (kind === "exited") {
    errorClass = "exited";
  } else if (kind === "sign-in") {
    errorClass = "auth";
  } else if (/no capacity available|MODEL_CAPACITY_EXHAUSTED/i.test(text)) {
    errorClass = "capacity";
  } else if (/quota reached|RESOURCE_EXHAUSTED|rate.?limit/i.test(text) || httpCode === "429") {
    errorClass = "quota";
  } else if (httpCode === "503") {
    errorClass = "unavailable";
  } else if (httpCode === "401" || httpCode === "403" || /authentication (failed|required)|not logged in|silent auth failed/i.test(text)) {
    errorClass = "auth";
  } else if (httpCode === "400") {
    errorClass = "invalid_request";
  } else if (/^5\d\d$/.test(httpCode)) {
    errorClass = "server_error";
  } else if (/malformed function call|improperly formatted function call/i.test(text)) {
    errorClass = "malformed_output";
  } else if (/idle timeout|deadline exceeded|timed out/i.test(text)) {
    errorClass = "timeout";
  } else if (/network issue|stream was interrupted|dial tcp|no such host|server misbehaving|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|\bEOF\b/i.test(text)) {
    errorClass = "network";
  } else {
    errorClass = "other";
  }

  // A quota message from agy carries no code; the class implies it.
  if (errorClass === "quota" && !httpCode) {
    httpCode = "429";
  }
  return { errorClass, httpCode };
}

export interface MetricLabels {
  agent: string;
  community: string;
  model: string;
  account: string;
}

/** The labels every series carries, from the container's env (agent-infra sets each of them). */
export function metricLabels(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): MetricLabels {
  return {
    agent: env.AGENT_ID ?? "",
    community: env.AGENT_COMMUNITY ?? "",
    model: env.AGY_MODEL ?? "",
    account: env.AGY_ACCOUNT ?? "",
  };
}

export interface RunRecord {
  outcome: RunOutcome;
  durationSeconds: number;
  /** The run's error message, only to classify it: never exported. */
  errorMessage?: string;
  failureKind?: string;
  /** The run's last usage report. */
  usage?: AgyUsage;
}

export interface MetricsService {
  recordRun(run: RunRecord): void;
  /** Exports now; resolves (never rejects) within timeoutMs (default 2000). */
  flush(timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
}

/** Seconds: a run spans a one-line answer to an hour-long brainstorm turn. */
const DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];

export interface MetricsOptions {
  /** Tests pass their own reader; otherwise a periodic OTLP exporter is built from the env. */
  reader?: MetricReader;
}

let exportErrors = 0;
function logExportError(logger: Logger | undefined, err: unknown): void {
  exportErrors++;
  if (exportErrors === 1 || exportErrors % 100 === 0) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`[Metrics] Export failed (occurrence #${exportErrors}): ${msg}`);
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function initMetrics(logger?: Logger, options: MetricsOptions = {}): Promise<MetricsService | null> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (!endpoint) {
    return null;
  }

  try {
    const [sdkMetrics, resources] = await Promise.all([
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/resources"),
    ]);
    const { MeterProvider, PeriodicExportingMetricReader, AggregationType } = sdkMetrics;

    let reader = options.reader;
    if (!reader) {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
      // Cumulative (the exporter's default): VictoriaMetrics stores an OTLP sum as a Prometheus counter, and
      // increase() over it survives a restart of the adapter.
      const exporter = new OTLPMetricExporter({
        url: endpoint,
        timeoutMillis: positiveInt(process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT, 5000),
      });
      const interval = positiveInt(process.env.OTEL_METRIC_EXPORT_INTERVAL, 15000);
      reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: interval,
        exportTimeoutMillis: Math.min(positiveInt(process.env.OTEL_METRIC_EXPORT_TIMEOUT, 5000), interval),
      });
    }

    // An empty resource: VictoriaMetrics turns resource attributes into labels on every series, and the SDK's default
    // (service.name=unknown_service:node, telemetry.sdk.*) would add four labels that say nothing.
    const provider = new MeterProvider({
      resource: resources.emptyResource(),
      readers: [reader],
      views: [
        {
          instrumentName: "agy_run_duration_seconds",
          aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: DURATION_BUCKETS } },
        },
      ],
    });
    const meter = provider.getMeter("agy-agent-acp");
    const runs = meter.createCounter("agy_runs_total", { description: "agy runs, by how they ended" });
    const durations = meter.createHistogram("agy_run_duration_seconds", {
      description: "Wall-clock time of an agy run",
      unit: "s",
    });
    const tokens = meter.createCounter("agy_tokens_total", { description: "Tokens an agy run reported, by type" });
    const base = metricLabels();

    // The OTLP exporter retries a failed export with backoff until its own timeout: a flush waits at most timeoutMs, and
    // the export, if still running, carries on (or is dropped) in the background.
    const flush = async (timeoutMs = 2000): Promise<void> => {
      await Promise.race([
        provider.forceFlush().catch((err: unknown) => logExportError(logger, err)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
      ]);
    };

    return {
      recordRun(run: RunRecord): void {
        try {
          const failure =
            run.outcome === "error" ? classifyAgyError(run.errorMessage, run.failureKind) : { errorClass: "", httpCode: "" };
          runs.add(1, { ...base, outcome: run.outcome, error_class: failure.errorClass, http_code: failure.httpCode });
          durations.record(Math.max(0, run.durationSeconds), { ...base, outcome: run.outcome });
          const u = run.usage;
          if (u) {
            const byType: Array<[string, number | undefined]> = [
              ["input", u.input_tokens],
              ["output", u.output_tokens],
              ["cache_read", u.cache_read_tokens],
              ["thinking", u.thinking_tokens],
            ];
            for (const [type, value] of byType) {
              if (typeof value === "number" && value > 0) {
                tokens.add(value, { ...base, type });
              }
            }
          }
        } catch (err) {
          logger?.error(`[Metrics] Could not record a run: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      flush,
      async shutdown(): Promise<void> {
        try {
          await Promise.race([provider.shutdown(), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
        } catch (err) {
          logExportError(logger, err);
        }
      },
    };
  } catch (err) {
    logger?.error(
      `[Metrics] Failed to initialize OpenTelemetry metrics, running without them: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
