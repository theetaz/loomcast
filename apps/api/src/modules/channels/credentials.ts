import type { JsonObject, OAuthProvider } from "@loomcast/contracts";
import { channels } from "@loomcast/db";
import { eq } from "drizzle-orm";
import type { Executor } from "../../lib/db";
import { channelAad, type SealedSecret, sealedSecretOf, type TokenVault } from "../../lib/vault";

// What a connected channel stores in its sealed secret. The publisher reads `accessToken`; the
// token tasks also read `provider`. Platform values the adapters need besides the token (such as
// an Instagram account's `pageId`) sit next to it. Never log or return any of it.

export interface StoredChannelSecret {
  accessToken: string;
  provider: OAuthProvider;
  [key: string]: string;
}

/** The sealed form of a channel's credentials, bound to the channel row. */
export function sealChannelSecret(
  vault: TokenVault,
  channelId: string,
  secret: StoredChannelSecret,
): SealedSecret {
  return vault.encrypt(secret as JsonObject, channelAad(channelId));
}

/**
 * The decrypted credentials of a channel, or null when it has none. Throws `VaultError` when they
 * cannot be decrypted, and the vault's 503 when no key is configured.
 */
export async function readChannelSecret(
  executor: Executor,
  vault: TokenVault,
  channelId: string,
): Promise<StoredChannelSecret | null> {
  const [row] = await executor
    .select({
      secretCiphertext: channels.secretCiphertext,
      secretNonce: channels.secretNonce,
      keyVersion: channels.keyVersion,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  const sealed = row === undefined ? null : sealedSecretOf(row);
  if (sealed === null) {
    return null;
  }
  const value = vault.decrypt(sealed, channelAad(channelId));
  if (typeof value.accessToken !== "string" || value.accessToken === "") {
    return null;
  }
  const secret: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      secret[key] = entry;
    }
  }
  return secret as StoredChannelSecret;
}
