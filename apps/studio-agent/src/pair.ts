import {
  ApiErrorSchema,
  type PairRequest,
  PairRequestSchema,
  PairResponseSchema,
  routes,
} from "@loomcast/contracts";
import { AGENT_VERSION, detectPlatform } from "./agent-info";
import {
  type AgentConfig,
  ConfigError,
  DEFAULT_CONCURRENCY,
  defaultWorkspaceRoot,
  loadConfig,
  saveConfig,
} from "./config";
import type { AgentPaths } from "./paths";
import { normalizeServerUrl } from "./server-url";

const PAIR_TIMEOUT_MS = 15_000;

export interface PairOptions {
  /** The Loomcast server, for example `https://loomcast.example.com`. */
  readonly server: string;
  /** The pairing code shown in Settings → Devices (`XXXX-XXXX`). */
  readonly code: string;
  /** The device name shown in Settings. */
  readonly name: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Pairing failed; the message is safe to show and never contains the device token. */
export class PairingError extends Error {
  override readonly name = "PairingError";
}

/**
 * Exchanges a pairing code for a device token (`POST /api/bridge/pair`) and stores the result in
 * the config file. The workspace root and concurrency of an earlier pairing are kept.
 */
export async function pairDevice(options: PairOptions, paths: AgentPaths): Promise<AgentConfig> {
  const serverUrl = normalizeServerUrl(options.server);
  const request = PairRequestSchema.safeParse({
    code: options.code,
    name: options.name,
    platform: detectPlatform(),
    agentVersion: AGENT_VERSION,
  } satisfies PairRequest);
  if (!request.success) {
    const fields = request.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new PairingError(`Invalid pairing request (${fields.join("; ")})`);
  }

  const route = routes["bridge.pair"];
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(new URL(route.path, serverUrl), {
      method: route.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request.data),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? PAIR_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PairingError(`Could not reach ${serverUrl}: ${(error as Error).message}`);
  }

  const body = await readJson(response);
  if (!response.ok) {
    const apiError = ApiErrorSchema.safeParse(body);
    const detail = apiError.success ? apiError.data.error.message : response.statusText;
    throw new PairingError(`Pairing was refused (HTTP ${response.status}): ${detail}`);
  }
  const pair = PairResponseSchema.safeParse(body);
  if (!pair.success) {
    throw new PairingError("The server sent an unexpected pairing response");
  }

  const previous = loadPreviousConfig(paths);
  const config: AgentConfig = {
    serverUrl,
    deviceId: pair.data.deviceId,
    token: pair.data.token,
    workspaceRoot: previous?.workspaceRoot ?? defaultWorkspaceRoot(),
    concurrency: previous?.concurrency ?? DEFAULT_CONCURRENCY,
  };
  saveConfig(paths, config);
  return config;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** An unreadable earlier config is replaced, so pairing is also the way to repair it. */
function loadPreviousConfig(paths: AgentPaths): AgentConfig | null {
  try {
    return loadConfig(paths);
  } catch (error) {
    if (error instanceof ConfigError) {
      return null;
    }
    throw error;
  }
}
