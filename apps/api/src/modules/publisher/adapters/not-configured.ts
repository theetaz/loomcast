import type { Platform } from "@loomcast/contracts";
import { PublishFailure } from "../errors";
import type { PublisherAdapter } from "../types";

/**
 * An adapter for a platform whose live publishing has not shipped yet. It never sends anything:
 * `publish` and `status` fail with a permanent `not_configured`. Validation passes, so a live
 * post reaches `publish` and fails there with a clear error.
 */
export function notConfiguredAdapter(platform: Platform): PublisherAdapter {
  const refuse = () =>
    PublishFailure.of("not_configured", `Live publishing to ${platform} is not available yet.`, {
      retryable: false,
    });
  return {
    platform,
    validate: async () => [],
    publish: async () => {
      throw refuse();
    },
    status: async () => {
      throw refuse();
    },
  };
}
