import {
  type PairingCode,
  PairRequestSchema,
  type PairResponse,
  routes,
} from "@loomcast/contracts";
import { type Context, Hono } from "hono";
import type { ModuleDeps } from "../../deps";
import { HttpError } from "../../lib/errors";
import { clientIp, readJson } from "../../lib/http";
import { consume, createRateLimiter } from "../../lib/rate-limit";
import type { AppEnv } from "../../types";
import { currentUser } from "../auth/guards";
import { createDevicesService } from "./service";

export { generatePairingCode, hashPairingCode } from "./codes";
export { createDevicesService, type DevicesService, PairingRefusedError } from "./service";

const MINUTE_MS = 60_000;

/**
 * `POST /api/bridge/pair` is public and guessable codes are its only secret: 10 attempts a minute
 * per client address. Creating codes needs a session, but is capped per user as well.
 */
export const PAIRING_LIMITS = {
  pairPerIp: { capacity: 10, intervalMs: MINUTE_MS },
  codesPerUser: { capacity: 10, intervalMs: MINUTE_MS },
} as const;

/**
 * Device pairing:
 * - `POST /api/devices/pairing-codes` (session): a single-use code, valid for 10 minutes.
 * - `POST /api/bridge/pair` (public): the studio agent exchanges the code for a device token.
 */
export function register(app: Hono<AppEnv>, deps: ModuleDeps): Hono<AppEnv> {
  const { config } = deps;
  const service = createDevicesService(deps);
  const router = new Hono<AppEnv>();
  const pairPerIp = createRateLimiter(PAIRING_LIMITS.pairPerIp, deps.clock);
  const codesPerUser = createRateLimiter(PAIRING_LIMITS.codesPerUser, deps.clock);

  router.post(routes["devices.createPairingCode"].path, async (c) => {
    const user = currentUser(c);
    consume(codesPerUser, user.id);
    const created = await service.createPairingCode(user.id, {
      ip: clientIp(c, config.trustProxy),
    });
    c.get("logger").info({ pairingCodeId: created.id }, "pairing code created");
    // The code is in this response only; keep it out of every cache.
    c.header("Cache-Control", "no-store");
    const body: PairingCode = { code: created.code, expiresAt: created.expiresAt.toISOString() };
    return c.json(body, 201);
  });

  // Public route: the studio agent sends no Origin header and no session, so the app-level guard
  // lets it through and this handler applies its own checks.
  router.post(routes["bridge.pair"].path, async (c) => {
    const ip = clientIp(c, config.trustProxy);
    consume(pairPerIp, ip);
    checkPairRequest(c, config.appOrigin);
    const input = await readJson(c, PairRequestSchema);
    const paired = await service.pair(input, { ip });
    c.get("logger").info(
      { deviceId: paired.device.id, pairedBy: paired.pairedBy, platform: paired.device.platform },
      "device paired",
    );
    // The device token is in this response only; keep it out of every cache.
    c.header("Cache-Control", "no-store");
    const body: PairResponse = { deviceId: paired.device.id, token: paired.secret };
    return c.json(body, 201);
  });

  app.route("/", router);
  return router;
}

/**
 * The studio agent sends JSON without an `Origin` header. A browser always sends `Origin` on a
 * POST, so a foreign one means a web page is calling; refuse it, like the bridge refuses
 * browser WebSockets. Requiring JSON also keeps simple cross-site form posts out.
 */
function checkPairRequest(c: Context<AppEnv>, appOrigin: string): void {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== appOrigin) {
    throw new HttpError(403, "forbidden", "Cross-site requests are not allowed.", {
      reason: "origin",
    });
  }
  const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(403, "forbidden", "Requests must be sent as application/json.", {
      reason: "content_type",
    });
  }
}
