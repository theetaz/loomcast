import type { OAuthProvider } from "@loomcast/contracts";
import { metaProvider } from "./meta";
import { threadsProvider } from "./threads";
import type { OAuthProviderAdapter, OAuthProviderDeps, OAuthProviderFactory } from "./types";
import { xProvider } from "./x";

// The sign-in providers registry: one file per provider, one line each here. A provider missing
// from the list, or one that reports itself unavailable (X while its feature flag is off), is
// offered as not configured.

export const oauthProviderFactories: Readonly<
  Partial<Record<OAuthProvider, OAuthProviderFactory>>
> = Object.freeze({
  meta: metaProvider,
  threads: threadsProvider,
  x: xProvider,
});

export type OAuthProviders = Readonly<Partial<Record<OAuthProvider, OAuthProviderAdapter>>>;

/** Builds every registered provider. */
export function createOAuthProviders(deps: OAuthProviderDeps): OAuthProviders {
  const providers: Partial<Record<OAuthProvider, OAuthProviderAdapter>> = {};
  for (const [provider, factory] of Object.entries(oauthProviderFactories) as [
    OAuthProvider,
    OAuthProviderFactory,
  ][]) {
    providers[provider] = factory(deps);
  }
  return providers;
}
