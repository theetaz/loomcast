import { type JsonObject, TOKEN_REFRESH_LEAD_MS } from "@loomcast/contracts";
import { channels, type Database } from "@loomcast/db";
import { eq, sql } from "drizzle-orm";
import type { XAppConfig } from "../../../../env";
import { audit } from "../../../../lib/audit";
import { transaction } from "../../../../lib/db";
import { channelAad, sealedSecretOf, type TokenVault } from "../../../../lib/vault";
import { PublishFailure } from "../../errors";
import type { XClient } from "./client";
import { refreshXToken } from "./oauth";

// X access tokens live two hours and refresh tokens are single use: each refresh returns a new
// pair and spends the old refresh token. So a refresh runs under a row lock on the channel, reads
// the stored pair again inside the lock (another worker may have refreshed it meanwhile), calls X,
// and writes the new pair as one sealed value in the same transaction. Two refreshes of one
// channel can therefore never spend the same refresh token twice, and the pair is never half
// stored.

/** Refresh when less than this remains (10 minutes). */
export const X_TOKEN_REFRESH_LEAD_MS: number = TOKEN_REFRESH_LEAD_MS.x;

/** Where X credentials are read from and written back to. */
export interface XTokenStore {
  db: Database;
  vault: TokenVault;
}

export interface FreshXToken {
  accessToken: string;
  /** True when this call rotated the pair. */
  refreshed: boolean;
  expiresAt: Date | null;
}

function refusal(message: string): PublishFailure {
  return PublishFailure.of("auth", message, { retryable: false });
}

/**
 * The channel's access token, refreshed first when it expires within `X_TOKEN_REFRESH_LEAD_MS`
 * (or `force`). Throws `PublishFailure` (`not_configured` for a channel without credentials,
 * `auth` when they cannot be refreshed) or the `XApiError` of the refresh call; on any failure
 * nothing is written, so the stored pair stays as it was.
 */
export async function freshXAccessToken(
  store: XTokenStore,
  input: {
    client: XClient;
    app: XAppConfig;
    channelId: string;
    now: Date;
    force?: boolean;
    signal?: AbortSignal | undefined;
  },
): Promise<FreshXToken> {
  return transaction(store.db, async (tx) => {
    const [row] = await tx
      .select({
        secretCiphertext: channels.secretCiphertext,
        secretNonce: channels.secretNonce,
        keyVersion: channels.keyVersion,
        tokenExpiresAt: channels.tokenExpiresAt,
        platform: channels.platform,
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .for("update");
    const sealed = row === undefined ? null : sealedSecretOf(row);
    if (row === undefined || sealed === null) {
      throw PublishFailure.of("not_configured", "The channel is not connected.", {
        retryable: false,
      });
    }
    const secret = store.vault.decrypt(sealed, channelAad(input.channelId));
    const accessToken = typeof secret.accessToken === "string" ? secret.accessToken : "";
    const refreshToken = typeof secret.refreshToken === "string" ? secret.refreshToken : "";
    const expiresAt = row.tokenExpiresAt;
    const due =
      input.force === true ||
      accessToken === "" ||
      (expiresAt !== null && expiresAt.getTime() - input.now.getTime() < X_TOKEN_REFRESH_LEAD_MS);
    if (!due) {
      return { accessToken, refreshed: false, expiresAt };
    }
    if (refreshToken === "") {
      throw refusal("The X channel has no refresh token; reconnect it.");
    }
    const pair = await refreshXToken(input.client, input.app, {
      refreshToken,
      now: input.now,
      signal: input.signal,
    });
    const next: JsonObject = {
      ...secret,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    };
    const resealed = store.vault.encrypt(next, channelAad(input.channelId));
    await tx
      .update(channels)
      .set({
        ...resealed,
        tokenExpiresAt: pair.expiresAt,
        scopes: pair.scopes,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(channels.id, input.channelId));
    await audit(tx, {
      actorKind: "system",
      action: "channel.token_refreshed",
      targetType: "channel",
      targetId: input.channelId,
      data: { platform: row.platform, tokenExpiresAt: pair.expiresAt.toISOString() },
    });
    return { accessToken: pair.accessToken, refreshed: true, expiresAt: pair.expiresAt };
  });
}

/** Keeps the latest X rate-limit headers on the channel (`channels.rate_limit`). */
export async function saveXRateLimit(
  store: XTokenStore,
  channelId: string,
  snapshot: JsonObject,
): Promise<void> {
  await store.db.update(channels).set({ rateLimit: snapshot }).where(eq(channels.id, channelId));
}
