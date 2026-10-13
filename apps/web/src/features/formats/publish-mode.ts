import type { PublishMode } from "@loomcast/contracts";

/** What each publish mode is called and what it does, for the editor and the series page. */
export const PUBLISH_MODE_COPY: Record<PublishMode, { label: string; explanation: string }> = {
  approval: {
    label: "Wait for approval",
    explanation:
      "Every video waits in Review until someone approves it. Nothing publishes on its own.",
  },
  auto: {
    label: "Publish automatically",
    explanation:
      "A rendered video is approved by the system when it reaches review and publishes at its slot. Channels that require approval still wait for a person.",
  },
};
