import { hash, verify } from "@node-rs/argon2";
import { randomToken } from "./crypto";

/**
 * argon2id with the parameters from the security model: m = 19456 KiB, t = 2, p = 1. `algorithm`
 * is the numeric value of `Algorithm.Argon2id`; the package's const enum is not usable under
 * `isolatedModules`.
 */
export const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * False for a wrong password and for a malformed stored hash. Also false when the account has no
 * password yet (an invited user who has not used their link); that case spends the same time as a
 * real check.
 */
export async function verifyPassword(
  passwordHash: string | null,
  password: string,
): Promise<boolean> {
  if (passwordHash === null) {
    return verifyDummyPassword(password);
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Spends the same time as a real check when the account does not exist, so the response time of
 * a failed login does not reveal which emails have accounts. Always resolves to false.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomToken());
  await verifyPassword(await dummyHash, password);
  return false;
}
