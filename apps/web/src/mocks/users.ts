import {
  type ApiError,
  InspectPasswordTokenRequestSchema,
  PASSWORD_TOKEN_TTL_MS,
  type PasswordTokenInfo,
  type PasswordTokenPurpose,
  routes,
  SetPasswordRequestSchema,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import type { MockDb, MockPasswordToken } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const badLink = () => apiError(404, "not_found", "This link is invalid, used or expired.");

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A URL-safe set-password token, generated per call so no token-shaped literal lives anywhere. */
export function mockPasswordToken(length = 43): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => BASE62[byte % BASE62.length]).join("");
}

/** The link the API hands out: the token travels in the fragment, never to the server. */
export function setPasswordUrl(token: string): string {
  const origin = globalThis.location?.origin ?? "http://localhost";
  return `${origin}/set-password#token=${token}`;
}

function isUsable(entry: MockPasswordToken, now = Date.now()): boolean {
  return entry.usedAt === null && Date.parse(entry.expiresAt) > now;
}

/** Hands out a new link for `userId`; the user's earlier unused links stop working, as in the API. */
export function issuePasswordToken(
  db: MockDb,
  userId: string,
  purpose: PasswordTokenPurpose,
  now = Date.now(),
): MockPasswordToken {
  const at = new Date(now).toISOString();
  for (const entry of db.passwordTokens) {
    if (entry.userId === userId && entry.usedAt === null) entry.usedAt = at;
  }
  const entry: MockPasswordToken = {
    token: mockPasswordToken(),
    userId,
    purpose,
    expiresAt: new Date(now + PASSWORD_TOKEN_TTL_MS[purpose]).toISOString(),
    usedAt: null,
  };
  db.passwordTokens.push(entry);
  return entry;
}

function findUsable(db: MockDb, token: string): MockPasswordToken | undefined {
  return db.passwordTokens.find((entry) => entry.token === token && isUsable(entry));
}

function emailOf(db: MockDb, userId: string): string | undefined {
  if (userId === db.user.id) return db.user.email;
  return db.members.find((member) => member.id === userId)?.email;
}

/** The public set-password routes, following the contracts. */
export function createUserHandlers(db: MockDb) {
  return [
    http.post(path("auth.inspectPasswordToken"), async ({ request }) => {
      const parsed = InspectPasswordTokenRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return badLink();
      const entry = findUsable(db, parsed.data.token);
      const email = entry ? emailOf(db, entry.userId) : undefined;
      if (!entry || !email) return badLink();
      const body: PasswordTokenInfo = {
        email,
        purpose: entry.purpose,
        expiresAt: entry.expiresAt,
      };
      return HttpResponse.json(body);
    }),

    http.post(path("auth.setPassword"), async ({ request }) => {
      const parsed = SetPasswordRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return apiError(400, "validation_failed", "Choose a password of at least 12 characters.");
      }
      const entry = findUsable(db, parsed.data.token);
      if (!entry) return badLink();
      entry.usedAt = new Date().toISOString();
      if (entry.userId === db.user.id) {
        db.password = parsed.data.newPassword;
        db.signedIn = false;
      }
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}
