import { Switch } from "@loomcast/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@loomcast/ui/components/tooltip";
import { cn } from "@loomcast/ui/lib/cn";

/**
 * A small switch with a visible label. A locked switch stays focusable (`aria-disabled` rather
 * than `disabled`), so keyboard and screen reader users reach the reason, which is the switch's
 * description and a tooltip on hover and focus.
 */
export function SwitchField({
  id,
  label,
  name,
  checked,
  disabled = false,
  reason = null,
  onCheckedChange,
}: {
  id: string;
  label: string;
  /** The accessible name, which says which channel the switch belongs to. */
  name: string;
  checked: boolean;
  disabled?: boolean;
  /** Why the switch is disabled: a tooltip, and the switch's description. */
  reason?: string | null;
  onCheckedChange: (checked: boolean) => void;
}) {
  const field = (
    <span className="inline-flex items-center gap-2">
      <Switch
        id={id}
        size="sm"
        checked={checked}
        aria-disabled={disabled || undefined}
        aria-label={name}
        aria-describedby={reason ? `${id}-reason` : undefined}
        className={cn(disabled && "cursor-not-allowed opacity-50")}
        onCheckedChange={(next) => {
          if (!disabled) onCheckedChange(next);
        }}
      />
      <label
        htmlFor={id}
        className={cn(
          "select-none text-control",
          disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer text-text-2",
        )}
      >
        {label}
      </label>
      {reason ? (
        <span id={`${id}-reason`} className="sr-only">
          {reason}
        </span>
      ) : null}
    </span>
  );
  if (!reason) return field;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-locked-reason={reason} className="inline-flex">
          {field}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
