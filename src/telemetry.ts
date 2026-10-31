import type { AgyUsage } from "./agy-process.js";
import type { Span } from "@opentelemetry/api";
import { Logger } from "./utils.js";

// Secret sanitization patterns
const PREFIXED_PATTERNS = [
  /nsec1[0-9a-z]{58}/g,
  /sk-ant-[0-9a-zA-Z_\-\.]+/g,
  /\bgl(pat|rt|dt|ptt|cbt|oas)-[0-9a-zA-Z_\-]+/g,
  /\bgh[pousr]_[0-9a-zA-Z]{36}\b/g,
  /ya29\.[0-9a-zA-Z_\-]+/g,
  /1\/\/[0-9a-zA-Z_\-]+/g,
  /\beyJ[a-zA-Z0-9_\-]{10,}\.eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]+/g,
];

let cachedProcessSecrets: string[] | null = null;

function getProcessSecrets(): string[] {
  if (cachedProcessSecrets !== null) {
    return cachedProcessSecrets;
  }
  const secrets: string[] = [];
  const sensitiveKeys = [
    "BUZZ_PRIVATE_KEY",
    "GITLAB_TOKEN",
    "AGY_OAUTH_TOKEN_B64",
    "PHOENIX_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "MEETING_GATE_TOKEN",
  ];

  for (const key of sensitiveKeys) {
    const val = process.env[key];
    if (val && typeof val === "string" && val.length >= 8) {
      secrets.push(val);
      try {
        const b64 = Buffer.from(val).toString("base64");
        if (b64.length >= 8) {secrets.push(b64);}
      } catch {
        // ignore
      }
    }
  }

  // Deduplicate and sort descending by length to replace longer strings first
  cachedProcessSecrets = Array.from(new Set(secrets)).sort((a, b) => b.length - a.length);
  return cachedProcessSecrets;
}

export function redactSecrets(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }
  let text = typeof input === "string" ? input : JSON.stringify(input);

  // 1. Exact match against known process secrets
  const processSecrets = getProcessSecrets();
  for (const secret of processSecrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join("[REDACTED]");
    }
  }

  // 2. Prefixed patterns (Nostr, Anthropic, GitLab, GitHub, Google OAuth, JWT)
  for (const pattern of PREFIXED_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }

  return text;
}

export function truncatePayload(text: string, maxLen = 8192): string {
  if (!text) {return "";}
  if (text.length <= maxLen) {return text;}
  return text.slice(0, maxLen) + "... [TRUNCATED]";
}

export interface TurnSpanHandle {
  startToolSpan(stepIndex: number, toolName: string, toolParams: unknown): void;
  endToolSpan(stepIndex: number, toolName: string, output?: string, error?: { type?: string; message?: string }): void;
  recordUsage(usage: AgyUsage): void;
  end(status: "OK" | "ERROR", outputValue?: string, failureKind?: string, errorMessage?: string): void;
}

export interface TelemetryService {
  startTurnSpan(sessionId: string, promptText: string, modelName?: string): TurnSpanHandle;
  backgroundFlush(timeoutMs?: number): void;
  shutdown(): Promise<void>;
}

// Throttled error logger for export errors
let exportErrorCount = 0;
function logExportError(logger: Logger | undefined, err: unknown): void {
  exportErrorCount++;
  if (exportErrorCount === 1 || exportErrorCount % 100 === 0) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`[Telemetry] Trace export failed (occurrence #${exportErrorCount}): ${msg}`);
  }
}

