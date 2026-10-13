import { type OAuthProvider, oauthStartPath } from "@loomcast/contracts";

/** Leaves the app for `url`. Tests and mock mode replace it; the app only calls it here. */
export type PageNavigator = (url: string) => void;

const leavePage: PageNavigator = (url) => window.location.assign(url);
let navigatePage: PageNavigator = leavePage;

/** Replaces how a sign-in leaves the page; `null` restores the full-page navigation. */
export function setOAuthNavigator(next: PageNavigator | null) {
  navigatePage = next ?? leavePage;
}

/** Where a sign-in returns once the accounts are connected. */
export const CONNECT_RETURN_PATH = "/settings/channels";

/**
 * Starts a sign-in with `provider`: a full-page navigation to `oauth.start`, which redirects to
 * the platform's consent dialog and later back to the connect page.
 */
export function startOAuth(provider: OAuthProvider) {
  navigatePage(oauthStartPath(provider, { redirectTo: CONNECT_RETURN_PATH }));
}
