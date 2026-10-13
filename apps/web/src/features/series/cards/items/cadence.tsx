import { Skeleton } from "@loomcast/ui/components/skeleton";
import {
  browserTimeZone,
  cadenceSummary,
  formatLocalSlot,
  formatSlot,
  upcomingSlots,
} from "@/features/formats/cadence";
import { PUBLISH_MODE_COPY } from "@/features/formats/publish-mode";
import { useNow } from "@/lib/use-now";
import type { SeriesCard, SeriesCardProps } from "../registry";
import { SeriesCardFrame } from "../SeriesCardFrame";

function CadenceCard({ series, format }: SeriesCardProps) {
  const now = useNow();
  if (!format) {
    return (
      <SeriesCardFrame title="Cadence">
        <Skeleton aria-hidden="true" className="h-3 w-48" />
        <Skeleton aria-hidden="true" className="h-3 w-32" />
      </SeriesCardFrame>
    );
  }
  const { cadence, publishMode } = format.currentVersion.rules;
  const active = series.status === "active";
  const slots = active ? upcomingSlots(cadence, 5, now) : [];
  const local = browserTimeZone();

  return (
    <SeriesCardFrame title="Cadence">
      <p className="text-body text-foreground">{cadenceSummary(cadence)}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-control">
        <dt className="text-muted-foreground">Lead time</dt>
        <dd className="tabular-nums">{cadence.leadTimeHours} h before each slot</dd>
        <dt className="text-muted-foreground">Publishing</dt>
        <dd>{PUBLISH_MODE_COPY[publishMode].label}</dd>
      </dl>
      <div className="flex flex-col gap-1 border-divider border-t pt-2.5">
        <p className="font-medium text-small text-text-2">Next slots</p>
        {!active ? (
          <p className="text-small text-muted-foreground">
            {series.status === "paused"
              ? "None while the series is paused."
              : "None: the series is archived."}
          </p>
        ) : slots.length === 0 ? (
          <p className="text-small text-muted-foreground">
            None. Add days and times to the format to plan videos.
          </p>
        ) : (
          <ol aria-label="Next slots" className="flex flex-col gap-0.5">
            {slots.map((slot) => (
              <li
                key={slot.toISOString()}
                className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px] tabular-nums"
              >
                <time dateTime={slot.toISOString()}>{formatSlot(slot, cadence.tz)}</time>
                {local !== cadence.tz ? (
                  <span className="text-muted-foreground">
                    {formatLocalSlot(slot, cadence.tz, local)} your time
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </SeriesCardFrame>
  );
}

export const card: SeriesCard = { id: "cadence", order: 10, Card: CadenceCard };
