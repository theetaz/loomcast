import { type Device, PAIRING_CODE_TTL_MS, type PairRequest } from "@loomcast/contracts";
import { type DeviceRow, devices, pairingCodes, users } from "@loomcast/db";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import type { ModuleDeps } from "../../deps";
import { audit } from "../../lib/audit";
import { afterCommit, isUniqueViolation, transaction } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import { generatePairingCode, hashPairingCode } from "./codes";

/** Attempts at drawing a code whose hash is not taken yet. A clash is already very unlikely. */
const CODE_ATTEMPTS = 3;

/** One answer for unknown, used and expired codes, so a guesser learns nothing from it. */
const INVALID_CODE_MESSAGE = "The pairing code is invalid, already used or expired.";

/** Why a pairing attempt was refused. Only written to the audit log, never to the response. */
export type PairFailureReason = "unknown_code" | "used" | "expired" | "user_disabled";

export class PairingRefusedError extends HttpError {
  constructor(readonly reason: PairFailureReason) {
    super(401, "unauthorized", INVALID_CODE_MESSAGE);
    this.name = "PairingRefusedError";
  }
}

export interface CreatedPairingCode {
  id: string;
  /** The code in clear text. Returned to the caller once; only its hash is stored. */
  code: string;
  expiresAt: Date;
}

export interface PairedDevice {
  device: DeviceRow;
  /** The device token. Returned to the studio agent once; only its hash is stored. */
  secret: string;
  /** The user who created the pairing code and now owns the device token. */
  pairedBy: string;
}

export interface RevokeDeviceResult {
  device: DeviceRow;
  /** False when the device was already revoked. */
  revoked: boolean;
}

export interface DevicesService {
  createPairingCode(userId: string, context: { ip: string }): Promise<CreatedPairingCode>;
  /**
   * Redeems a pairing code for a device and its token. The code is claimed with one conditional
   * update, so two concurrent requests with the same code cannot both succeed. Throws
   * `PairingRefusedError` for an unknown, used or expired code.
   */
  pair(input: PairRequest, context: { ip: string }): Promise<PairedDevice>;
  /** Devices that are not revoked, newest first, with their live connection state. */
  list(): Promise<Device[]>;
  /**
   * Revokes a device and its token, then publishes `device.revoked` (the bridge closes the socket)
   * and `device.status`. Null when no device has the id.
   */
  revoke(id: string, context: { userId: string; ip: string }): Promise<RevokeDeviceResult | null>;
}

export function toDevice(row: DeviceRow, online: boolean): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    agentVersion: row.agentVersion,
    online: online && row.revokedAt === null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

type ServiceDeps = Pick<ModuleDeps, "db" | "bus" | "clock" | "tokens" | "presence">;

