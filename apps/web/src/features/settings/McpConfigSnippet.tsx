import { CodeBlock } from "./CopyButton";

export const MCP_PATH = "/mcp";
export const TOKEN_PLACEHOLDER = "<your-access-token>";

/**
 * A generic config for MCP clients that connect over streamable HTTP. The
 * token is always a placeholder: real secrets never appear outside the
 * one-time reveal.
 */
export function mcpClientConfig(origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        loomcast: {
          type: "http",
          url: `${origin}${MCP_PATH}`,
          headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

export function McpConfigSnippet() {
  const config = mcpClientConfig(window.location.origin);

  return (
    <section
      aria-labelledby="mcp-config-title"
      className="overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 items-center border-divider border-b px-3.5">
        <h2 id="mcp-config-title" className="font-semibold text-[13px]">
          Connect an MCP client
        </h2>
      </div>
      <div className="grid gap-3 p-3.5">
        <p className="text-control text-muted-foreground text-pretty">
          Clients that speak MCP over streamable HTTP need the server URL and a token sent as a
          bearer header. Key names differ a little between clients; most accept this shape. Replace{" "}
          <code className="font-mono text-mono text-foreground">{TOKEN_PLACEHOLDER}</code> with a
          token from the list above.
        </p>
        <CodeBlock
          value={config}
          copyLabel="Copy MCP configuration"
          overflow="scroll"
          codeClassName="leading-[1.6]"
        />
      </div>
    </section>
  );
}
