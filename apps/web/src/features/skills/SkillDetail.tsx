import {
  PROGRESS_STEP_LABELS,
  type SkillFile,
  type SkillUsageItem,
  type SkillVersionDetail,
  type SkillVersionSummary,
} from "@loomcast/contracts";
import { Badge } from "@loomcast/ui/components/badge";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileTextIcon, LoaderCircleIcon, PuzzleIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { useMe } from "@/features/auth/queries";
import { Markdown } from "@/features/conversation/Markdown";
import { useTitle } from "@/lib/use-title";
import {
  isMarkdownPath,
  skillDetailQueryOptions,
  skillUsageQueryOptions,
  skillVersionsQueryOptions,
  sortSkillFiles,
  useSkillsLive,
} from "./queries";
import { itemCount } from "./SkillsCatalogue";

export interface SkillDetailProps {
  name: string;
  /** The version shown; the latest when left out. */
  version?: number;
  /** The file shown; `SKILL.md` (else the first file) when left out. */
  file?: string;
  onSelect: (selection: { version?: number; file?: string }) => void;
}

/** Who published a version, as the signed-in user can tell. */
export function publisherLabel(publishedByUser: string | null, meId: string): string {
  if (publishedByUser === null) return "An access token";
  return publishedByUser === meId ? "You" : "Another user";
}

const bytesFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${bytesFormat.format(bytes / 1024)} KB`;
}

/** One skill: its files at a version, every version with its changelog, and where it was used. */
export function SkillDetail({ name, version, file, onSelect }: SkillDetailProps) {
  useTitle(`${name} · Skills`);
  useSkillsLive();
  const detail = useQuery(skillDetailQueryOptions(name, version));
  const latest = useQuery(skillDetailQueryOptions(name));
  const versions = useQuery(skillVersionsQueryOptions(name));
  const usage = useQuery(skillUsageQueryOptions(name));

  if (detail.isError) {
    return (
      <Page>
        <ErrorState
          title="Couldn't load the skill"
          error={detail.error}
          onRetry={() => void detail.refetch()}
          retrying={detail.isFetching}
        />
      </Page>
    );
  }

  const shown = detail.data;
  const description = latest.data ? descriptionOf(latest.data) : null;

  return (
    <Page>
      <PageHeader
        title={<span className="font-mono">{name}</span>}
        description={
          detail.isPending
            ? null
            : shown === null
              ? "Producers reported this skill, but no version of it has been published."
              : description
        }
        actions={
          shown ? (
            <>
              <Badge variant={shown.kind === "recipe" ? "default" : "secondary"}>
                {shown.kind}
              </Badge>
              {latest.data ? <Badge variant="outline">Latest v{latest.data.version}</Badge> : null}
            </>
          ) : null
        }
      />
      {detail.isPending ? (
        <Skeleton aria-busy="true" className="h-80 rounded-lg" />
      ) : !shown ? null : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <FileViewer
            detail={shown}
            file={file}
            isLatest={latest.data?.version === shown.version}
            onFile={(path) => onSelect({ version, file: path })}
          />
          <VersionHistory
            versions={versions.data}
            loading={versions.isPending}
            selected={shown.version}
            latest={latest.data?.version}
            onVersion={(next) =>
              onSelect({ version: next === latest.data?.version ? undefined : next })
            }
          />
        </div>
      )}
      <UsedIn
        items={usage.data}
        loading={usage.isPending}
        error={usage.isError ? usage.error : null}
        onRetry={() => void usage.refetch()}
      />
    </Page>
  );
}

function descriptionOf(detail: SkillVersionDetail): string | null {
  const manifest = detail.files.find((entry) => entry.path === "skill.json");
  if (manifest === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(manifest.content);
    if (parsed !== null && typeof parsed === "object" && "description" in parsed) {
      const value = (parsed as { description: unknown }).description;
      return typeof value === "string" ? value : null;
    }
  } catch {
    // An unreadable manifest has no description to show.
  }
  return null;
}

function FileViewer({
  detail,
  file,
  isLatest,
  onFile,
}: {
  detail: SkillVersionDetail;
  file: string | undefined;
  isLatest: boolean;
  onFile: (path: string) => void;
}) {
  const files = useMemo(() => sortSkillFiles(detail.files), [detail.files]);
  const current: SkillFile | undefined = files.find((entry) => entry.path === file) ?? files[0];

  return (
    <section
      aria-labelledby="skill-files-title"
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex items-center gap-2 border-divider border-b px-4 py-2.5">
        <h2 id="skill-files-title" className="text-heading text-foreground">
          Files
        </h2>
        <span className="text-small text-muted-foreground">
          v{detail.version}
          {isLatest ? ", latest" : ""} · {detail.fileCount}{" "}
          {detail.fileCount === 1 ? "file" : "files"} · {formatBytes(detail.bytes)}
        </span>
      </div>
      <ScrollArea orientation="horizontal" className="border-divider border-b">
        <div role="tablist" aria-label="Files" className="flex w-max gap-1 px-3 py-2">
          {files.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="tab"
              aria-selected={entry.path === current?.path}
              onClick={() => onFile(entry.path)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-mono text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                entry.path === current?.path
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <FileTextIcon aria-hidden="true" className="size-3.5" />
              {entry.path}
            </button>
          ))}
        </div>
      </ScrollArea>
      {current ? (
        <div role="tabpanel" aria-label={current.path} className="min-w-0 px-4 py-3">
          {isMarkdownPath(current.path) ? (
            <Markdown text={current.content} className="leading-relaxed" />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-text-2">
              {current.content}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}

function VersionHistory({
  versions,
  loading,
  selected,
  latest,
  onVersion,
}: {
  versions: SkillVersionSummary[] | undefined;
  loading: boolean;
  selected: number;
  latest: number | undefined;
  onVersion: (version: number) => void;
}) {
  const me = useMe();
  return (
    <section aria-labelledby="skill-versions-title" className="flex flex-col gap-2">
      <h2 id="skill-versions-title" className="text-heading text-foreground">
        Versions
      </h2>
      {loading ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : (
        <ol className="overflow-hidden rounded-lg bg-card shadow-card">
          {(versions ?? []).map((entry) => (
            <li key={entry.version} className="border-divider border-b last:border-b-0">
              <button
                type="button"
                aria-current={entry.version === selected ? "true" : undefined}
                onClick={() => onVersion(entry.version)}
                className={cn(
                  "flex w-full flex-col gap-0.5 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                  entry.version === selected && "bg-secondary/70",
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-medium font-mono text-[13px] text-foreground">
                    v{entry.version}
                  </span>
                  {entry.version === latest ? (
                    <span className="text-small text-status-green">Latest</span>
                  ) : null}
                  <RelativeTime
                    value={entry.publishedAt}
                    className="ml-auto text-small text-muted-foreground"
                  />
                </span>
                <span className="text-control text-text-2">
                  {entry.changelog ?? <span className="text-text-4">No changelog</span>}
                </span>
                <span className="text-small text-muted-foreground">
                  {publisherLabel(entry.publishedByUser, me.id)} · {entry.fileCount}{" "}
                  {entry.fileCount === 1 ? "file" : "files"}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function UsedIn({
  items,
  loading,
  error,
  onRetry,
}: {
  items: SkillUsageItem[] | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="skill-used-title" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 id="skill-used-title" className="text-heading text-foreground">
          Used in
        </h2>
        {items ? (
          <span className="text-small text-muted-foreground">{itemCount(items.length)}</span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-lg bg-card shadow-card">
        {loading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <ErrorState
            size="compact"
            title="Couldn't load where the skill was used"
            error={error}
            onRetry={onRetry}
          />
        ) : (items ?? []).length === 0 ? (
          <EmptyState
            size="compact"
            icon={PuzzleIcon}
            title="Not used yet"
            description="Items show up here once a producer reports a step made with this skill."
          />
        ) : (
          <ul>
            {(items ?? []).map((item) => (
              <li
                key={item.itemId}
                className="relative flex items-center gap-3 border-divider border-b px-3.5 py-2.5 transition-colors last:border-b-0 hover:bg-accent has-[a:focus-visible]:bg-accent"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link
                    to="/w/$workspace/content/$itemId"
                    params={{ workspace: item.workspaceSlug, itemId: item.itemId }}
                    className="truncate font-medium text-foreground outline-none after:absolute after:inset-0 after:content-['']"
                  >
                    {item.title}
                  </Link>
                  <span className="truncate text-small text-muted-foreground">
                    {item.workspaceName} · used in{" "}
                    {item.steps.map((key) => PROGRESS_STEP_LABELS[key]).join(", ")}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-small text-text-2">
                  {item.health === "failed" ? (
                    <TriangleAlertIcon aria-hidden="true" className="size-3.5 text-status-red" />
                  ) : item.health === "active" ? (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="size-3.5 text-status-blue motion-safe:animate-spin"
                    />
                  ) : null}
                  {PROGRESS_STEP_LABELS[item.stage]}
                  {item.health === "failed" ? <span className="sr-only">, failed</span> : null}
                </span>
                <RelativeTime
                  value={item.lastUsedAt}
                  className="hidden w-12 shrink-0 text-right text-small text-muted-foreground sm:block"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
