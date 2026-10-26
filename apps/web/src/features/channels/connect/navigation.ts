import { type OAuthProvider, oauthStartPath, type Workspace } from "@loomcast/contracts";

/** Leaves the app for `url`. Tests and mock mode replace it; the app only calls it here. */
export type PageNavigator = (url: string) => void;

const leavePage: PageNavigator = (url) => window.location.assign(url);
let navigatePage: PageNavigator = leavePage;

/** Replaces how a sign-in leaves the page; `null` restores the full-page navigation. */
export function setOAuthNavigator(next: PageNavigator | null) {
  navigatePage = next ?? leavePage;
}

/**
 * The workspace a sign-in started in, by id, kept for the tab's session so the connect page can
 * offer it first. The server's callback only carries the connection.
 */
export const CONNECT_WORKSPACE_KEY = "loomcast.connect.workspace";

export function readConnectWorkspace(): string | null {
  try {
    return window.sessionStorage.getItem(CONNECT_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function rememberConnectWorkspace(id: string) {
  try {
    window.sessionStorage.setItem(CONNECT_WORKSPACE_KEY, id);
  } catch {
    // Blocked storage: the connect page then offers the most recent workspace first.
  }
}

/** Where a sign-in returns once the accounts are connected: the workspace's channel settings. */
export function connectReturnPath(workspace: Pick<Workspace, "slug">): string {
  return `/w/${workspace.slug}/settings/channels`;
}

/**
 * Starts a sign-in with `provider` for `workspace`: a full-page navigation to `oauth.start`, which
 * redirects to the platform's consent dialog and later back to the connect page.
 */
export function startOAuth(provider: OAuthProvider, workspace: Pick<Workspace, "id" | "slug">) {
  rememberConnectWorkspace(workspace.id);
  navigatePage(oauthStartPath(provider, { redirectTo: connectReturnPath(workspace) }));
}
