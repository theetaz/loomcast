import type { Workspace } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { ChevronDownIcon, PlugIcon } from "lucide-react";
import { startOAuth } from "./connect/navigation";
import { connectProviders, PROVIDER_META } from "./connect/providers";
import { useXPublishing } from "./connect/queries";
import { PlatformTile } from "./platforms";

/**
 * Where connecting an account starts: a menu of the sign-ins the server offers. Choosing one
 * leaves the app for the platform's consent dialog, which comes back to the connect page. X is
 * only offered while the server's X publishing flag is on.
 */
export function ConnectButton({
  workspace,
  size = "sm",
}: {
  /** The workspace the accounts are for; the connect page offers it first. */
  workspace: Pick<Workspace, "id" | "slug">;
  size?: "sm" | "default";
}) {
  const providers = connectProviders(useXPublishing());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant="outline">
          <PlugIcon aria-hidden="true" />
          Connect
          <ChevronDownIcon aria-hidden="true" className="-mr-0.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-small">
          Sign in to choose the accounts to connect
        </DropdownMenuLabel>
        {providers.map((provider) => {
          const meta = PROVIDER_META[provider];
          return (
            <DropdownMenuItem
              key={provider}
              onSelect={() => startOAuth(provider, workspace)}
              className="h-auto items-start gap-2.5 py-2"
            >
              <PlatformTile platform={meta.platform} className="size-6 text-[10.5px]" />
              <span className="flex min-w-0 flex-col">
                <span className="text-foreground">{meta.label}</span>
                <span className="text-[11.5px] text-muted-foreground">{meta.hint}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
