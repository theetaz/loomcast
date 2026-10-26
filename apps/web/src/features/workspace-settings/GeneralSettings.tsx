import {
  WORKSPACE_COLORS,
  WORKSPACE_NAME_MAX_LENGTH,
  type Workspace,
  type WorkspaceColor,
  WorkspaceNameSchema,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { Input } from "@loomcast/ui/components/input";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, ImageUpIcon, TrashIcon, UserRoundIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { channelLabel, PlatformDot } from "@/features/channels/platforms";
import { channelsQueryOptions } from "@/features/channels/queries";
import { TimeZoneSelect } from "@/features/formats/TimeZoneSelect";
import { ArchiveWorkspace } from "@/features/workspace/ArchiveWorkspace";
import { WORKSPACE_COLOR_META } from "@/features/workspace/colors";
import { DescriptionEditor } from "@/features/workspace/DescriptionEditor";
import {
  useClearWorkspaceIcon,
  useSetWorkspaceIcon,
  useUpdateWorkspace,
} from "@/features/workspace/queries";
import { WorkspaceAvatar } from "@/features/workspace/WorkspaceAvatar";
import { errorMessage } from "@/lib/api";
import { IconImageError, squareIcon } from "./icon";

/**
 * Workspace settings → General: the name and description, the icon and colour the workspace is
 * recognised by, the time zone its calendar starts in, and archiving it.
 */
export function GeneralSettings({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex flex-col gap-5">
      <NameCard workspace={workspace} />
      <DescriptionEditor workspace={workspace} />
      <AppearanceCard workspace={workspace} />
      <TimeZoneCard workspace={workspace} />
      <ArchiveWorkspace workspace={workspace} />
    </div>
  );
}

function Card({
  title,
  description,
  children,
  labelledBy,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  labelledBy: string;
}) {
  return (
    <section aria-labelledby={labelledBy} className="rounded-lg bg-card shadow-card">
      <div className="flex min-h-11 flex-col justify-center gap-0.5 border-divider border-b px-3.5 py-2">
        <h2 id={labelledBy} className="font-semibold text-[13px]">
          {title}
        </h2>
        {description ? <p className="text-small text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-col gap-3 p-3.5">{children}</div>
    </section>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive">
      {children}
    </p>
  );
}

function NameCard({ workspace }: { workspace: Workspace }) {
  const id = useId();
  const [name, setName] = useState(workspace.name);
  const [invalid, setInvalid] = useState(false);
  const update = useUpdateWorkspace(workspace);
  const changed = name.trim() !== workspace.name;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending || !changed) return;
    const parsed = WorkspaceNameSchema.safeParse(name);
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    update.mutate(
      { name: parsed.data },
      {
        onSuccess: (updated) => {
          setName(updated.name);
          toast.success("Name saved", { description: updated.name });
        },
      },
    );
  };

  return (
    <Card title="Name" labelledBy={`${id}-title`}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="sr-only">
            Workspace name
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            autoComplete="off"
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setName(event.target.value);
              setInvalid(false);
            }}
          />
          <p
            id={`${id}-hint`}
            className={cn("text-small text-muted-foreground", invalid && "text-destructive")}
          >
            {invalid ? (
              "Give the workspace a name."
            ) : (
              <>
                The slug <code className="font-mono text-mono">{workspace.slug}</code> never
                changes, so links keep working.
              </>
            )}
          </p>
        </div>
        <Button type="submit" disabled={!changed || update.isPending} className="self-start">
          {update.isPending ? "Saving…" : "Save name"}
        </Button>
      </form>
      {update.isError ? (
        <ErrorNote>{errorMessage(update.error, "Couldn't save the name. Try again.")}</ErrorNote>
      ) : null}
    </Card>
  );
}

function AppearanceCard({ workspace }: { workspace: Workspace }) {
  const id = useId();
  return (
    <Card
      title="Icon and colour"
      description="How the workspace is recognised in the sidebar, the switcher and the workspace list."
      labelledBy={`${id}-title`}
    >
      <IconField workspace={workspace} />
      <ColorField workspace={workspace} />
    </Card>
  );
}

