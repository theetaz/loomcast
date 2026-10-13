import { Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import type { AppEnv } from "../../types";
import { type BridgeHub, type BridgeHubOptions, createBridgeHub } from "./hub";

export {
  type BridgeHub,
  type BridgeHubOptions,
  createBridgeHub,
  DISPATCH_INTERVAL_MS,
} from "./hub";
export { BridgeSession } from "./session";

const optionsByServer = new WeakMap<object, BridgeHubOptions>();
const hubsByServer = new WeakMap<object, BridgeHub>();

/**
 * Sets the hub timings for `server` before `createApp` registers the bridge. Tests use it for
 * short ping intervals and to switch the background timers off.
 */
export function configureBridge(server: object, options: BridgeHubOptions): void {
  optionsByServer.set(server, options);
}

/** The hub attached to `server`, if the bridge module registered one. */
export function bridgeHubFor(server: object): BridgeHub | undefined {
  return hubsByServer.get(server);
}

/**
 * The `/bridge/v1` WebSocket hub. It attaches to `deps.httpServer`, so it runs only when the app
 * is served by `startServer` (not under `app.request()`). It replaces `deps.presence`, closes its
 * connections during shutdown, and owns job dispatch and lease expiry.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  app.route("/", router);

  const server = deps.httpServer;
  if (server !== undefined) {
    const hub = createBridgeHub(deps, optionsByServer.get(server));
    hubsByServer.set(server, hub);
    deps.presence.connectedDevices = () => hub.connectedDevices();
    deps.lifecycle.onClose(() => hub.close());
  }
  return router;
}