export function createDevicesService(deps: ServiceDeps): DevicesService {
  const { db, bus, clock, tokens, presence } = deps;

  async function failureReason(codeHash: string): Promise<PairFailureReason> {
    const [row] = await db
      .select({ usedAt: pairingCodes.usedAt })
      .from(pairingCodes)
      .where(eq(pairingCodes.codeHash, codeHash))
      .limit(1);
    if (row === undefined) {
      return "unknown_code";
    }
    return row.usedAt === null ? "expired" : "used";
  }

  return {
    async createPairingCode(userId, context) {
      for (let attempt = 1; ; attempt++) {
        const now = clock.now();
        const code = generatePairingCode();
        const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
        try {
          return await transaction(db, async (tx) => {
            // Expired codes that were never used are of no further use, even for auditing.
            await tx
              .delete(pairingCodes)
              .where(
                and(
                  eq(pairingCodes.createdBy, userId),
                  isNull(pairingCodes.usedAt),
                  lte(pairingCodes.expiresAt, now),
                ),
              );
            const [row] = await tx
              .insert(pairingCodes)
              .values({
                codeHash: hashPairingCode(code),
                createdBy: userId,
                expiresAt,
                createdAt: now,
              })
              .returning({ id: pairingCodes.id });
            if (row === undefined) {
              throw new Error("pairing code was not inserted");
            }
            await audit(tx, {
              actorKind: "user",
              actorId: userId,
              action: "device.pairing_code.created",
              targetType: "pairing_code",
              targetId: row.id,
              data: { expiresAt: expiresAt.toISOString() },
              ip: context.ip,
            });
            return { id: row.id, code, expiresAt };
          });
        } catch (error) {
          if (attempt < CODE_ATTEMPTS && isUniqueViolation(error, "pairing_codes_code_hash_uq")) {
            continue;
          }
          throw error;
        }
      }
    },

    async pair(input, context) {
      const codeHash = hashPairingCode(input.code);
      try {
        return await transaction(db, async (tx) => {
          const now = clock.now();
          const [code] = await tx
            .update(pairingCodes)
            .set({ usedAt: now })
            .where(
              and(
                eq(pairingCodes.codeHash, codeHash),
                isNull(pairingCodes.usedAt),
                gt(pairingCodes.expiresAt, now),
              ),
            )
            .returning();
          if (code === undefined) {
            throw new PairingRefusedError("unknown_code");
          }

          const [creator] = await tx
            .select({ disabledAt: users.disabledAt })
            .from(users)
            .where(eq(users.id, code.createdBy))
            .limit(1);
          if (creator === undefined || creator.disabledAt !== null) {
            // Rolls back the claim; the code stays unusable while its creator is disabled.
            throw new PairingRefusedError("user_disabled");
          }

          const created = await tokens.create(
            { userId: code.createdBy, kind: "device", name: input.name, scopes: ["bridge"] },
            tx,
          );
          const [device] = await tx
            .insert(devices)
            .values({
              name: input.name,
              platform: input.platform,
              agentVersion: input.agentVersion,
              tokenId: created.row.id,
              createdBy: code.createdBy,
              createdAt: now,
            })
            .returning();
          if (device === undefined) {
            throw new Error("device was not inserted");
          }
          await tx
            .update(pairingCodes)
            .set({ deviceId: device.id })
            .where(eq(pairingCodes.id, code.id));
          await audit(tx, {
            actorKind: "device",
            actorId: device.id,
            action: "device.paired",
            targetType: "device",
            targetId: device.id,
            data: {
              name: device.name,
              platform: device.platform,
              agentVersion: input.agentVersion,
              pairedBy: code.createdBy,
              tokenId: created.row.id,
              pairingCodeId: code.id,
            },
            ip: context.ip,
          });
          return { device, secret: created.secret, pairedBy: code.createdBy };
        });
      } catch (error) {
        if (error instanceof PairingRefusedError) {
          const reason =
            error.reason === "unknown_code" ? await failureReason(codeHash) : error.reason;
          await audit(db, {
            actorKind: "device",
            action: "device.pair.failed",
            data: { reason },
            ip: context.ip,
          });
          throw new PairingRefusedError(reason);
        }
        throw error;
      }
    },

    async list() {
      const online = presence.connectedDevices();
      const rows = await db
        .select()
        .from(devices)
        .where(isNull(devices.revokedAt))
        .orderBy(desc(devices.createdAt), desc(devices.id));
      return rows.map((row) => toDevice(row, online.has(row.id)));
    },

    async revoke(id, context) {
      return transaction(db, async (tx) => {
        const now = clock.now();
        const [revoked] = await tx
          .update(devices)
          .set({ revokedAt: now })
          .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
          .returning();
        if (revoked === undefined) {
          const [existing] = await tx.select().from(devices).where(eq(devices.id, id)).limit(1);
          return existing === undefined ? null : { device: existing, revoked: false };
        }

        await tokens.revoke(revoked.tokenId, { kind: "device", executor: tx });
        await audit(tx, {
          actorKind: "user",
          actorId: context.userId,
          action: "device.revoked",
          targetType: "device",
          targetId: revoked.id,
          data: { name: revoked.name, tokenId: revoked.tokenId },
          ip: context.ip,
        });
        afterCommit(tx, () => {
          bus.publish({
            type: "device.revoked",
            payload: { deviceId: revoked.id, tokenId: revoked.tokenId },
          });
          bus.publish({
            type: "device.status",
            payload: {
              deviceId: revoked.id,
              online: false,
              lastSeenAt: revoked.lastSeenAt?.toISOString() ?? null,
            },
          });
        });
        return { device: revoked, revoked: true };
      });
    },
  };
}
