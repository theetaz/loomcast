import type { McpToolContract } from "@loomcast/contracts";
import { LEGACY_WORKSPACE_TOOLS } from "./tools/workspaces";

/** Where the generated reference sits in `docs/mcp.md`. */
export const REFERENCE_START = "<!-- tool-reference:start -->";
export const REFERENCE_END = "<!-- tool-reference:end -->";

/** A tool as `tools/list` advertises it. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

/** The subset of JSON Schema the contracts produce. */
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

interface Row {
  path: string;
  type: string;
  required: boolean;
  notes: string;
}

/** Formats whose regular expression adds nothing for a reader. */
const SELF_EXPLANATORY_FORMATS = new Set(["uuid", "date-time", "uri", "email"]);

const escapeCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

function typeLabel(schema: JsonSchema): string {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants !== undefined) {
    return variants.map(typeLabel).join(" | ");
  }
  if (schema.enum !== undefined) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((type) => typeLabel({ ...schema, type, anyOf: undefined, oneOf: undefined }))
      .join(" | ");
  }
  if (schema.type === "array") {
    const item = schema.items === undefined ? "unknown" : typeLabel(schema.items);
    // `("a" | "b")[]`, so the brackets apply to the whole union.
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
  }
  if (schema.type === "string" && schema.format !== undefined) {
    return `string (${schema.format})`;
  }
  return schema.type ?? "unknown";
}

function notes(schema: JsonSchema): string {
  const parts: string[] = [];
  const variants = schema.anyOf ?? schema.oneOf;
  const source = variants?.find((variant) => variant.type !== "null") ?? schema;
  if (source.minLength !== undefined && source.maxLength !== undefined) {
    parts.push(`${source.minLength} to ${source.maxLength} characters`);
  } else if (source.maxLength !== undefined) {
    parts.push(`at most ${source.maxLength} characters`);
  } else if (source.minLength !== undefined) {
    parts.push(`at least ${source.minLength} characters`);
  }
  if (source.minimum !== undefined) {
    parts.push(`at least ${source.minimum}`);
  }
  if (source.maximum !== undefined && source.maximum < Number.MAX_SAFE_INTEGER) {
    parts.push(`at most ${source.maximum}`);
  }
  if (source.minItems !== undefined) {
    parts.push(`at least ${source.minItems} items`);
  }
  if (source.maxItems !== undefined) {
    parts.push(`at most ${source.maxItems} items`);
  }
  if (source.pattern !== undefined && !SELF_EXPLANATORY_FORMATS.has(source.format ?? "")) {
    parts.push(`matches \`${source.pattern}\``);
  }
  if (schema.description !== undefined) {
    parts.push(schema.description);
  }
  return parts.join("; ");
}

/** One row per field, with nested objects and arrays of objects flattened into dotted paths. */
function rows(schema: JsonSchema, prefix = ""): Row[] {
  const required = new Set(schema.required ?? []);
  const result: Row[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    result.push({
      path,
      type: typeLabel(property),
      required: required.has(name),
      notes: notes(property),
    });
    if (property.type === "object") {
      result.push(...rows(property, `${path}.`));
    } else if (property.type === "array" && property.items?.type === "object") {
      result.push(...rows(property.items, `${path}[].`));
    }
  }
  return result;
}

function table(schema: JsonSchema | undefined): string {
  const fields = schema === undefined ? [] : rows(schema);
  if (fields.length === 0) {
    return "None.";
  }
  return [
    "| Field | Type | Required | Notes |",
    "|---|---|---|---|",
    ...fields.map(
      (row) =>
        `| \`${escapeCell(row.path)}\` | ${escapeCell(row.type)} | ${row.required ? "yes" : "no"} | ${escapeCell(row.notes)} |`,
    ),
  ].join("\n");
}

const JOB_TOKENS: Record<McpToolContract["jobTokens"], string> = {
  allow: "allowed",
  deny: "not allowed",
};

const WORKSPACE_BINDING: Record<McpToolContract["workspaceBinding"], string> = {
  input: "the input names the workspace",
  none: "the input names no workspace",
};

/**
 * The tool reference of `docs/mcp.md`, rendered from what `tools/list` advertises plus each
 * tool's contract (scope, job-token policy, workspace binding).
 */
export function renderToolReference(
  tools: readonly ListedTool[],
  contracts: Readonly<Record<string, McpToolContract>>,
): string {
  const sections = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      // A deprecated alias has the contract of the tool it stands for.
      const legacy: Readonly<Record<string, string>> = LEGACY_WORKSPACE_TOOLS;
      const contract = contracts[tool.name] ?? contracts[legacy[tool.name] ?? ""];
      const facts =
        contract === undefined
          ? []
          : [
              `- **Scope:** \`${contract.scope}\``,
              `- **Job tokens:** ${JOB_TOKENS[contract.jobTokens]}`,
              `- **Workspace binding:** ${WORKSPACE_BINDING[contract.workspaceBinding]}`,
            ];
      return [
        `### \`${tool.name}\``,
        "",
        tool.description ?? "",
        "",
        ...facts,
        "",
        "**Input**",
        "",
        table(tool.inputSchema),
        "",
        "**Output** (`structuredContent`)",
        "",
        table(tool.outputSchema),
      ].join("\n");
    });
  return sections.join("\n\n");
}

/** `markdown` with the text between the reference markers replaced by `reference`. */
export function replaceToolReference(markdown: string, reference: string): string {
  const start = markdown.indexOf(REFERENCE_START);
  const end = markdown.indexOf(REFERENCE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("docs/mcp.md is missing the tool reference markers");
  }
  return `${markdown.slice(0, start + REFERENCE_START.length)}\n\n${reference}\n\n${markdown.slice(end)}`;
}
