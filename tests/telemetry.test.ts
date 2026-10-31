import { describe, it, expect, vi, beforeEach } from "vitest";
import { initTelemetry, redactSecrets, truncatePayload } from "../src/telemetry.js";

describe("TelemetryService", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is unset", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const service = await initTelemetry();
    expect(service).toBeNull();
  });

  it("redacts sensitive tokens across all provider types while preserving 64-hex Nostr event IDs", () => {
    // Exact process secret simulation
    process.env.BUZZ_PRIVATE_KEY = "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef";

    const nostrEventId = "4c729e2469446d499e46a7be7c0897f2597ffc644837517942851bb2b3394c25";
    const input = [
      `Command: buzz messages thread --channel "twin" --event ${nostrEventId}`,
      "NostrPriv: nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xey3dp30pt0qjfsd8x",
      "ProcessKey: deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef",
      "Anthropic: sk-ant-api03-abcdef1234567890_ghijklmnop",
      "GitLab: glpat-abcdef12345678901234",
      "GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "GoogleAccess: ya29.a0AWY7Ckk1234567890abcdef",
      "GoogleRefresh: 1//0gABCDEF1234567890abcdefghijklmnopqrstuvwxyz",
      "GoogleJWT: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef1234567890"
    ].join("\n");

    const cleaned = redactSecrets(input);

    // 64-hex Nostr event ID must be PRESERVED
    expect(cleaned).toContain(nostrEventId);
    expect(cleaned).toContain(`--event ${nostrEventId}`);

    // All secrets must be REDACTED
    expect(cleaned).not.toContain("nsec1vl029");
    expect(cleaned).not.toContain("deadbeefcafebabe");
    expect(cleaned).not.toContain("sk-ant-api03");
    expect(cleaned).not.toContain("glpat-abcdef");
    expect(cleaned).not.toContain("ghp_1234");
    expect(cleaned).not.toContain("ya29.a0AWY");
    expect(cleaned).not.toContain("1//0gABCDEF");
    expect(cleaned).not.toContain("eyJhbGciOiJSUzI1Ni");
    expect(cleaned).toContain("[REDACTED]");
  });

  it("truncates payloads exceeding max character limits", () => {
    const longText = "a".repeat(10000);
    const truncated = truncatePayload(longText, 8192);
    expect(truncated.length).toBeLessThanOrEqual(8192 + 20);
    expect(truncated).toContain("... [TRUNCATED]");
  });

  it("initializes TelemetryService and creates root AGENT span, child LLM span, and tool spans", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:6006/v1/traces");
    vi.stubEnv("OTEL_SERVICE_NAME", "phoenix-twin");
    vi.stubEnv("PHOENIX_PROJECT_NAME", "mobile");

    const service = await initTelemetry();
    expect(service).not.toBeNull();

    const turn = service!.startTurnSpan("sess-1", "Help me check SimpleMDG", "gemini-3.8-flash-high");
    expect(turn).toBeDefined();

    // Start and end tool span with step index
    turn.startToolSpan(1, "search_web", { query: "SimpleMDG" });
    turn.endToolSpan(1, "search_web", "Found documentation", undefined);

    // Record token usage
    turn.recordUsage({
      input_tokens: 100,
      output_tokens: 50,
      thinking_tokens: 10,
      cache_read_tokens: 20,
      total_tokens: 150
    });

    // End turn
    turn.end("OK", "Here is the summary of SimpleMDG");

    // Background flush must be callable safely
    expect(() => service!.backgroundFlush(1000)).not.toThrow();
  });

  it("handles background flush timeout gracefully when endpoint is unreachable without crashing", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://192.0.2.1:6006/v1/traces"); // Unreachable TEST-NET IP
    const service = await initTelemetry();
    expect(service).not.toBeNull();

    const turn = service!.startTurnSpan("sess-unreachable", "test unreachable", "gemini-3.8-flash-high");
    turn.end("OK", "result");

    // Calling backgroundFlush should return immediately and not throw
    expect(() => service!.backgroundFlush(500)).not.toThrow();
  });
});
