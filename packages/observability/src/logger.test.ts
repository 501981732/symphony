import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

class MemoryStream {
  chunks: string[] = [];

  write(chunk: string | Buffer): boolean {
    this.chunks.push(chunk.toString());
    return true;
  }
}

describe("createLogger", () => {
  it("creates a pino logger instance", () => {
    const logger = createLogger({ name: "test" });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("creates a child logger with run context", () => {
    const logger = createLogger({ name: "test" });
    const child = logger.child({ runId: "r1", issueIid: 42 });
    expect(typeof child.info).toBe("function");
  });

  it("redacts token fields from log output", () => {
    const stream = new MemoryStream();
    const logger = createLogger({ name: "test", destination: stream });

    logger.info({ token: "glpat-12345678901234567890" }, "tool output");

    const output = stream.chunks.join("");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("glpat-12345678901234567890");
  });

  it("redacts bearer token strings from log output", () => {
    const stream = new MemoryStream();
    const logger = createLogger({ name: "test", destination: stream });

    logger.warn("failed with Bearer secret-token");

    const output = stream.chunks.join("");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret-token");
  });

  it("redacts child logger bindings from log output", () => {
    const stream = new MemoryStream();
    const logger = createLogger({ name: "test", destination: stream });
    const child = logger.child({ token: "glpat-12345678901234567890" });

    child.info("child output");

    const output = stream.chunks.join("");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("glpat-12345678901234567890");
  });
});
