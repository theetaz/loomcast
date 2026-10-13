import { type OAuthProvider, routes } from "@loomcast/contracts";

/**
 * The redirect URI of `provider`: `<redirect base>/api/oauth/<provider>/callback`. It must be
 * registered with the platform's app exactly as built here.
 */
export function oauthRedirectUri(redirectBase: string, provider: OAuthProvider): string {
  const path = routes["oauth.callback"].path.replace(":provider", provider);
  return `${redirectBase.replace(/\/+$/, "")}${path}`;
}
