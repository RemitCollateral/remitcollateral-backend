import type { AddressInfo } from "node:net";
import app from "../app";

/**
 * Start the API on an ephemeral local port for a test. Returns its base URL
 * and a function that stops it.
 */
export async function startTestServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
