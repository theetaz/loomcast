import { BRIDGE_PATH } from "@loomcast/contracts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Thrown for a server URL the agent refuses to send its device token to. */
export class ServerUrlError extends Error {
  override readonly name = "ServerUrlError";
}

/**
 * Validates a server URL and returns its origin, for example `https://loomcast.example.com`.
 *
 * The device token travels to this server, so plain `http` is accepted only for a loopback host
 * (local development).
 */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ServerUrlError(`"${input}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ServerUrlError(`The server URL must use https, not ${url.protocol.slice(0, -1)}`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ServerUrlError("The server URL must use https unless the server runs on this Mac");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ServerUrlError("The server URL must not contain credentials");
  }
  return url.origin;
}

/** The WebSocket URL of the bridge on `serverUrl`: `wss://host/bridge/v1` (`ws` for http). */
export function bridgeUrl(serverUrl: string): string {
  const url = new URL(BRIDGE_PATH, normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
