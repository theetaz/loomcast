import type { JsonObject } from "@loomcast/contracts";
import type { Clock } from "./clock";
import type { Logger } from "./logger";

/**
 * Something the owner should look at: a dead or failed scheduled task, a failed publish, a channel
 * that needs reauthorisation, a stale backup.
 */
export interface Alert {
  /**
   * Stable key, for de-duplication: `<kind>:<subject>`, for example `task.dead:<taskId>`,
   * `post.failed:<postId>`, `channel.reauth:<channelId>` or `backup.stale`.
   */
  key: string;
  title: string;
  message: string;
  /** Ids and codes only, never secrets. */
  data?: JsonObject;
}

export const ALERT_FORMATS = ["json", "ntfy", "slack"] as const;
export type AlertFormat = (typeof ALERT_FORMATS)[number];

export interface AlertsConfig {
  /** Where alerts are posted, or null to only log them. Holds a secret: never log it. */
  webhookUrl: string | null;
  /**
   * `json`: a JSON object for any webhook receiver. `ntfy`: a plain-text ntfy publish with title,
   * priority and tags headers. `slack`: a Slack-compatible incoming webhook (`{"text": ...}`).
   */
  format: AlertFormat;
}

/** An alert with the same key is sent at most once in this window. */
export const ALERT_DEDUPE_MS = 60 * 60 * 1000;

/** How long one webhook call may take. */
export const ALERT_TIMEOUT_MS = 10_000;

/** `sent`: delivered. `logged`: no webhook configured. `suppressed`: a duplicate. */
export type AlertResult = "sent" | "logged" | "suppressed" | "failed";

export interface Alerts {
  /** True when a webhook is configured. */
  readonly configured: boolean;
  readonly format: AlertFormat;
  /**
   * Logs the alert and posts it to the webhook, unless an alert with the same key went out within
   * the last hour. Never throws.
   */
  send(alert: Alert): Promise<AlertResult>;
}

export interface AlertsDeps {
  config: AlertsConfig;
  clock: Clock;
  logger: Logger;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const SOURCE = "loomcast-api";

/** Header values must be Latin-1; anything else is sent as an RFC 2047 encoded word. */
function headerValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(flat)) {
    return flat;
  }
  return `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/** The first segment of the key (`task.dead`), as an ntfy tag. */
function keyKind(key: string): string {
  const kind = key.split(":")[0] ?? "";
  const tag = kind.replace(/[^A-Za-z0-9._-]/g, "");
  return tag === "" ? "alert" : tag;
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The HTTP request that delivers `alert` in `format`. */
export function alertRequest(
  alert: Alert,
  format: AlertFormat,
  at: Date,
): { headers: Record<string, string>; body: string } {
  switch (format) {
    case "ntfy":
      return {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: headerValue(alert.title),
          Priority: "high",
          Tags: `loomcast,${keyKind(alert.key)}`,
        },
        body: alert.message,
      };
    case "slack":
      return {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `*${escapeSlack(alert.title)}*\n${escapeSlack(alert.message)}`,
        }),
      };
    default:
      return {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: SOURCE,
          key: alert.key,
          level: "error",
          title: alert.title,
          message: alert.message,
          data: alert.data ?? {},
          at: at.toISOString(),
        }),
      };
  }
}

/** A failure reason that cannot contain the webhook URL. */
function failureReason(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (cause !== undefined && typeof cause?.code === "string") {
    return cause.code;
  }
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timeout" : error.name;
  }
  return "unknown";
}

/**
 * Webhook alerts with de-duplication per key. Without `ALERT_WEBHOOK_URL` every alert is still
 * logged at error level, so nothing is lost; the webhook only adds a push notification.
 */
export function createAlerts(deps: AlertsDeps): Alerts {
  const { config, clock, logger } = deps;
  const send = deps.fetch ?? fetch;
  const lastSent = new Map<string, number>();

  function forget(now: number): void {
    for (const [key, at] of lastSent) {
      if (now - at >= ALERT_DEDUPE_MS) {
        lastSent.delete(key);
      }
    }
  }

  return {
    configured: config.webhookUrl !== null,
    format: config.format,
    async send(alert) {
      const now = clock.now();
      forget(now.getTime());
      if (lastSent.has(alert.key)) {
        logger.debug({ alert: alert.key }, "duplicate alert suppressed");
        return "suppressed";
      }
      lastSent.set(alert.key, now.getTime());
      logger.error(
        { alert: alert.key, title: alert.title, data: alert.data ?? {} },
        `alert: ${alert.message}`,
      );
      if (config.webhookUrl === null) {
        return "logged";
      }
      const request = alertRequest(alert, config.format, now);
      try {
        const response = await send(config.webhookUrl, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
        });
        await response.body?.cancel();
        if (!response.ok) {
          throw Object.assign(new Error("webhook refused"), { status: response.status });
        }
        return "sent";
      } catch (error) {
        // Let the next occurrence try again.
        lastSent.delete(alert.key);
        const status = (error as { status?: unknown } | null)?.status;
        logger.error(
          {
            alert: alert.key,
            reason: typeof status === "number" ? `http ${status}` : failureReason(error),
          },
          "could not deliver an alert to the webhook",
        );
        return "failed";
      }
    },
  };
}
