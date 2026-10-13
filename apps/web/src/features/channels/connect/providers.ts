import type { OAuthConnectError, OAuthProvider, Platform } from "@loomcast/contracts";

// The sign-ins Loomcast offers, in the order the product lists them: X last, behind its flag.

interface ProviderMeta {
  /** What the sign-in connects, as the connect menu says it. */
  label: string;
  /** The platform the user signs in with. */
  signIn: string;
  /** The platform whose colour marks the option. */
  platform: Platform;
  /** One line under the label. */
  hint: string;
}

export const PROVIDER_META: Record<OAuthProvider, ProviderMeta> = {
  meta: {
    label: "Facebook Page and Instagram",
    signIn: "Facebook",
    platform: "facebook",
    hint: "Pages and their linked Instagram accounts",
  },
  threads: {
    label: "Threads",
    signIn: "Threads",
    platform: "threads",
    hint: "A Threads profile",
  },
  x: { label: "X", signIn: "X", platform: "x", hint: "An X account" },
};

/** The providers the connect menu offers: X only while X publishing is on. */
export function connectProviders(xPublishing: boolean): OAuthProvider[] {
  return xPublishing ? ["meta", "threads", "x"] : ["meta", "threads"];
}

/** What went wrong with a sign-in, as a title and a sentence. */
export function connectErrorText(
  error: OAuthConnectError,
  provider: OAuthProvider | undefined,
): { title: string; description: string } {
  const platform = provider ? PROVIDER_META[provider].signIn : "the platform";
  switch (error) {
    case "access_denied":
      return {
        title: "Sign-in cancelled",
        description: `The sign-in with ${platform} was cancelled or its permissions were declined. Nothing was connected.`,
      };
    case "invalid_state":
      return {
        title: "This sign-in has expired",
        description:
          "It took too long, was already used or was started in another session. Nothing was connected; sign in again.",
      };
    case "provider_error":
      return {
        title: `${provider ? PROVIDER_META[provider].signIn : "The platform"} didn't confirm the sign-in`,
        description: "Nothing was connected. Try again in a moment.",
      };
    case "no_accounts":
      return {
        title: "No accounts to connect",
        description:
          provider === "meta"
            ? "The sign-in can't publish as any Facebook Page or Instagram professional account. Sign in again and grant access to at least one Page."
            : `The sign-in can't publish as any ${platform} account.`,
      };
    case "not_configured":
      return {
        title:
          provider === "x" ? "Publishing to X is off" : `${platform} isn't set up on this server`,
        description:
          provider === "x"
            ? "This server doesn't offer X yet, so X accounts can't be connected."
            : "The server has no app credentials for this platform yet. Ask the workspace owner to add them.",
      };
  }
}
