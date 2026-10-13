import type { PublishMode } from "@loomcast/contracts";
import { cn } from "@loomcast/ui/lib/cn";
import { useId } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { fieldIds } from "./Field";
import { PUBLISH_MODE_COPY } from "./publish-mode";
import { type FormatFormValues, fieldError } from "./rules-form";

const MODES: PublishMode[] = ["approval", "auto"];

/** Approval or automatic publishing, each with what it means. */
export function PublishModeField() {
  const id = useId();
  const {
    control,
    formState: { errors },
  } = useFormContext<FormatFormValues>();
  const error = fieldError(errors, "rules.publishMode");
  return (
    <Controller
      control={control}
      name="rules.publishMode"
      render={({ field }) => (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 font-medium text-small text-text-2 leading-none">
            Publish mode
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODES.map((mode) => {
              const checked = field.value === mode;
              const inputId = `${id}-${mode}`;
              return (
                <label
                  key={mode}
                  htmlFor={inputId}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-md bg-card px-3 py-2.5 shadow-card transition-shadow has-[input:focus-visible]:shadow-focus",
                    checked && "shadow-[0_0_0_1px_var(--primary)]",
                  )}
                >
                  <input
                    id={inputId}
                    ref={mode === MODES[0] ? field.ref : undefined}
                    type="radio"
                    name={field.name}
                    value={mode}
                    checked={checked}
                    onChange={() => field.onChange(mode)}
                    onBlur={field.onBlur}
                    aria-describedby={`${inputId}-text`}
                    className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-control text-foreground">
                      {PUBLISH_MODE_COPY[mode].label}
                    </span>
                    <span id={`${inputId}-text`} className="text-small text-muted-foreground">
                      {PUBLISH_MODE_COPY[mode].explanation}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {error ? (
            <p id={fieldIds(id).error} className="text-small text-destructive">
              {error}
            </p>
          ) : null}
        </fieldset>
      )}
    />
  );
}
