import { z } from "zod";

/**
 * Each job type belongs to one concurrency class. The studio agent advertises free credits per
 * class, and the dispatcher assigns a job only while its class has a credit left.
 */
export const CONCURRENCY_CLASSES = ["producer", "render"] as const;
export const ConcurrencyClassSchema = z.enum(CONCURRENCY_CLASSES);
export type ConcurrencyClass = (typeof CONCURRENCY_CLASSES)[number];

/** Free job slots per concurrency class. */
export const CreditsSchema = z.object({
  producer: z.number().int().min(0).max(64),
  render: z.number().int().min(0).max(64),
});
export type Credits = z.infer<typeof CreditsSchema>;
