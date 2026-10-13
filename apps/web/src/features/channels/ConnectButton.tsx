import { Button } from "@loomcast/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@loomcast/ui/components/tooltip";
import { PlugIcon } from "lucide-react";
import { useId } from "react";

const NOT_YET = "Connecting accounts isn't available yet. Add a planning channel to plan posts.";

/**
 * Where connecting an account starts. It stays disabled until the connect flow ships, which
 * replaces this component (and only this component) with its menu of providers.
 */
export function ConnectButton() {
  const hint = useId();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The button ignores the pointer while disabled, so the wrapper opens the tooltip. */}
        <span className="inline-flex">
          <Button
            size="sm"
            variant="outline"
            aria-disabled="true"
            aria-describedby={hint}
            onClick={(event) => event.preventDefault()}
          >
            <PlugIcon aria-hidden="true" />
            Connect
          </Button>
          <span id={hint} className="sr-only">
            {NOT_YET}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-64">
        {NOT_YET}
      </TooltipContent>
    </Tooltip>
  );
}
