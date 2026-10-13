import { CHANNEL_NAME_MAX_LENGTH, CHANNEL_USERNAME_MAX_LENGTH } from "@loomcast/contracts";

/** A candidate's name: trimmed, cut to the channel name limit, never empty. */
export function candidateName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  return (trimmed === "" ? fallback : trimmed).slice(0, CHANNEL_NAME_MAX_LENGTH);
}

/** A handle cut to the username limit, or undefined when there is none. */
export function candidateUsername(username: string | undefined): string | undefined {
  const trimmed = username?.trim();
  return trimmed === undefined || trimmed === ""
    ? undefined
    : trimmed.slice(0, CHANNEL_USERNAME_MAX_LENGTH);
}
