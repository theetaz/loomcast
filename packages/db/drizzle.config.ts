import { defineConfig } from "drizzle-kit";
import { loadRootEnv } from "./src/env";

loadRootEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Only `drizzle-kit studio` connects; `generate` works from the schema files alone.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
