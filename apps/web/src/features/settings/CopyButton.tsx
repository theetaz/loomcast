import { Button } from "@loomcast/ui/components/button";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const COPIED_MS = 1600;

// Icons swap with a short fade and scale on the brand curve; reduced motion keeps the fade.
const iconClass =
  "absolute inset-0 transition-[opacity,scale] duration-200 ease-out motion-reduce:scale-100";

export interface CopyButtonProps
  extends Omit<ComponentProps<typeof Button>, "onClick" | "children" | "value"> {
  value: string;
  /** Accessible name, such as "Copy command". */
  label: string;
  /** Shows "Copy" and "Copied" next to the icon instead of an icon-only button. */
  showText?: boolean;
}

/** Copies `value` and confirms in place for a moment; announces "Copied" to screen readers. */
export function CopyButton({
  value,
  label,
  showText = false,
  variant,
  size,
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error("Couldn't copy", { description: "Select the text and copy it instead." });
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <Button
      type="button"
      variant={variant ?? (showText ? "outline" : "ghost")}
      size={size ?? (showText ? "default" : "icon-sm")}
      aria-label={showText ? undefined : label}
      onClick={() => void copy()}
      className={cn("shrink-0", className)}
      {...props}
    >
      <span aria-hidden="true" className="relative size-3.5">
        <CopyIcon className={cn(iconClass, copied ? "scale-50 opacity-0" : "opacity-100")} />
        <CheckIcon
          className={cn(
            iconClass,
            "text-status-green",
            copied ? "opacity-100" : "scale-50 opacity-0",
          )}
        />
      </span>
      {showText ? (
        <span>
          <span className="sr-only">{label}: </span>
          {copied ? "Copied" : "Copy"}
        </span>
      ) : null}
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </Button>
  );
}

export interface CodeBlockProps {
  value: string;
  copyLabel: string;
  /** What to show, when it needs markup; must read the same as `value`. */
  children?: ReactNode;
  /** `wrap` breaks long commands onto new lines; `scroll` keeps code layout and scrolls. */
  overflow?: "wrap" | "scroll";
  className?: string;
  codeClassName?: string;
}

/** Mono text in a recessed box with a copy button. */
export function CodeBlock({
  value,
  copyLabel,
  children,
  overflow = "wrap",
  className,
  codeClassName,
}: CodeBlockProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-1 rounded-md bg-secondary py-1 pr-1 pl-3 shadow-[0_0_0_1px_var(--border)]",
        className,
      )}
    >
      <ScrollArea orientation="horizontal" className="min-w-0 flex-1">
        <pre
          className={cn(
            "py-1 font-mono text-mono text-foreground",
            overflow === "wrap" && "whitespace-pre-wrap [overflow-wrap:anywhere]",
            codeClassName,
          )}
        >
          <code>{children ?? value}</code>
        </pre>
      </ScrollArea>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}
