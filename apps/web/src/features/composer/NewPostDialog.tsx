import {
  allowedActions,
  CAPTION_MAX_LENGTH,
  CONTENT_TITLE_MAX_LENGTH,
  type ContentItem,
  ContentTitleSchema,
  type ContentVersion,
  FORMAT_MEDIA_RULES,
  formatMediaIssues,
  MAX_POST_MEDIA,
  type MediaType,
  PLATFORM_LABELS,
  type PostFormat,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@loomcast/ui/components/dialog";
import { Input } from "@loomcast/ui/components/input";
import { Label } from "@loomcast/ui/components/label";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ImagePlusIcon, RadioTowerIcon, TriangleAlertIcon } from "lucide-react";
import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { useMe } from "@/features/auth/queries";
import { channelsQueryOptions } from "@/features/channels/queries";
import { seriesListQueryOptions } from "@/features/library/queries";
import {
  platformsFor,
  publishableFormats,
  schedulableChannels,
} from "@/features/post-formats/channels";
import { FORMAT_ICONS, formatLabel } from "@/features/post-formats/FormatBadge";
import { PostPreview } from "@/features/post-formats/MediaPreview";
import {
  checkPostMediaFile,
  type PostMediaProgress,
  postMediaType,
} from "@/features/post-formats/media-upload";
import { projectsQueryOptions } from "@/features/projects/queries";
import { errorMessage } from "@/lib/api";
import {
  acceptFor,
  draftIssues,
  type MediaDraft,
  mediaHint,
  moveEntry,
  takesMedia,
  takesSeveral,
} from "./draft";
import { MediaList } from "./MediaList";
import { type SavedSoFar, useSavePost } from "./queries";
import { ScheduleForm } from "./ScheduleForm";

const NO_SERIES = "none";

/** The format the composer starts with, when the channels publish it. */
const PREFERRED_FORMAT: PostFormat = "image";

type Step = "compose" | "saved" | "schedule";

let nextKey = 0;
const draftKey = () => {
  nextKey += 1;
  return `media-${nextKey}`;
};

/**
 * Wraps a trigger button. Composes a post from photos, videos or words: the project, the format
 * (only those a channel publishes), a title, the caption and the media, with a live preview and
 * what the format still needs. Saving creates the item, uploads the media and writes its version;
 * the post can then be scheduled from the same dialog once it may be. The form starts empty every
 * time the dialog opens.
 */
