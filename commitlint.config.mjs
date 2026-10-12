export const SCOPES = [
  "web",
  "api",
  "ui",
  "bridge",
  "agent",
  "mcp",
  "db",
  "auth",
  "contracts",
  "kb",
  "pipeline",
  "scheduler",
  "publisher",
  "channels",
  "studio",
  "brand",
  "infra",
  "ci",
  "deps",
  "docs",
  "repo",
  "e2e",
];

const TRAILER = /^\s*(co-authored-by|signed-off-by)\s*:/im;
const GENERATED = /\bgenerated (with|by)\b/i;

const attributionPlugin = {
  rules: {
    "no-attribution-trailers": (parsed) => {
      const message = parsed.raw ?? "";
      if (TRAILER.test(message)) {
        return [false, "co-author and sign-off trailers are not allowed"];
      }
      if (GENERATED.test(message)) {
        return [false, "generation or tool attribution is not allowed"];
      }
      return [true];
    },
  },
};

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [attributionPlugin],
  rules: {
    "scope-enum": [2, "always", SCOPES],
    "subject-case": [2, "always", "lower-case"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 100],
    "no-attribution-trailers": [2, "always"],
  },
};
