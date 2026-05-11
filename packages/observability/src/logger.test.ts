import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

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
});
