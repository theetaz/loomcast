import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import { isSkillName } from "./queries";

/** The id of a tool's row on the workspace's Skills & tools page, which steps link to. */
export function toolAnchor(name: string): string {
  return `tool-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

const linkClass =
  "rounded-sm underline decoration-border underline-offset-2 outline-none transition-colors hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A skill name, linked to its catalogue page when it can be a registry skill. */
export function SkillName({ name, className }: { name: string; className?: string }) {
  const base = cn("font-mono text-[13px] text-foreground", className);
  if (!isSkillName(name)) {
    return <span className={base}>{name}</span>;
  }
  return (
    <Link to="/skills/$name" params={{ name }} className={cn(base, linkClass)}>
      {name}
    </Link>
  );
}

/** A tool name, linked to its row on the workspace's Skills & tools page. */
export function ToolName({
  name,
  workspace,
  className,
}: {
  name: string;
  workspace: string;
  className?: string;
}) {
  return (
    <Link
      to="/w/$workspace/skills"
      params={{ workspace }}
      hash={toolAnchor(name)}
      className={cn("font-mono text-[13px] text-foreground", linkClass, className)}
    >
      {name}
    </Link>
  );
}
