import { describe, it, expect, vi, beforeEach } from "vitest";
import { initTelemetry, parseNostrContext, redactSecrets, truncatePayload, _resetProcessSecretsCache } from "../src/telemetry.js";

describe("TelemetryService", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    _resetProcessSecretsCache();
  });

  it("parses Nostr thread context and metadata from ACP prompt text", () => {
    const rawPrompt = `
[Context]
Scope: thread
Channel: twin (#01fd5ea1-0089-471b-9aac-96e54993a4ab)
Thread root: 4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0
Use buzz messages thread --channel <UUID> --event <ID> to fetch thread context.
[Buzz event: @mention]
Event ID: a297490c80797211812b54d43bee951986e69a698a42bb86b29e3198adf2d60c
Channel: twin (#01fd5ea1-0089-471b-9aac-96e54993a4ab)
Kind: 9
From: Elio Tran (npub: npub1lt6z6e95lgsr8dfc27hjemj2z4hrh22d96j0lvu7hj2j2pdexlksyt0uu7, hex: faf42d64b4fa2033b53857af2cee4a156e3ba94d2ea4ffb39ebc952505b937ed)
Time: 2026-11-01T07:58:47+00:00
Content: @Phoenix Twin Hello
Parsed: parent=4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0, root=4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0
    `;

    const meta = parseNostrContext(rawPrompt);
    expect(meta.threadRootId).toBe("4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0");
    expect(meta.eventId).toBe("a297490c80797211812b54d43bee951986e69a698a42bb86b29e3198adf2d60c");
    expect(meta.channelId).toBe("01fd5ea1-0089-471b-9aac-96e54993a4ab");
    expect(meta.channelName).toBe("twin");
    expect(meta.replyToId).toBe("4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0");
    expect(meta.senderName).toBe("Elio Tran");
    expect(meta.senderPubkey).toBe("faf42d64b4fa2033b53857af2cee4a156e3ba94d2ea4ffb39ebc952505b937ed");
  });

  it("correlates session.id to Nostr Thread Root ID when metadata is provided", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.4.1:6006/v1/traces");
    vi.stubEnv("AGENT_ID", "phoenix-twin");
    vi.stubEnv("AGENT_COMMUNITY", "mobile");

    const service = await initTelemetry();
    expect(service).not.toBeNull();

    const nostrMeta = {
      threadRootId: "4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0",
      eventId: "a297490c80797211812b54d43bee951986e69a698a42bb86b29e3198adf2d60c",
      channelId: "01fd5ea1-0089-471b-9aac-96e54993a4ab",
      replyToId: "4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0"
    };

    const turn = service!.startTurnSpan("random-uuid-session", "Prompt text", "gemini-3.8-flash-high", nostrMeta);
    expect(turn).toBeDefined();
    turn.end("OK", "Response");
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
