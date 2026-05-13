/**
 * Networking helpers shared by E2E tests.
 *
 * `pickFreePort` opens an ephemeral TCP listener on `127.0.0.1:0`, captures
 * the OS-assigned port, then closes the listener and returns the port. There
 * is a tiny window between close + reuse where another process *could*
 * snatch the port, but for E2E tests on a single machine it is dramatically
 * more reliable than `Math.random()` from a fixed range, especially under
 * vitest's `pool: "forks"` parallelism.
 *
 * The orchestrator daemon's `url` field is built directly from the port we
 * pass in, so we cannot let it bind to `0` and read the bound port back —
 * hence this two-step dance.
 */

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

export async function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        server.close();
        reject(new Error("pickFreePort: server.address() returned null"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}