function IconField({ workspace }: { workspace: Workspace }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const setIcon = useSetWorkspaceIcon(workspace);
  const clearIcon = useClearWorkspaceIcon(workspace);
  const channels = useQuery(channelsQueryOptions(workspace.id));
  const withPictures = (channels.data?.items ?? []).filter((channel) => channel.pictureUrl);
  const busy = preparing || setIcon.isPending || clearIcon.isPending;
  const error =
    problem ??
    (setIcon.error || clearIcon.error ? errorMessage(setIcon.error ?? clearIcon.error) : null);

  const reset = () => {
    setProblem(null);
    setIcon.reset();
    clearIcon.reset();
  };

  const upload = async (file: File) => {
    reset();
    setPreparing(true);
    try {
      const body = await squareIcon(file);
      setIcon.mutate(body, { onSuccess: () => toast.success("Icon saved") });
    } catch (cause) {
      setProblem(
        cause instanceof IconImageError
          ? cause.message
          : "Couldn't read that image. Try another file.",
      );
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <WorkspaceAvatar workspace={workspace} className="size-12 rounded-[10px] text-[20px]" />
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-label="Icon image"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <ImageUpIcon aria-hidden="true" />
            {preparing || setIcon.isPending ? "Uploading…" : "Upload icon"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy || withPictures.length === 0}>
                <UserRoundIcon aria-hidden="true" />
                Use a channel's picture
                <ChevronDownIcon aria-hidden="true" className="-mr-0.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="font-normal text-muted-foreground text-small">
                Copy a profile picture
              </DropdownMenuLabel>
              <ScrollArea viewportClassName="max-h-64">
                {withPictures.map((channel) => (
                  <DropdownMenuItem
                    key={channel.id}
                    onSelect={() => {
                      reset();
                      setIcon.mutate(
                        { fromChannelId: channel.id },
                        {
                          onSuccess: () =>
                            toast.success("Icon saved", {
                              description: `From ${channelLabel(channel)}`,
                            }),
                        },
                      );
                    }}
                  >
                    <PlatformDot platform={channel.platform} />
                    <span className="min-w-0 truncate">{channelLabel(channel)}</span>
                  </DropdownMenuItem>
                ))}
              </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
          {workspace.iconUrl ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                reset();
                clearIcon.mutate(undefined, { onSuccess: () => toast.success("Icon removed") });
              }}
            >
              <TrashIcon aria-hidden="true" />
              {clearIcon.isPending ? "Removing…" : "Remove icon"}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-small text-muted-foreground">
        PNG, JPEG or WebP. It is cropped to a square and resized to 256 × 256.
        {withPictures.length === 0 && channels.isSuccess
          ? " Connect a channel to use its profile picture."
          : ""}
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function ColorField({ workspace }: { workspace: Workspace }) {
  const id = useId();
  const update = useUpdateWorkspace(workspace);
  const [pending, setPending] = useState<WorkspaceColor | null>(null);
  const value = pending ?? workspace.color;

  const choose = (color: WorkspaceColor) => {
    if (color === workspace.color) return;
    setPending(color);
    update.mutate(
      { color },
      {
        onSuccess: () =>
          toast.success("Colour saved", { description: WORKSPACE_COLOR_META[color].label }),
        onSettled: () => setPending(null),
      },
    );
  };

  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-hint`}>
      <legend className="mb-2 font-medium text-control">Colour</legend>
      <div className="flex flex-wrap gap-2">
        {WORKSPACE_COLORS.map((color) => {
          const meta = WORKSPACE_COLOR_META[color];
          const checked = value === color;
          return (
            <label key={color} className="relative cursor-pointer" title={meta.label}>
              <input
                type="radio"
                name={`${id}-color`}
                value={color}
                checked={checked}
                aria-label={meta.label}
                className="peer sr-only"
                onChange={() => choose(color)}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-white transition-transform duration-150 ease-out active:scale-[0.94]",
                  "ring-offset-2 ring-offset-card peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                  meta.solid,
                  checked && "ring-2 ring-foreground/70",
                )}
              >
                {checked ? <CheckIcon className="size-3.5 drop-shadow-sm" /> : null}
              </span>
            </label>
          );
        })}
      </div>
      <p id={`${id}-hint`} className="text-small text-muted-foreground">
        Shown behind the initial while the workspace has no icon.
      </p>
      {update.isError ? (
        <ErrorNote>{errorMessage(update.error, "Couldn't save the colour. Try again.")}</ErrorNote>
      ) : null}
    </fieldset>
  );
}

function TimeZoneCard({ workspace }: { workspace: Workspace }) {
  const id = useId();
  const update = useUpdateWorkspace(workspace);
  const [pending, setPending] = useState<string | null>(null);

  return (
    <Card
      title="Time zone"
      description="The calendar shows this time zone unless you pick another."
      labelledBy={`${id}-title`}
    >
      <div className="max-w-sm">
        <label htmlFor={`${id}-zone`} className="sr-only">
          Time zone
        </label>
        <TimeZoneSelect
          id={`${id}-zone`}
          value={pending ?? workspace.timeZone}
          onChange={(zone) => {
            if (zone === workspace.timeZone) return;
            setPending(zone);
            update.mutate(
              { timeZone: zone },
              {
                onSuccess: () =>
                  toast.success("Time zone saved", { description: zone.replaceAll("_", " ") }),
                onSettled: () => setPending(null),
              },
            );
          }}
        />
      </div>
      {update.isError ? (
        <ErrorNote>
          {errorMessage(update.error, "Couldn't save the time zone. Try again.")}
        </ErrorNote>
      ) : null}
    </Card>
  );
}
