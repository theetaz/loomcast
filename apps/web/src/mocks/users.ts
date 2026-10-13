import {
  type ApiError,
  InspectPasswordTokenRequestSchema,
  InviteUserRequestSchema,
  type InviteUserResponse,
  type Me,
  PASSWORD_TOKEN_TTL_MS,
  type PasswordTokenInfo,
  type PasswordTokenPurpose,
  routes,
  SetPasswordRequestSchema,
  type UserSummary,
} from "@loomcast/contracts";
import { HttpResponse, http } from "msw";
import { type MockDb, type MockPasswordToken, mockId } from "./db";

const path = (name: keyof typeof routes) => `*${routes[name].path}`;

function apiError(status: number, code: string, message: string) {
  return HttpResponse.json<ApiError>({ error: { code, message } }, { status });
}

const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue.");
const forbidden = () => apiError(403, "forbidden", "Only the owner manages members.");
const noUser = () => apiError(404, "not_found", "No user has that id.");
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

export function userSummary(user: Me, disabledAt: string | null = null): UserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    disabledAt,
  };
}

export function mockMember(
  overrides: Partial<UserSummary> & Pick<UserSummary, "email" | "name">,
): UserSummary {
  return {
    id: mockId(),
    role: "admin",
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    disabledAt: null,
    ...overrides,
  };
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

/** The owner's member routes and the public set-password routes, following the contracts. */
export function createUserHandlers(db: MockDb) {
  const guard = () => {
    if (!db.signedIn) return unauthorized();
    if (db.user.role !== "owner") return forbidden();
    return null;
  };

  return [
    http.get(path("users.list"), () => {
      const denied = guard();
      if (denied) return denied;
      return HttpResponse.json({ items: [userSummary(db.user), ...db.members] });
    }),

    http.post(path("users.invite"), async ({ request }) => {
      const denied = guard();
      if (denied) return denied;
      const parsed = InviteUserRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return apiError(400, "validation_failed", "Check the email and name.");
      const { email, name, role } = parsed.data;
      if (role === "owner") {
        return apiError(400, "validation_failed", "There is only one owner.");
      }
      const taken = [db.user.email, ...db.members.map((member) => member.email)];
      if (taken.includes(email)) {
        return apiError(409, "conflict", "A user with this email already exists.");
      }
      const user = mockMember({ email, name, role });
      db.members.push(user);
      const link = issuePasswordToken(db, user.id, "invite");
      const body: InviteUserResponse = {
        user,
        setPasswordUrl: setPasswordUrl(link.token),
        expiresAt: link.expiresAt,
      };
      return HttpResponse.json(body, { status: 201 });
    }),

    http.post(path("users.resetLink"), ({ params }) => {
      const denied = guard();
      if (denied) return denied;
      const id = String(params.id);
      const user =
        id === db.user.id ? userSummary(db.user) : db.members.find((member) => member.id === id);
      if (!user) return noUser();
      if (user.disabledAt) return apiError(409, "conflict", "This account is disabled.");
      const link = issuePasswordToken(db, user.id, "reset");
      const body: InviteUserResponse = {
        user,
        setPasswordUrl: setPasswordUrl(link.token),
        expiresAt: link.expiresAt,
      };
      return HttpResponse.json(body, { status: 201 });
    }),

    http.post(path("users.disable"), ({ params }) => {
      const denied = guard();
      if (denied) return denied;
      const id = String(params.id);
      if (id === db.user.id) {
        return apiError(409, "conflict", "You cannot disable your own account.");
      }
      const user = db.members.find((member) => member.id === id);
      if (!user) return noUser();
      if (user.role === "owner") {
        return apiError(409, "conflict", "The owner's account cannot be disabled.");
      }
      if (!user.disabledAt) {
        const at = new Date().toISOString();
        user.disabledAt = at;
        for (const entry of db.passwordTokens) {
          if (entry.userId === user.id && entry.usedAt === null) entry.usedAt = at;
        }
      }
      return HttpResponse.json(user);
    }),

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

/** Demo members for `pnpm --filter @loomcast/web dev:mock`. */
export function demoMembers(now = Date.now()): UserSummary[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    mockMember({
      email: "kasun@loomcast.test",
      name: "Kasun Fernando",
      createdAt: ago(30 * 24 * 60),
      lastLoginAt: ago(40),
    }),
    mockMember({
      email: "mei.lin@loomcast.test",
      name: "Mei Lin",
      createdAt: ago(2 * 24 * 60),
    }),
    mockMember({
      email: "old.collaborator@loomcast.test",
      name: "Jonas Becker",
      createdAt: ago(90 * 24 * 60),
      lastLoginAt: ago(45 * 24 * 60),
      disabledAt: ago(20 * 24 * 60),
    }),
  ];
}
