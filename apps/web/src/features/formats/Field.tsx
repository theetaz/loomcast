import { Label } from "@loomcast/ui/components/label";
import { cn } from "@loomcast/ui/lib/cn";
import type { ReactNode } from "react";

/** Ids a field's control points at with `aria-describedby`. */
export function fieldIds(id: string) {
  return { hint: `${id}-hint`, error: `${id}-error` };
}

/** `aria-describedby` for a control with an optional hint and error. */
export function describedBy(id: string, hint: boolean, error: string | undefined) {
  const ids = fieldIds(id);
  return [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean).join(" ") || undefined;
}

/**
 * A labelled form field: the label, the control, a hint and the error, which replaces nothing so
 * the layout doesn't jump when it appears.
 */
export function Field({
  id,
  label,
  optional = false,
  hint,
  error,
  className,
  children,
  as = "div",
}: {
  id: string;
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
  /** `fieldset` for groups of controls, such as day toggles. */
  as?: "div" | "fieldset";
}) {
  const ids = fieldIds(id);
  const Root = as;
  const heading = (
    <>
      {label}
      {optional ? (
        <>
          {" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </>
      ) : null}
    </>
  );
  return (
    <Root className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {as === "fieldset" ? (
        <legend className="mb-1.5 flex items-center gap-2 font-medium text-small text-text-2 leading-none">
          {heading}
        </legend>
      ) : (
        <Label htmlFor={id}>{heading}</Label>
      )}
      {children}
      {hint ? (
        <p id={ids.hint} className="text-small text-muted-foreground text-pretty">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.error} className="text-small text-destructive">
          {error}
        </p>
      ) : null}
    </Root>
  );
}

/** One titled card of the editor. */
export function EditorSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-lg bg-card px-4 py-4 shadow-card"
    >
      <header className="flex flex-col gap-0.5">
        <h3 id={`${id}-title`} className="text-heading">
          {title}
        </h3>
        {description ? (
          <p className="text-control text-muted-foreground text-pretty">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
