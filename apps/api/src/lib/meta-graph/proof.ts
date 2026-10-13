import { createHmac } from "node:crypto";

/**
 * The `appsecret_proof` of a Graph API call: the HMAC-SHA256 of the access token keyed with the
 * app secret, as lowercase hex. With "Require app secret" on, Meta refuses calls without it, so a
 * leaked token is useless without the secret.
 */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken, "utf8").digest("hex");
}

/** The app access token `<app-id>|<app-secret>`, for `debug_token` and app-level reads. */
export function appAccessToken(appId: string, appSecret: string): string {
  return `${appId}|${appSecret}`;
}
