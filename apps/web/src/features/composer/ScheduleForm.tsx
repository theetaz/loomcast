import {
  type Channel,
  type ContentItem,
  INSTAGRAM_MAX_COLLABORATORS,
  type MediaType,
  MIN_SCHEDULE_LEAD_MS,
  PLATFORM_LABELS,
  type Platform,
  POST_TITLE_MAX_LENGTH,
  type ScheduledPost,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Switch } from "@loomcast/ui/components/switch";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckIcon, RadioTowerIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { fromLocalInput, suggestedTime, toLocalInput } from "@/features/approvals/RescheduleDialog";
import { type ChannelOutcome, useScheduleItem } from "@/features/calendar/queries";
import { ChannelPicture, sortChannels } from "@/features/channels/platforms";
import { channelsQueryOptions } from "@/features/channels/queries";
import {
  channelPublishes,
  platformsFor,
  schedulableChannels,
} from "@/features/post-formats/channels";
import { formatLabel } from "@/features/post-formats/FormatBadge";
import { errorMessage, isApiError } from "@/lib/api";
import {
  buildOptions,
  EMPTY_OPTIONS,
  type OptionField,
  type OptionFields,
  optionFieldsFor,
} from "./draft";

/** Why one channel refused a post, as a sentence. */
export function outcomeMessage(error: unknown): string {
  if (isApiError(error, 422) && error.code === "format_not_supported") return error.message;
  if (isApiError(error, 409)) {
    return error.message || "It already has an open post on this channel.";
  }
  return errorMessage(error, "Couldn't schedule it here. Try again.");
}

export interface ScheduleFormProps {
  item: ContentItem;
  /** The version the posts publish; approved first when the item waits in review. */
  versionId: string;
  /** The version's photos and videos, for carousels that some platforms take as photos only. */
  media: readonly { type: MediaType }[];
  /** Prefilled options, such as a text post's link. */
  defaults?: Partial<OptionFields>;
  cancelLabel?: string;
  onCancel: () => void;
  onDone: (posts: ScheduledPost[]) => void;
}

/**
 * Schedules an item on one or more channels at one time, with the options each platform offers
 * for its format: Instagram collaborators, location and (for Reels) the grid; a Facebook text
 * post's link or a video's title. Only channels whose platform publishes the format are offered.
 * An item ready for review is submitted and approved first, as part of the same step.
 */
