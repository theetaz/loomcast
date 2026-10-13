import { DEVICE_TOKEN_RE, MCP_TOKEN_RE } from "@loomcast/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig } from "../src/env";
import { createEventBus } from "../src/lib/bus";
import { base62, generatePrefixedToken, randomToken, sha256Hex } from "../src/lib/crypto";
import { createLifecycle } from "../src/lib/lifecycle";
import { createLogger } from "../src/lib/logger";
import { createRateLimiter } from "../src/lib/rate-limit";
import { createTestClock, testPassword } from "./support";

describe("crypto", () => {
  it("generates prefixed tokens that match the contract formats", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const mcp = generatePrefixedToken("mcp");
      expect(mcp.secret).toMatch(MCP_TOKEN_RE);
      expect(mcp.hash).toBe(sha256Hex(mcp.secret));
      expect(mcp.prefix).toBe(mcp.secret.slice(0, 15));
      seen.add(mcp.secret);
    }
    expect(seen.size).toBe(200);
    expect(generatePrefixedToken("device").secret).toMatch(DEVICE_TOKEN_RE);
  });

  it("encodes 32 bytes in 43 base62 characters, including the extremes", () => {
    expect(base62(new Uint8Array(32), 43)).toBe("0".repeat(43));
    const max = base62(new Uint8Array(32).fill(255), 43);
    expect(max).toHaveLength(43);
    expect(max).toMatch(/^[0-9A-Za-z]{43}$/);
    expect(() => base62(new Uint8Array(33).fill(255), 43)).toThrow();
  });

  it("creates base64url session tokens", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("rate limiter", () => {
  it("allows a burst, then refills continuously", () => {
    const clock = createTestClock();
    const limiter = createRateLimiter({ capacity: 5, intervalMs: 60_000 }, clock);
    for (let index = 0; index < 5; index += 1) {
      expect(limiter.take("k").allowed).toBe(true);
    }
    const blocked = limiter.take("k");
    expect(blocked).toEqual({ allowed: false, remaining: 0, retryAfterMs: 12_000 });
    expect(limiter.take("other").allowed).toBe(true);

    clock.advance(11_999);
    expect(limiter.take("k").allowed).toBe(false);
    clock.advance(1);
    expect(limiter.take("k").allowed).toBe(true);

    clock.advance(10 * 60_000);
    expect(limiter.take("k").remaining).toBe(4);
  });

  it("sweeps full buckets when it tracks too many keys", () => {
    const clock = createTestClock();
    const limiter = createRateLimiter({ capacity: 2, intervalMs: 1_000, maxKeys: 3 }, clock);
    limiter.take("a");
    limiter.take("b");
    limiter.take("c");
    clock.advance(5_000);
    limiter.take("d");
    expect(limiter.size).toBe(1);
  });
});

describe("event bus", () => {
  it("delivers typed events and isolates failing listeners", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "error",
      destination: { write: (l) => void lines.push(l) },
    });
    const bus = createEventBus(logger);
    const enqueued = vi.fn();
    const live = vi.fn();
    bus.subscribe("job.enqueued", () => {
      throw new Error("sync failure");
    });
    bus.subscribe("job.enqueued", async () => {
      throw new Error("async failure");
    });
    const unsubscribe = bus.subscribe("job.enqueued", enqueued);
    bus.subscribeLive(live);

    const event = {
      type: "job.enqueued",
      payload: {
        jobId: "00000000-0000-4000-8000-000000000001",
        type: "system.ping",
        projectId: "00000000-0000-4000-8000-000000000002",
        deviceAffinity: null,
      },
    } as const;
    bus.publish(event);
    expect(enqueued).toHaveBeenCalledWith(event);
    // Internal events never reach the live stream.
    expect(live).not.toHaveBeenCalled();

    bus.publish({ type: "resync", payload: {} });
    expect(live).toHaveBeenCalledWith({ type: "resync", payload: {} });

    unsubscribe();
    bus.publish(event);
    expect(enqueued).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setImmediate(resolve));
    const failures = lines.filter((line) => line.includes("event listener failed"));
    expect(failures.length).toBe(4);
  });
});

describe("lifecycle", () => {
  it("runs close hooks once, newest first, and survives a failing hook", async () => {
    const order: string[] = [];
    const lifecycle = createLifecycle(createLogger({ level: "silent" }));
    lifecycle.onClose(() => void order.push("first"));
    lifecycle.onClose(() => {
      throw new Error("boom");
    });
    lifecycle.onClose(async () => void order.push("last"));
    expect(lifecycle.closing).toBe(false);
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    expect(lifecycle.closing).toBe(true);
    expect(order).toEqual(["last", "first"]);
  });
});

describe("logger", () => {
  it("redacts credentials at any of the first levels", () => {
    // Every sensitive value is generated per run so the suite holds no credential-like literals.
    const sensitive = {
      mcpTop: `lc_mcp_${testPassword("top")}`,
      mcpNested: `lc_mcp_${testPassword("nested")}`,
      session: `lc_session=${testPassword("session")}`,
      password: testPassword("logged"),
      device: `lc_dev_${testPassword("device")}`,
      deep: testPassword("deep"),
    };
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      destination: { write: (l) => void lines.push(l) },
    });
    logger.info(
      {
        authorization: `Bearer ${sensitive.mcpTop}`,
        req: {
          headers: { authorization: `Bearer ${sensitive.mcpNested}`, cookie: sensitive.session },
        },
        body: { password: sensitive.password, newPassword: "n", currentPassword: "c" },
        result: { token: sensitive.device, secret: "s" },
        deep: { a: { b: { token: sensitive.deep } } },
      },
      "check",
    );
    const output = lines.join("");
    for (const value of Object.values(sensitive)) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('"msg":"check"');
  });
});

describe("config", () => {
  const base = {
    DATABASE_URL: "postgres://loomcast:loomcast@127.0.0.1:55434/loomcast",
    APP_ORIGIN: "http://localhost:5173/",
    PUBLIC_BASE_URL: "https://media.example.com",
  };

  it("applies defaults and normalises the origin", () => {
    expect(parseConfig(base)).toMatchObject({
      appOrigin: "http://localhost:5173",
      port: 8790,
      host: "127.0.0.1",
      nodeEnv: "development",
      isProduction: false,
      logLevel: "info",
      webDistDir: null,
      trustProxy: false,
    });
  });

  it("binds every interface in production and resolves the web directory", () => {
    const config = parseConfig({
      ...base,
      NODE_ENV: "production",
      WEB_DIST_DIR: "web/dist",
      TRUST_PROXY: "true",
      API_PORT: "9000",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      isProduction: true,
      port: 9000,
      trustProxy: true,
    });
    expect(config.webDistDir?.endsWith("/web/dist")).toBe(true);
  });

  it("lists every problem", () => {
    try {
      parseConfig({ DATABASE_URL: "mysql://x", APP_ORIGIN: "nope", API_PORT: "70000" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues } = error as ConfigError;
      expect(issues.map((issue) => issue.split(":")[0])).toEqual(
        expect.arrayContaining(["DATABASE_URL", "APP_ORIGIN", "API_PORT", "PUBLIC_BASE_URL"]),
      );
    }
  });
});
