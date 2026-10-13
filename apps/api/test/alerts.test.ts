import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "@loomcast/db/testing";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RegisterModule } from "../src/deps";
import { ConfigError, parseConfig } from "../src/env";
import {
  ALERT_DEDUPE_MS,
  type Alert,
  type AlertFormat,
  alertRequest,
  createAlerts,
} from "../src/lib/alerts";
import { createLogger } from "../src/lib/logger";
import type { AppEnv } from "../src/types";
import { createTestApp, createTestClock } from "./support";

interface ReceivedHook {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** An in-process webhook receiver. Each test gets a fresh random path, like a real hook URL. */
interface HookReceiver {
  base: string;
  received: ReceivedHook[];
  status: number;
  close(): Promise<void>;
}

async function startReceiver(): Promise<HookReceiver> {
  const state = { status: 200, received: [] as ReceivedHook[] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      state.received.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(state.status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    get received() {
      return state.received;
    },
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function hookUrl(receiver: HookReceiver): string {
  return `${receiver.base}/hooks/${randomUUID()}`;
}

function capture(): { logs: string[]; logger: ReturnType<typeof createLogger> } {
  const logs: string[] = [];
  const logger = createLogger({
    level: "trace",
    destination: { write: (line: string) => void logs.push(line) },
  });
  return { logs, logger };
}

const SAMPLE: Alert = {
  key: "task.dead:00000000-0000-4000-8000-000000000001",
  title: "scheduled task is dead",
  message: "Task post.publish failed 5 time(s) and will not run again until retried.",
  data: { kind: "post.publish", attempts: 5 },
};

let receiver: HookReceiver;

beforeAll(async () => {
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
});

beforeEach(() => {
  receiver.received.length = 0;
  receiver.status = 200;
});

describe("alert formats", () => {
  const at = new Date("2026-10-13T08:00:00.000Z");

  it("json posts the key, title, message, data and time", () => {
    const request = alertRequest(SAMPLE, "json", at);
    expect(request.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(request.body)).toEqual({
      source: "loomcast-api",
      key: SAMPLE.key,
      level: "error",
      title: SAMPLE.title,
      message: SAMPLE.message,
      data: SAMPLE.data,
      at: at.toISOString(),
    });
  });

  it("ntfy sends the message as text with title, priority and tags headers", () => {
    const request = alertRequest(SAMPLE, "ntfy", at);
    expect(request.body).toBe(SAMPLE.message);
    expect(request.headers).toMatchObject({
      Title: SAMPLE.title,
      Priority: "high",
      Tags: "loomcast,task.dead",
    });
  });

  it("ntfy encodes a title that is not plain ASCII and drops line breaks", () => {
    const request = alertRequest({ ...SAMPLE, title: "Backup — stale\r\nnow" }, "ntfy", at);
    const title = request.headers.Title ?? "";
    expect(title).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const encoded = title.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Backup — stale now");
  });

  it("slack sends a text field with the title in bold and markup escaped", () => {
    const request = alertRequest({ ...SAMPLE, message: "a <b> & c" }, "slack", at);
    expect(JSON.parse(request.body)).toEqual({
      text: "*scheduled task is dead*\na &lt;b&gt; &amp; c",
    });
  });
});

describe("webhook alerts", () => {
  function alertsFor(format: AlertFormat, url: string | null = hookUrl(receiver)) {
    const clock = createTestClock(new Date("2026-10-13T08:00:00.000Z"));
    const { logs, logger } = capture();
    return {
      clock,
      logs,
      url,
      alerts: createAlerts({ config: { webhookUrl: url, format }, clock, logger }),
    };
  }

  it("delivers an alert to the webhook and logs it", async () => {
    const { alerts, logs, url } = alertsFor("json");
    expect(alerts.configured).toBe(true);
    expect(await alerts.send(SAMPLE)).toBe("sent");
    expect(receiver.received).toHaveLength(1);
    const [hook] = receiver.received;
    expect(hook?.path).toBe(new URL(url ?? "").pathname);
    expect(hook?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(hook?.body ?? "{}")).toMatchObject({ key: SAMPLE.key, title: SAMPLE.title });
    expect(logs.some((line) => line.includes(SAMPLE.key))).toBe(true);
  });

  it("sends each key at most once an hour", async () => {
    const { alerts, clock } = alertsFor("ntfy");
    expect(await alerts.send(SAMPLE)).toBe("sent");
    clock.advance(ALERT_DEDUPE_MS - 1);
    expect(await alerts.send(SAMPLE)).toBe("suppressed");
    expect(await alerts.send({ ...SAMPLE, key: "post.failed:other" })).toBe("sent");
    expect(receiver.received).toHaveLength(2);

    clock.advance(1);
    expect(await alerts.send(SAMPLE)).toBe("sent");
    expect(receiver.received).toHaveLength(3);
    expect(receiver.received[0]?.body).toBe(SAMPLE.message);
    expect(receiver.received[0]?.headers.title).toBe(SAMPLE.title);
  });

  it("only logs when no webhook is configured", async () => {
    const { alerts, logs } = alertsFor("json", null);
    expect(alerts.configured).toBe(false);
    expect(await alerts.send(SAMPLE)).toBe("logged");
    expect(await alerts.send(SAMPLE)).toBe("suppressed");
    expect(receiver.received).toHaveLength(0);
    const line = logs.find((entry) => entry.includes(SAMPLE.key));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({ level: 50, alert: SAMPLE.key });
  });

  it("retries a refused delivery on the next occurrence and never logs the URL", async () => {
    const { alerts, logs, url } = alertsFor("slack");
    receiver.status = 500;
    expect(await alerts.send(SAMPLE)).toBe("failed");
    receiver.status = 200;
    expect(await alerts.send(SAMPLE)).toBe("sent");
    expect(receiver.received).toHaveLength(2);
    expect(logs.some((line) => line.includes("http 500"))).toBe(true);
    const path = new URL(url ?? "").pathname;
    expect(logs.some((line) => line.includes(path))).toBe(false);
  });

  it("reports an unreachable webhook without the URL", async () => {
    const closed = await startReceiver();
    await closed.close();
    const url = hookUrl(closed);
    const { alerts, logs } = alertsFor("json", url);
    expect(await alerts.send(SAMPLE)).toBe("failed");
    const failure = logs.find((line) => line.includes("could not deliver"));
    expect(failure).toContain("ECONNREFUSED");
    expect(logs.some((line) => line.includes(new URL(url).pathname))).toBe(false);
  });

  it("redacts the webhook URL if a config object is logged", () => {
    const { logs, logger } = capture();
    const url = hookUrl(receiver);
    logger.info({ config: { alerts: { webhookUrl: url } }, ALERT_WEBHOOK_URL: url }, "config");
    expect(logs.join("")).not.toContain(new URL(url).pathname);
  });
});

describe("alerts in the app", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it("gives modules a de-duplicated alert hook wired to the webhook", async () => {
    const raised: Promise<void>[] = [];
    const module: RegisterModule = (app, deps) => {
      raised.push(deps.alert(SAMPLE), deps.alert(SAMPLE), deps.alert({ ...SAMPLE, key: "b" }));
      const router = new Hono<AppEnv>();
      app.route("/", router);
      return router;
    };
    createTestApp(testDb.db, {
      config: { storage: null, alerts: { webhookUrl: hookUrl(receiver), format: "json" } },
      modules: [module],
    });
    await Promise.all(raised);
    expect(receiver.received.map((hook) => JSON.parse(hook.body).key).sort()).toEqual(
      [SAMPLE.key, "b"].sort(),
    );
  });
});

describe("alert and ops settings", () => {
  const base = {
    DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
    APP_ORIGIN: "http://localhost:5173",
    PUBLIC_BASE_URL: "https://media.example.com",
  };

  function issues(env: Record<string, string>): string[] {
    try {
      parseConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).issues;
    }
    return [];
  }

  it("defaults to logging only, no commit and no backup directory", () => {
    const config = parseConfig(base);
    expect(config.alerts).toEqual({ webhookUrl: null, format: "json" });
    expect(config.gitSha).toBeNull();
    expect(config.backupDir).toBeNull();
    const empty = parseConfig({
      ...base,
      ALERT_WEBHOOK_URL: "",
      ALERT_WEBHOOK_FORMAT: "",
      LOOMCAST_GIT_SHA: "unknown",
      BACKUP_DIR: "",
    });
    expect(empty.alerts).toEqual({ webhookUrl: null, format: "json" });
    expect(empty.gitSha).toBeNull();
    expect(empty.backupDir).toBeNull();
  });

  it("reads the webhook, its format, the commit and the backup directory", () => {
    const url = hookUrl(receiver);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const config = parseConfig({
      ...base,
      ALERT_WEBHOOK_URL: url,
      ALERT_WEBHOOK_FORMAT: "ntfy",
      LOOMCAST_GIT_SHA: sha,
      BACKUP_DIR: "/backups",
    });
    expect(config.alerts).toEqual({ webhookUrl: url, format: "ntfy" });
    expect(config.gitSha).toBe(sha);
    expect(config.backupDir).toBe("/backups");
  });

  it("rejects an unknown format, a non-HTTP webhook and a relative backup directory", () => {
    expect(issues({ ...base, ALERT_WEBHOOK_FORMAT: "email" })[0]).toMatch(/^ALERT_WEBHOOK_FORMAT/);
    expect(issues({ ...base, ALERT_WEBHOOK_URL: "ftp://example.test/x" })[0]).toMatch(
      /^ALERT_WEBHOOK_URL/,
    );
    expect(issues({ ...base, BACKUP_DIR: "backups" })[0]).toMatch(/^BACKUP_DIR/);
    expect(issues({ ...base, LOOMCAST_GIT_SHA: "not a sha" })[0]).toMatch(/^LOOMCAST_GIT_SHA/);
  });

  it("never echoes the webhook URL in a validation message", () => {
    const messages = issues({ ...base, ALERT_WEBHOOK_URL: "not-a-url-with-a-private-part" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("private-part");
  });
});