export function ScheduleForm({
  item,
  versionId,
  media,
  defaults,
  cancelLabel = "Cancel",
  onCancel,
  onDone,
}: ScheduleFormProps) {
  const id = useId();
  const channels = useQuery(channelsQueryOptions());
  const schedule = useScheduleItem();
  const [current, setCurrent] = useState(item);
  const [selected, setSelected] = useState<string[]>([]);
  const [when, setWhen] = useState(() => toLocalInput(suggestedTime(Date.now())));
  const [whenError, setWhenError] = useState<string | null>(null);
  const [fields, setFields] = useState<OptionFields>({ ...EMPTY_OPTIONS, ...defaults });
  const [showErrors, setShowErrors] = useState(false);
  const [done, setDone] = useState<ScheduledPost[]>([]);
  const [failures, setFailures] = useState<ChannelOutcome[]>([]);

  const format = item.format;
  const all = sortChannels(schedulableChannels(channels.data?.items ?? []));
  const usable = all.filter((channel) => channelPublishes(channel, format, media));
  const scheduledOn = new Set(done.map((post) => post.channelId));
  const chosen = usable.filter(
    (channel) => selected.includes(channel.id) && !scheduledOn.has(channel.id),
  );
  const platforms = [...new Set(chosen.map((channel) => channel.platform))];
  const built = buildOptions(fields, format, platforms);
  const fieldErrors = showErrors ? built.errors : {};
  // A post ready for review, or in it, is approved as part of scheduling it.
  const reviewing = current.state === "render" || current.state === "review";
  const left = all
    .map((channel) => channel.platform)
    .filter((platform, index, list) => list.indexOf(platform) === index)
    .filter((platform) => !platformsFor(format).includes(platform));

  const toggle = (channelId: string, on: boolean) =>
    setSelected((list) =>
      on ? [...list, channelId] : list.filter((entry) => entry !== channelId),
    );
  const setField = <K extends OptionField>(key: K, value: OptionFields[K]) =>
    setFields((previous) => ({ ...previous, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (schedule.isPending || chosen.length === 0) return;
    setShowErrors(true);
    const time = fromLocalInput(when);
    if (Number.isNaN(time)) {
      setWhenError("Pick a date and time.");
      return;
    }
    if (time < Date.now() + MIN_SCHEDULE_LEAD_MS) {
      setWhenError("Pick a time at least two minutes ahead.");
      return;
    }
    if (Object.keys(built.errors).length > 0) return;
    schedule.mutate(
      {
        item: current,
        versionId,
        channels: chosen,
        scheduledAt: new Date(time).toISOString(),
        options: built.options,
      },
      {
        onSuccess: ({ approved, outcomes }) => {
          if (approved) setCurrent(approved);
          const posts = outcomes.flatMap((outcome) => (outcome.post ? [outcome.post] : []));
          const failed = outcomes.filter((outcome) => outcome.error !== undefined);
          const all = [...done, ...posts];
          setDone(all);
          setFailures(failed);
          if (failed.length === 0) onDone(all);
        },
      },
    );
  };

  const offered = (platform: Platform, field: OptionField) =>
    platforms.includes(platform) && optionFieldsFor(platform, format).includes(field);
  const optionRows: ReactNode[] = [];
  if (offered("instagram", "collaborators")) {
    optionRows.push(
      <TextOption
        key="collaborators"
        id={`${id}-collaborators`}
        label="Instagram collaborators"
        hint={`Up to ${INSTAGRAM_MAX_COLLABORATORS} usernames, separated by commas.`}
        placeholder="rustlang, ferris.codes"
        value={fields.collaborators}
        error={fieldErrors.collaborators}
        onChange={(value) => setField("collaborators", value)}
      />,
    );
  }
  if (offered("instagram", "locationId")) {
    optionRows.push(
      <TextOption
        key="location"
        id={`${id}-location`}
        label="Instagram location"
        hint="The id of the Facebook Page of the place."
        placeholder="110843418940484"
        inputMode="numeric"
        value={fields.locationId}
        error={fieldErrors.locationId}
        onChange={(value) => setField("locationId", value)}
      />,
    );
  }
  if (offered("instagram", "shareToFeed")) {
    optionRows.push(
      <div key="feed" className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-feed`} className="font-normal">
          Also show the Reel in the Instagram grid
        </Label>
        <Switch
          id={`${id}-feed`}
          size="sm"
          checked={fields.shareToFeed}
          onCheckedChange={(checked) => setField("shareToFeed", checked)}
        />
      </div>,
    );
  }
  if (offered("facebook", "link")) {
    optionRows.push(
      <TextOption
        key="link"
        id={`${id}-link`}
        label="Facebook link"
        hint="Shown under the text as a preview card."
        placeholder="https://"
        type="url"
        value={fields.link}
        error={fieldErrors.link}
        onChange={(value) => setField("link", value)}
      />,
    );
  }
  if (offered("facebook", "title")) {
    optionRows.push(
      <TextOption
        key="title"
        id={`${id}-title`}
        label="Facebook video title"
        maxLength={POST_TITLE_MAX_LENGTH}
        value={fields.title}
        error={fieldErrors.title}
        onChange={(value) => setField("title", value)}
      />,
    );
  }

  return (
    <form noValidate onSubmit={submit} className="grid gap-4" aria-label="Schedule">
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 font-medium text-control">Channels</legend>
        {channels.isPending ? (
          <div aria-hidden="true" className="grid gap-1.5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : channels.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load the channels"
            error={channels.error}
            onRetry={() => void channels.refetch()}
            retrying={channels.isFetching}
          />
        ) : usable.length === 0 ? (
          <EmptyState
            size="compact"
            icon={RadioTowerIcon}
            title={`No channel publishes ${formatLabel(format).toLowerCase()}s`}
            description={`${platformsFor(format)
              .map((platform) => PLATFORM_LABELS[platform])
              .join(" and ")} channels can. Connect one in Settings.`}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/settings/channels">Open channels</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-1">
            {usable.map((channel) => (
              <ChannelOption
                key={channel.id}
                channel={channel}
                checked={selected.includes(channel.id) || scheduledOn.has(channel.id)}
                scheduled={scheduledOn.has(channel.id)}
                error={failures.find((outcome) => outcome.channel.id === channel.id)?.error}
                onChange={(on) => toggle(channel.id, on)}
              />
            ))}
          </ul>
        )}
        {left.length > 0 && usable.length > 0 ? (
          <p className="text-small text-muted-foreground">
            {left.map((platform) => PLATFORM_LABELS[platform]).join(" and ")}{" "}
            {left.length === 1 ? "doesn't" : "don't"} publish {formatLabel(format).toLowerCase()}s,
            so {left.length === 1 ? "its" : "their"} channels aren't listed.
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-at`}>When</Label>
        <Input
          id={`${id}-at`}
          type="datetime-local"
          value={when}
          min={toLocalInput(Date.now() + MIN_SCHEDULE_LEAD_MS)}
          aria-invalid={whenError ? true : undefined}
          aria-describedby={whenError ? `${id}-at-error` : `${id}-zone`}
          onChange={(event) => {
            setWhen(event.target.value);
            if (whenError) setWhenError(null);
          }}
        />
        {whenError ? (
          <p id={`${id}-at-error`} className="text-small text-destructive">
            {whenError}
          </p>
        ) : (
          <p id={`${id}-zone`} className="text-small text-muted-foreground">
            In your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
          </p>
        )}
      </div>

      {optionRows.length > 0 ? (
        <fieldset className="grid gap-3">
          <legend className="mb-1.5 font-medium text-control">Options</legend>
          {optionRows}
        </fieldset>
      ) : null}

      {schedule.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(
            schedule.error,
            reviewing ? "Couldn't approve it. Try again." : "Couldn't schedule it. Try again.",
          )}
        </p>
      ) : failures.length > 0 ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {done.length > 0
            ? `Scheduled on ${done.length} of ${done.length + failures.length} channels. `
            : null}
          {failures.length === 1
            ? "One channel refused the post; see the reason under it."
            : `${failures.length} channels refused the post; see the reasons under them.`}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={schedule.isPending || chosen.length === 0}>
          {schedule.isPending
            ? reviewing
              ? "Approving…"
              : "Scheduling…"
            : reviewing
              ? "Approve and schedule"
              : chosen.length > 1
                ? `Schedule on ${chosen.length} channels`
                : "Schedule"}
        </Button>
      </div>
    </form>
  );
}

function ChannelOption({
  channel,
  checked,
  scheduled,
  error,
  onChange,
}: {
  channel: Channel;
  checked: boolean;
  scheduled: boolean;
  error: unknown;
  onChange: (checked: boolean) => void;
}) {
  const errorId = useId();
  return (
    <li className="grid gap-1">
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-control transition-colors",
          "has-focus-visible:ring-2 has-focus-visible:ring-ring",
          checked ? "bg-accent-soft" : "hover:bg-secondary",
          scheduled && "cursor-default",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={scheduled}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={error !== undefined ? errorId : undefined}
          onChange={(event) => onChange(event.target.checked)}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
            checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
          )}
        >
          {checked ? <CheckIcon className="size-3" /> : null}
        </span>
        <ChannelPicture platform={channel.platform} pictureUrl={channel.pictureUrl} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{channel.displayName}</span>
          <span className="truncate text-small text-muted-foreground">
            {PLATFORM_LABELS[channel.platform]}
            {channel.dryRun ? " · dry run" : ""}
          </span>
        </span>
        {scheduled ? (
          <span className="shrink-0 text-small text-status-green">Scheduled</span>
        ) : null}
      </label>
      {error !== undefined ? (
        <p id={errorId} className="px-2.5 text-small text-destructive">
          {outcomeMessage(error)}
        </p>
      ) : null}
    </li>
  );
}

function TextOption({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: "numeric";
  maxLength?: number;
}) {
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        onChange={(event) => onChange(event.target.value)}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="text-small text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-small text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
