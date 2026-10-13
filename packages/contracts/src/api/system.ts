import { z } from "zod";

/**
 * Server features the web app shows or hides. `xPublishing` is the server's X publishing flag:
 * while it is off, X is not offered for connecting, creating an X channel answers `403 forbidden`
 * and the publisher refuses X posts with `not_configured`.
 */
export const SystemFeaturesSchema = z.object({
  xPublishing: z.boolean(),
});
export type SystemFeatures = z.infer<typeof SystemFeaturesSchema>;
