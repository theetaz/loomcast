import {
  FORMAT_MAX_SLOTS,
  LEAD_TIME_HOURS_MAX,
  LEAD_TIME_HOURS_MIN,
  WEEKDAYS,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { cn } from "@loomcast/ui/lib/cn";
import { PlusIcon, XIcon } from "lucide-react";
import { useId } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useNow } from "@/lib/use-now";
import {
  browserTimeZone,
  formatLocalSlot,
  formatSlot,
  slotsPerWeek,
  toggleDay,
  upcomingSlots,
  WEEKDAY_LABELS,
} from "./cadence";
import { describedBy, EditorSection, Field } from "./Field";
import { type FormatFormValues, fieldError } from "./rules-form";
import { TimeZoneSelect } from "./TimeZoneSelect";

/** The time after the last one, an hour later, for "Add time". */
export function nextSlotTime(slots: readonly string[]): string {
  const last = [...slots]
    .filter((slot) => /^\d{2}:\d{2}$/.test(slot))
    .sort()
    .at(-1);
  if (!last) return "09:00";
  const hour = Math.min(23, Number(last.slice(0, 2)) + 1);
  const candidate = `${String(hour).padStart(2, "0")}:${last.slice(3)}`;
  return slots.includes(candidate) ? "" : candidate;
}

function leadTimeLabel(hours: number): string | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} before each slot`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `${days} day${days === 1 ? "" : "s"}${rest ? ` ${rest} h` : ""} before each slot`;
}

/** Days, times, time zone and lead time, with a preview of the next slots. */
export function CadenceFields() {
  const id = useId();
  const now = useNow();
  const {
    control,
    register,
    formState: { errors },
  } = useFormContext<FormatFormValues>();
  const cadence = useWatch({ control, name: "rules.cadence" });
  const ids = {
    days: `${id}-days`,
    slots: `${id}-slots`,
    tz: `${id}-tz`,
    lead: `${id}-lead`,
  };
  const daysError = fieldError(errors, "rules.cadence.days");
  const slotsError = fieldError(errors, "rules.cadence.slots");
  const tzError = fieldError(errors, "rules.cadence.tz");
  const leadError = fieldError(errors, "rules.cadence.leadTimeHours");
  const preview = upcomingSlots(cadence, 5, now);
  const local = browserTimeZone();
  const perWeek = slotsPerWeek(cadence);

  return (
    <EditorSection
      id={`${id}-cadence`}
      title="Cadence"
      description="When the series publishes. Each slot gets a video; production starts the lead time before it."
    >
      <Controller
        control={control}
        name="rules.cadence.days"
        render={({ field }) => (
          <Field id={ids.days} as="fieldset" label="Days" error={daysError}>
            <div
              className="flex flex-wrap gap-1"
              aria-describedby={describedBy(ids.days, false, daysError)}
            >
              {WEEKDAYS.map((day) => {
                const on = field.value.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY_LABELS[day].long}
                    onClick={() => field.onChange(toggleDay(field.value, day))}
                    onBlur={field.onBlur}
                    className={cn(
                      "pressable h-7 min-w-11 rounded-md px-2 font-medium text-control outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-primary text-primary-foreground"
                        : "bg-card text-text-2 shadow-card hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {WEEKDAY_LABELS[day].short}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
      />

      <Controller
        control={control}
        name="rules.cadence.slots"
        render={({ field }) => {
          const slots = field.value;
          const next = nextSlotTime(slots);
          return (
            <Field
              id={ids.slots}
              as="fieldset"
              label="Times"
              hint={`Local times in the series time zone, up to ${FORMAT_MAX_SLOTS} a day.`}
              error={slotsError}
            >
              <ul className="flex flex-wrap gap-1.5">
                {slots.map((slot, index) => (
                  <li key={index} className="flex items-center gap-0.5">
                    <Input
                      type="time"
                      step={60}
                      required
                      aria-label={`Time ${index + 1}`}
                      aria-describedby={describedBy(ids.slots, true, slotsError)}
                      aria-invalid={slotsError ? true : undefined}
                      value={slot}
                      onChange={(event) => {
                        const copy = [...slots];
                        copy[index] = event.target.value;
                        field.onChange(copy);
                      }}
                      onBlur={field.onBlur}
                      className="h-7.5 w-[6.75rem] font-mono text-[12px] tabular-nums"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove time ${slot || index + 1}`}
                      onClick={() => field.onChange(slots.filter((_, at) => at !== index))}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </li>
                ))}
                <li>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7.5"
                    disabled={slots.length >= FORMAT_MAX_SLOTS}
                    onClick={() => field.onChange([...slots, next || "12:00"])}
                  >
                    <PlusIcon aria-hidden="true" />
                    Add time
                  </Button>
                </li>
              </ul>
            </Field>
          );
        }}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="rules.cadence.tz"
          render={({ field }) => (
            <Field
              id={ids.tz}
              label="Time zone"
              hint={tzError ? undefined : "Slots follow this zone's daylight saving changes."}
              error={tzError}
            >
              <TimeZoneSelect
                id={ids.tz}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                hasError={Boolean(tzError)}
                describedBy={describedBy(ids.tz, !tzError, tzError)}
              />
            </Field>
          )}
        />
        <Field
          id={ids.lead}
          label="Lead time (hours)"
          hint={
            leadTimeLabel(cadence.leadTimeHours) ??
            `${LEAD_TIME_HOURS_MIN} to ${LEAD_TIME_HOURS_MAX} hours`
          }
          error={leadError}
        >
          <Input
            id={ids.lead}
            type="number"
            inputMode="numeric"
            min={LEAD_TIME_HOURS_MIN}
            max={LEAD_TIME_HOURS_MAX}
            step={1}
            aria-invalid={leadError ? true : undefined}
            aria-describedby={describedBy(ids.lead, true, leadError)}
            className="w-28 tabular-nums"
            {...register("rules.cadence.leadTimeHours", { valueAsNumber: true })}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5 rounded-md bg-secondary px-3 py-2.5 shadow-[0_0_0_1px_var(--border)]">
        <p className="font-medium text-small text-text-2">
          Next slots
          {perWeek > 0 ? (
            <span className="font-normal text-muted-foreground"> · {perWeek} a week</span>
          ) : null}
        </p>
        {preview.length > 0 ? (
          <ol aria-label="Next slots" className="flex flex-col gap-0.5">
            {preview.map((slot) => (
              <li
                key={slot.toISOString()}
                className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px] tabular-nums"
              >
                <time dateTime={slot.toISOString()} className="text-foreground">
                  {formatSlot(slot, cadence.tz)}
                </time>
                {local !== cadence.tz ? (
                  <span className="text-muted-foreground">
                    {formatLocalSlot(slot, cadence.tz, local)} your time
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-small text-muted-foreground">
            No slots. Pick at least one day and one time to publish on a schedule.
          </p>
        )}
      </div>
    </EditorSection>
  );
}