export function NewPostDialog({
  projectId = null,
  children,
}: {
  projectId?: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const onOpenChange = (next: boolean) => {
    // An upload in flight finishes first; the dialog closes once it settles.
    if (!next && busy) return;
    if (next) setFormKey((key) => key + 1);
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[880px]">
        <Composer
          key={formKey}
          fixedProjectId={projectId}
          onBusyChange={setBusy}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function Composer({
  fixedProjectId,
  onBusyChange,
  onClose,
}: {
  fixedProjectId: string | null;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const titleRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = useSavePost();
  const me = useMe();

  const projects = useQuery({ ...projectsQueryOptions(), enabled: fixedProjectId === null });
  const activeProjects = (projects.data ?? []).filter((project) => project.status === "active");
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const projectId = fixedProjectId ?? chosenProjectId ?? activeProjects[0]?.id ?? null;
  const series = useQuery({
    ...seriesListQueryOptions(projectId ?? ""),
    enabled: projectId !== null,
  });
  const activeSeries = (series.data?.items ?? []).filter((entry) => entry.status !== "archived");

  const channels = useQuery(channelsQueryOptions());
  const usable = schedulableChannels(channels.data?.items ?? []);
  const formats = publishableFormats(usable);

  const [step, setStep] = useState<Step>("compose");
  const [chosenFormat, setChosenFormat] = useState<PostFormat | null>(null);
  const format =
    chosenFormat && formats.includes(chosenFormat)
      ? chosenFormat
      : formats.includes(PREFERRED_FORMAT)
        ? PREFERRED_FORMAT
        : (formats[0] ?? null);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [link, setLink] = useState("");
  const [media, setMedia] = useState<MediaDraft[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [progress, setProgress] = useState<Record<string, PostMediaProgress>>({});
  const [savedSoFar, setSavedSoFar] = useState<SavedSoFar>({ item: null, uploaded: {} });
  const [result, setResult] = useState<{ item: ContentItem; version: ContentVersion } | null>(null);
  const chosenSeries =
    seriesId && activeSeries.some((entry) => entry.id === seriesId) ? seriesId : null;

  // Object URLs of the previews are released when the composer goes away.
  const mediaRef = useRef(media);
  mediaRef.current = media;
  useEffect(
    () => () => {
      for (const entry of mediaRef.current) URL.revokeObjectURL(entry.url);
    },
    [],
  );

  useEffect(() => onBusyChange(save.isPending), [save.isPending, onBusyChange]);

  // Each step starts at its heading, so screen readers hear where they are.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  // A text post leaves the files picked for another format behind.
  const kept = format && takesMedia(format) ? media : [];
  const issues = format ? draftIssues(format, kept, caption) : [];
  const locked = save.isPending || savedSoFar.item !== null;

  const addFiles = (files: readonly File[]) => {
    if (!format || files.length === 0) return;
    const rule = FORMAT_MEDIA_RULES[format];
    const types: readonly MediaType[] = rule.types;
    const added: MediaDraft[] = [];
    let problem: string | null = null;
    for (const file of files) {
      const type = postMediaType(file);
      const check = checkPostMediaFile(file);
      if (check || !type) {
        problem = check ?? "Choose a photo or a video.";
        continue;
      }
      if (!types.includes(type)) {
        problem = `A ${formatLabel(format).toLowerCase()} takes ${types.includes("image") ? "photos" : "videos"} only.`;
        continue;
      }
      added.push({ key: draftKey(), file, type, url: URL.createObjectURL(file), altText: "" });
    }
    setMedia((current) => {
      if (rule.max === 1) {
        const replacement = added.at(-1);
        if (!replacement) return current;
        for (const entry of current) URL.revokeObjectURL(entry.url);
        for (const entry of added.slice(0, -1)) URL.revokeObjectURL(entry.url);
        return [replacement];
      }
      const room = Math.max(0, MAX_POST_MEDIA - current.length);
      if (added.length > room) {
        problem = `A post carries at most ${MAX_POST_MEDIA} photos or videos.`;
        for (const entry of added.slice(room)) URL.revokeObjectURL(entry.url);
      }
      return [...current, ...added.slice(0, room)];
    });
    setFileError(problem);
  };

  const remove = (key: string) => {
    setMedia((current) => {
      const entry = current.find((candidate) => candidate.key === key);
      if (entry) URL.revokeObjectURL(entry.url);
      return current.filter((candidate) => candidate.key !== key);
    });
    setFileError(null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    if (locked) return;
    addFiles(Array.from(event.dataTransfer.files));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (save.isPending || !projectId || !format) return;
    const parsed = ContentTitleSchema.safeParse(title);
    if (!parsed.success) {
      setTitleError("Give the post a title.");
      titleRef.current?.focus();
      return;
    }
    save.mutate(
      {
        input: {
          projectId,
          format,
          title: parsed.data,
          seriesId: chosenSeries,
          caption,
          media: kept,
          progress: savedSoFar,
        },
        callbacks: {
          onCreated: (item) => setSavedSoFar((previous) => ({ ...previous, item })),
          onUploadProgress: (key, next) =>
            setProgress((previous) => ({ ...previous, [key]: next })),
          onUploaded: (key, assetId) => {
            setSavedSoFar((previous) => ({
              ...previous,
              uploaded: { ...previous.uploaded, [key]: assetId },
            }));
            setMedia((current) =>
              current.map((entry) => (entry.key === key ? { ...entry, assetId } : entry)),
            );
          },
        },
      },
      {
        onSuccess: (saved) => {
          setResult(saved);
          setStep("saved");
        },
      },
    );
  };

  if (fixedProjectId === null && projects.isSuccess && activeProjects.length === 0) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>New post</DialogTitle>
          <DialogDescription>Posts belong to a project. Create a project first.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button asChild>
            <Link to="/projects">Go to projects</Link>
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (step === "saved" && result) {
    const { item, version } = result;
    const allowed = allowedActions(item.state, "user", me.role, version);
    // Ready for review (submitted on the way), in review (approved on the way), or approved.
    const schedulable =
      allowed.includes("submit") ||
      allowed.includes("approve") ||
      item.state === "approved" ||
      item.state === "scheduled";
    const missing = formatMediaIssues(version);
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
            Post saved
          </DialogTitle>
          <DialogDescription className="break-words">
            {schedulable
              ? `“${item.title}” is ready. Schedule it now, or later from its page.`
              : `“${item.title}” is saved as an idea until it has what its format needs.`}
          </DialogDescription>
        </DialogHeader>
        <p className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2.5 text-control">
          <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-green" />
          {formatLabel(item.format)} with{" "}
          {result.version.media.length === 0
            ? "its text"
            : result.version.media.length === 1
              ? "1 item"
              : `${result.version.media.length} items`}
          , saved as v{item.versionNo}.
        </p>
        {!schedulable && missing.length > 0 ? (
          <ul className="flex flex-col gap-0.5 rounded-md bg-status-amber/11 px-3 py-2 text-small text-status-amber">
            {missing.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onClose();
              void navigate({ to: "/content/$itemId", params: { itemId: item.id } });
            }}
          >
            Open post
          </Button>
          {schedulable ? (
            <Button type="button" onClick={() => setStep("schedule")}>
              Schedule now
            </Button>
          ) : (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          )}
        </DialogFooter>
      </div>
    );
  }

  if (step === "schedule" && result) {
    return (
      <div className="flex min-h-0 flex-col gap-4">
        <DialogHeader>
          <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
            Schedule “{result.item.title}”
          </DialogTitle>
          <DialogDescription>
            {result.item.state === "render" || result.item.state === "review"
              ? "It's approved and scheduled on every channel you pick, at the same time."
              : "It's scheduled on every channel you pick, at the same time."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-[60dvh] pr-1">
          <ScheduleForm
            item={result.item}
            versionId={result.version.id}
            media={result.version.media}
            defaults={{
              link,
              title: result.item.format === "video" ? result.item.title : "",
            }}
            cancelLabel="Back"
            onCancel={() => setStep("saved")}
            onDone={(posts) => {
              toast.success(`Scheduled “${result.item.title}”`, {
                description: posts.length === 1 ? "On 1 channel." : `On ${posts.length} channels.`,
              });
              onClose();
            }}
          />
        </ScrollArea>
      </div>
    );
  }

  const Icon = format ? FORMAT_ICONS[format] : ImagePlusIcon;
  const several = format ? takesSeveral(format) : false;

  return (
    <form noValidate onSubmit={submit} className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
          New post
        </DialogTitle>
        <DialogDescription>
          Compose a photo, carousel, story, text post or video from your own files. It skips
          production and goes straight to review.
        </DialogDescription>
      </DialogHeader>

      <ScrollArea className="-mx-1 min-h-0 flex-1" viewportClassName="max-h-[68dvh] px-1">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="grid content-start gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {fixedProjectId === null ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-project`}>Project</Label>
                  <Select
                    value={projectId ?? undefined}
                    onValueChange={(value) => {
                      setChosenProjectId(value);
                      setSeriesId(null);
                    }}
                    disabled={activeProjects.length === 0 || locked}
                  >
                    <SelectTrigger id={`${id}-project`} className="w-full">
                      <SelectValue placeholder="Loading projects…" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-series`}>
                  Series <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={chosenSeries ?? NO_SERIES}
                  onValueChange={(value) => setSeriesId(value === NO_SERIES ? null : value)}
                  disabled={activeSeries.length === 0 || locked}
                >
                  <SelectTrigger id={`${id}-series`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SERIES}>No series</SelectItem>
                    {activeSeries.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <FormatPicker
              channelsState={channels}
              formats={formats}
              value={format}
              disabled={locked}
              onChange={(next) => {
                setChosenFormat(next);
                setFileError(null);
              }}
            />

            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-title`}>Title</Label>
              <Input
                ref={titleRef}
                id={`${id}-title`}
                value={title}
                autoComplete="off"
                maxLength={CONTENT_TITLE_MAX_LENGTH}
                placeholder="Ferris at RustConf, in five photos"
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? `${id}-title-error` : `${id}-title-hint`}
                disabled={locked}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (titleError) setTitleError(null);
                }}
              />
              {titleError ? (
                <p id={`${id}-title-error`} className="text-small text-destructive">
                  {titleError}
                </p>
              ) : (
                <p id={`${id}-title-hint`} className="text-small text-muted-foreground">
                  For the library and the calendar; it isn't published.
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-caption`}>
                {format === "text" ? "Text" : "Caption"}{" "}
                {format === "text" ? null : (
                  <span className="font-normal text-muted-foreground">(optional)</span>
                )}
              </Label>
              <Textarea
                id={`${id}-caption`}
                value={caption}
                rows={format === "text" ? 5 : 3}
                maxLength={CAPTION_MAX_LENGTH}
                placeholder={
                  format === "text" ? "What do you want to say?" : "What the post says under it"
                }
                className="max-h-56"
                onChange={(event) => setCaption(event.target.value)}
              />
            </div>

            {format === "text" ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-link`}>
                  Link <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id={`${id}-link`}
                  type="url"
                  value={link}
                  autoComplete="off"
                  placeholder="https://"
                  aria-describedby={`${id}-link-hint`}
                  onChange={(event) => setLink(event.target.value)}
                />
                <p id={`${id}-link-hint`} className="text-small text-muted-foreground">
                  Facebook shows it as a preview card. You can change it when you schedule.
                </p>
              </div>
            ) : null}

            {format && takesMedia(format) ? (
              <fieldset className="grid gap-2">
                <legend className="mb-1 font-medium text-control">
                  {several ? "Photos and videos" : "Photo or video"}
                </legend>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut; the button picks them from the keyboard. */}
                <div
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("Files") || locked) return;
                    event.preventDefault();
                    setDropping(true);
                  }}
                  onDragLeave={() => setDropping(false)}
                  onDrop={onDrop}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center transition-colors motion-reduce:transition-none",
                    dropping ? "border-primary bg-accent-soft" : "border-input",
                  )}
                >
                  <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
                  <p className="text-control text-muted-foreground">
                    Drop files here, or{" "}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-control"
                      disabled={locked}
                      onClick={() => fileRef.current?.click()}
                    >
                      {media.length > 0 && !several ? "choose another" : "choose files"}
                    </Button>
                    .
                  </p>
                  <p className="text-small text-text-4">{mediaHint(format)}</p>
                  <input
                    ref={fileRef}
                    type="file"
                    aria-label={several ? "Add photos or videos" : "Choose a photo or video"}
                    accept={acceptFor(format)}
                    multiple={several}
                    className="sr-only"
                    tabIndex={-1}
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                </div>
                {fileError ? (
                  <p role="alert" className="text-small text-destructive">
                    {fileError}
                  </p>
                ) : null}
                {media.length > 0 ? (
                  <MediaList
                    media={media}
                    progress={progress}
                    ordered={several && media.length > 1}
                    disabled={locked}
                    onMove={(from, to) => setMedia((current) => moveEntry(current, from, to))}
                    onRemove={remove}
                    onAltText={(key, altText) =>
                      setMedia((current) =>
                        current.map((entry) => (entry.key === key ? { ...entry, altText } : entry)),
                      )
                    }
                  />
                ) : null}
              </fieldset>
            ) : null}
          </div>

          <aside aria-label="Preview" className="flex flex-col gap-2 lg:sticky lg:top-0">
            <h3 className="font-semibold text-[13px]">Preview</h3>
            {format ? (
              <PostPreview
                format={format}
                media={kept.map((entry) => ({
                  key: entry.key,
                  type: entry.type,
                  url: entry.url,
                  altText: entry.altText,
                }))}
                caption={caption}
                link={link.trim() || null}
              />
            ) : (
              <Skeleton aria-hidden="true" className="aspect-[4/5] w-full rounded-lg" />
            )}
          </aside>
        </div>
      </ScrollArea>

      <div aria-live="polite">
        {format && issues.length > 0 ? (
          <div
            data-issues=""
            className="flex items-start gap-2 rounded-md bg-status-amber/11 px-2.5 py-2 text-small text-status-amber"
          >
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <ul className="flex flex-col gap-0.5">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {save.isError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(save.error, "Couldn't save the post. Try again.")}
          {savedSoFar.item ? " What's uploaded is kept; saving again picks up from there." : null}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={save.isPending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={save.isPending || !projectId || !format}>
          {save.isPending
            ? kept.length > 0 && savedSoFar.item
              ? "Uploading…"
              : "Saving…"
            : savedSoFar.item
              ? "Try again"
              : issues.length > 0
                ? "Save draft"
                : "Save post"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The formats a channel publishes, each with the platforms that take it. Formats no channel
 * publishes are left out; without channels the picker points to Settings.
 */
function FormatPicker({
  channelsState,
  formats,
  value,
  disabled,
  onChange,
}: {
  channelsState: UseQueryResult<unknown>;
  formats: readonly PostFormat[];
  value: PostFormat | null;
  disabled: boolean;
  onChange: (format: PostFormat) => void;
}) {
  const id = useId();
  if (channelsState.isPending) {
    return (
      <div aria-hidden="true" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  }
  if (channelsState.isError) {
    return (
      <ErrorState
        size="compact"
        title="Couldn't load the channels"
        error={channelsState.error}
        onRetry={() => void channelsState.refetch()}
        retrying={channelsState.isFetching}
      />
    );
  }
  if (formats.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={RadioTowerIcon}
        title="No channels to post to"
        description="A post's format depends on where it goes. Connect an Instagram or Facebook channel first."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/channels">Open channels</Link>
          </Button>
        }
      />
    );
  }
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 font-medium text-control">Format</legend>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {formats.map((format) => {
          const Icon = FORMAT_ICONS[format];
          const selected = format === value;
          const platforms = platformsFor(format)
            .map((platform) => PLATFORM_LABELS[platform])
            .join(", ");
          return (
            <label
              key={format}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 shadow-[0_0_0_1px_var(--border)] transition-colors motion-reduce:transition-none",
                "has-focus-visible:ring-2 has-focus-visible:ring-ring",
                selected
                  ? "bg-accent-soft shadow-[0_0_0_1px_var(--primary)]"
                  : "hover:bg-secondary",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name="format"
                value={format}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(format)}
                className="sr-only"
                aria-describedby={`${id}-${format}`}
              />
              <span className="flex items-center gap-1.5 font-medium text-control">
                <Icon
                  aria-hidden="true"
                  className={cn("size-3.5", selected ? "text-primary" : "text-muted-foreground")}
                />
                {formatLabel(format)}
              </span>
              <span id={`${id}-${format}`} className="truncate text-small text-muted-foreground">
                {platforms}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