export async function initTelemetry(logger?: Logger): Promise<TelemetryService | null> {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!tracesEndpoint) {
    return null;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || "agy-agent";
  const projectName = process.env.PHOENIX_PROJECT_NAME || "default";
  const apiKey = process.env.PHOENIX_API_KEY;

  // Dynamic lazy import to ensure 0ms and 0MB overhead when telemetry is disabled
  const [
    api,
    sdkTrace,
    resources,
    exporterProto,
    semconv
  ] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/semantic-conventions")
  ]);

  const { trace, context, SpanStatusCode } = api;
  const { NodeTracerProvider, BatchSpanProcessor } = sdkTrace;
  const { resourceFromAttributes } = resources;
  const { OTLPTraceExporter } = exporterProto;
  const { ATTR_SERVICE_NAME } = semconv;

  const headers: Record<string, string> = {
    "x-project-name": projectName
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const exporter = new OTLPTraceExporter({
    url: tracesEndpoint,
    headers,
    timeoutMillis: 1000
  });

  const batchProcessor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 512,
    maxExportBatchSize: 64,
    scheduledDelayMillis: 30000,
    exportTimeoutMillis: 1000
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    "openinference.project.name": projectName
  });

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [batchProcessor],
    spanLimits: {
      attributeValueLengthLimit: 8192
    }
  });

  provider.register();
  const tracer = trace.getTracer("agy-agent-acp", "0.1.5");

  return {
    startTurnSpan(sessionId: string, promptText: string, modelName?: string): TurnSpanHandle {
      const sanitizedPrompt = truncatePayload(redactSecrets(promptText));
      const rootSpan = tracer.startSpan("agent_turn", {
        attributes: {
          "openinference.span.kind": "AGENT",
          "session.id": sessionId,
          "input.value": sanitizedPrompt,
          "input.mime_type": "text/plain"
        }
      });

      // Context with rootSpan active for children
      const rootContext = trace.setSpan(context.active(), rootSpan);

      // Child LLM span for Arize Phoenix token count and cost attribution
      const resolvedModel = modelName || process.env.AGY_MODEL || "gemini-3.8-flash-high";
      const llmSpan = tracer.startSpan(`llm:${resolvedModel}`, {
        attributes: {
          "openinference.span.kind": "LLM",
          "llm.model_name": resolvedModel,
          "llm.provider": "google",
          "input.value": sanitizedPrompt,
          "input.mime_type": "text/plain"
        }
      }, rootContext);

      const activeToolSpans = new Map<number, Span>();

      return {
        startToolSpan(stepIndex: number, toolName: string, toolParams: unknown): void {
          if (activeToolSpans.has(stepIndex)) {
            return; // Deduplicate
          }
          const sanitizedParams = truncatePayload(redactSecrets(toolParams));
          const toolSpan = tracer.startSpan(`tool:${toolName}`, {
            attributes: {
              "openinference.span.kind": "TOOL",
              "tool.name": toolName,
              "input.value": sanitizedParams,
              "input.mime_type": "application/json"
            }
          }, rootContext);

          activeToolSpans.set(stepIndex, toolSpan);
        },

        endToolSpan(stepIndex: number, _toolName: string, output?: string, error?: { type?: string; message?: string }): void {
          const toolSpan = activeToolSpans.get(stepIndex);
          if (!toolSpan) {return;}

          if (error) {
            toolSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message || error.type || "Tool execution error"
            });
            if (error.message) {
              toolSpan.setAttribute("tool.error", truncatePayload(redactSecrets(error.message)));
            }
          } else {
            toolSpan.setStatus({ code: SpanStatusCode.OK });
          }

          if (output !== undefined) {
            toolSpan.setAttribute("output.value", truncatePayload(redactSecrets(output)));
            toolSpan.setAttribute("output.mime_type", "text/plain");
          }

          toolSpan.end();
          activeToolSpans.delete(stepIndex);
        },

        recordUsage(usage: AgyUsage): void {
          const promptTokens = (usage.input_tokens || 0) + (usage.cache_read_tokens || 0);
          const completionTokens = (usage.output_tokens || 0) + (usage.thinking_tokens || 0);

          llmSpan.setAttribute("llm.token_count.prompt", promptTokens);
          llmSpan.setAttribute("llm.token_count.completion", completionTokens);
          if (usage.total_tokens !== undefined) {
            llmSpan.setAttribute("llm.token_count.total", usage.total_tokens);
          }
          if (usage.cache_read_tokens) {
            llmSpan.setAttribute("llm.token_count.prompt_details.cache_read", usage.cache_read_tokens);
          }
          if (usage.thinking_tokens) {
            llmSpan.setAttribute("llm.token_count.completion_details.reasoning", usage.thinking_tokens);
          }
        },

        end(status: "OK" | "ERROR", outputValue?: string, failureKind?: string, errorMessage?: string): void {
          // Close any lingering tool spans
          for (const [idx, toolSpan] of activeToolSpans.entries()) {
            toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: "Turn ended before tool completed" });
            toolSpan.end();
            activeToolSpans.delete(idx);
          }

          const sanitizedOutput = outputValue ? truncatePayload(redactSecrets(outputValue)) : "";

          // End LLM span
          if (sanitizedOutput) {
            llmSpan.setAttribute("output.value", sanitizedOutput);
            llmSpan.setAttribute("output.mime_type", "text/plain");
          }
          if (status === "ERROR") {
            llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage || "LLM turn error" });
          } else {
            llmSpan.setStatus({ code: SpanStatusCode.OK });
          }
          llmSpan.end();

          // End Root Agent span
          if (sanitizedOutput) {
            rootSpan.setAttribute("output.value", sanitizedOutput);
            rootSpan.setAttribute("output.mime_type", "text/plain");
          }

          if (status === "ERROR") {
            rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage || "Agent turn error" });
            if (failureKind) {
              rootSpan.setAttribute("agy.failure_kind", failureKind);
            }
          } else {
            rootSpan.setStatus({ code: SpanStatusCode.OK });
          }
          rootSpan.end();
        }
      };
    },

    backgroundFlush(timeoutMs = 1000): void {
      Promise.race([
        provider.forceFlush().catch(err => logExportError(logger, err)),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]).catch(err => logExportError(logger, err));
    },

    async shutdown(): Promise<void> {
      try {
        await Promise.race([
          provider.shutdown(),
          new Promise(resolve => setTimeout(resolve, 1500))
        ]);
      } catch (err) {
        logExportError(logger, err);
      }
    }
  };
}
