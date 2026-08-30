import { describe, it, expect, vi } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { nodeToWebWritable, nodeToWebReadable, sleep, Logger } from "../src/utils.js";

describe("Utils Module", () => {
  describe("sleep", () => {
    it("should resolve after specified milliseconds", async () => {
      const start = Date.now();
      await sleep(20);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(15);
    });
  });

  describe("nodeToWebWritable", () => {
    it("should write data from Web WritableStream to Node Writable", async () => {
      const nodeStream = new PassThrough();
      const chunks: string[] = [];

      nodeStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk.toString("utf-8"));
      });

      const webWritable = nodeToWebWritable(nodeStream);
      const writer = webWritable.getWriter();

      await writer.write(new TextEncoder().encode("hello "));
      await writer.write(new TextEncoder().encode("world"));
      await writer.close();

      expect(chunks.join("")).toBe("hello world");
    });

    it("should reject if the underlying node stream emits an error on write", async () => {
      const failingStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("Underlying write failure"));
        },
      });
      failingStream.on("error", () => {
        // Suppress unhandled event error in test
      });

      const webWritable = nodeToWebWritable(failingStream);
      const writer = webWritable.getWriter();

      await expect(writer.write(new TextEncoder().encode("test"))).rejects.toThrow(
        "Underlying write failure"
      );
    });
  });

  describe("nodeToWebReadable", () => {
    it("should stream data from Node Readable to Web ReadableStream", async () => {
      const nodeStream = new Readable({
        read() {},
      });

      const webReadable = nodeToWebReadable(nodeStream);
      const reader = webReadable.getReader();

      nodeStream.push(Buffer.from("chunk-1"));
      nodeStream.push(Buffer.from("chunk-2"));
      nodeStream.push(null);

      const r1 = await reader.read();
      expect(new TextDecoder().decode(r1.value)).toBe("chunk-1");

      const r2 = await reader.read();
      expect(new TextDecoder().decode(r2.value)).toBe("chunk-2");

      const r3 = await reader.read();
      expect(r3.done).toBe(true);
    });

    it("should propagate stream errors from Node Readable to Web ReadableStream", async () => {
      const nodeStream = new Readable({
        read() {},
      });

      const webReadable = nodeToWebReadable(nodeStream);
      const reader = webReadable.getReader();

      nodeStream.destroy(new Error("Stream exploded"));

      await expect(reader.read()).rejects.toThrow("Stream exploded");
    });
  });

  describe("Logger interface", () => {
    it("should adhere to Logger contract", () => {
      const logFn = vi.fn();
      const errorFn = vi.fn();

      const customLogger: Logger = {
        log: logFn,
        error: errorFn,
      };

      customLogger.log("info message", { key: "value" });
      customLogger.error("error message", new Error("test"));

      expect(logFn).toHaveBeenCalledWith("info message", { key: "value" });
      expect(errorFn).toHaveBeenCalledWith("error message", expect.any(Error));
    });
  });
});
