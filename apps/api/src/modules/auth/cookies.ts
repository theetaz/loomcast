import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../../env";
import type { AppEnv } from "../../types";

/** `__Host-` binds the cookie to the exact origin over HTTPS; plain HTTP in development cannot use it. */
export function sessionCookieName(config: Pick<Config, "isProduction">): string {
  return config.isProduction ? "__Host-lc_session" : "lc_session";
}

function cookieOptions(config: Pick<Config, "isProduction">) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax",
  } as const;
}

export function readSessionCookie(
  c: Context<AppEnv>,
  config: Pick<Config, "isProduction">,
): string | undefined {
  return getCookie(c, sessionCookieName(config));
}

export function setSessionCookie(
  c: Context<AppEnv>,
  config: Pick<Config, "isProduction">,
  token: string,
  expiresAt: Date,
  now: Date,
): void {
  setCookie(c, sessionCookieName(config), token, {
    ...cookieOptions(config),
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
  });
}

export function clearSessionCookie(c: Context<AppEnv>, config: Pick<Config, "isProduction">): void {
  deleteCookie(c, sessionCookieName(config), cookieOptions(config));
}
