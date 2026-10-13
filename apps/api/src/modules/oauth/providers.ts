import type { OAuthProvider } from "@loomcast/contracts";
import { metaProvider } from "./meta";
import { threadsProvider } from "./threads";
import type { OAuthProviderAdapter, OAuthProviderDeps, OAuthProviderFactory } from "./types";

// The sign-in providers registry: one file per provider, one line each here. A provider missing
// from the list (X until its adapter ships) is offered as not configured.

export const oauthProviderFactories: Readonly<
  Partial<Record<OAuthProvider, OAuthProviderFactory>>
> = Object.freeze({
  meta: metaProvider,
  threads: threadsProvider,
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
