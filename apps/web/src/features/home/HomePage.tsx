import type { Device } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, FolderIcon, LaptopIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Page, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { useMe } from "@/features/auth/queries";
import {
  describeStudio,
  devicesQueryOptions,
  STUDIO_LABELS,
  summarizeStudio,
} from "@/features/devices/queries";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";
import { ProjectRow, ProjectRowsSkeleton } from "@/features/projects/ProjectRow";
import { projectsQueryOptions } from "@/features/projects/queries";
import { useTitle } from "@/lib/use-title";

const RECENT_LIMIT = 5;

function greeting(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function firstName(name: string, email: string): string {
  return name.trim().split(/\s+/)[0] || email.split("@")[0] || "there";
}

function Panel({
  title,
  aside,
  children,
  footer,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 items-center gap-3 border-divider border-b pr-2 pl-3.5">
        <h2 className="font-semibold text-[13px]">{title}</h2>
        {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
      </div>
      <div className="flex-1">{children}</div>
      {footer ? (
        <div className="border-divider border-t bg-secondary/60 px-3.5 py-2.5 text-small text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function RecentProjects() {
  const query = useQuery(projectsQueryOptions());
  const recent = query.data
    ?.filter((project) => project.status === "active")
    .slice(0, RECENT_LIMIT);

  return (
    <Panel
      title="Recent projects"
      aside={
        <Button asChild variant="ghost" size="sm">
          <Link to="/projects">
            View all
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </Link>
        </Button>
      }
    >
      {query.isPending ? (
        <ProjectRowsSkeleton rows={4} />
      ) : query.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't load projects"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : !recent?.length ? (
        <EmptyState
          size="compact"
          icon={FolderIcon}
          title="No projects yet"
          description="Create a project for a series or topic, then plan its videos with the studio agent."
          action={
            <NewProjectDialog>
              <Button variant="outline">
                <PlusIcon aria-hidden="true" />
                New project
              </Button>
            </NewProjectDialog>
          }
        />
      ) : (
        <ul aria-label="Recent projects">
          {recent.map((project) => (
            <li key={project.id} className="border-divider border-t first:border-t-0">
              <ProjectRow project={project} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DeviceRow({ device }: { device: Device }) {
  return (
    <li className="flex h-10 items-center gap-3 border-divider border-t px-3.5 first:border-t-0">
      <LaptopIcon aria-hidden="true" className="size-[15px] shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-body">{device.name}</span>
        <span className="hidden truncate font-mono text-mono text-muted-foreground sm:inline">
          {device.platform}
        </span>
      </span>
      {!device.online && device.lastSeenAt ? (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          <span className="sr-only">last seen </span>
          <RelativeTime value={device.lastSeenAt} />
        </span>
      ) : null}
      <StatusPill kind="device" status={device.online ? "online" : "offline"} />
    </li>
  );
}

function StudioPanel() {
  const query = useQuery(devicesQueryOptions());
  const summary = query.isSuccess ? summarizeStudio(query.data) : null;

  return (
    <Panel
      title="Studio"
      aside={
        summary && summary.state !== "unpaired" ? (
          <StatusPill kind="device" status={summary.state === "online" ? "online" : "offline"}>
            {STUDIO_LABELS[summary.state]}
          </StatusPill>
        ) : null
      }
      footer={summary && summary.state !== "unpaired" ? describeStudio(summary) : undefined}
    >
      {query.isPending ? (
        <div aria-hidden="true">
          {["60%", "45%"].map((width) => (
            <div
              key={width}
              className="flex h-10 items-center gap-3 border-divider border-t px-3.5 first:border-t-0"
            >
              <Skeleton className="size-[15px] rounded-sm" />
              <div className="flex-1">
                <Skeleton className="h-3" style={{ width }} />
              </div>
              <Skeleton className="h-[21px] w-14 rounded-full" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          size="compact"
          title="Couldn't check the studio"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.length === 0 ? (
        <EmptyState
          size="compact"
          icon={LaptopIcon}
          title="No studio agent paired"
          description="Pair the studio agent on your computer to render videos and answer chats."
          action={
            <Button asChild variant="outline">
              <Link to="/settings/devices">Pair a device</Link>
            </Button>
          }
        />
      ) : (
        <ul aria-label="Studio agents">
          {query.data.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function HomePage() {
  useTitle("Home");
  const me = useMe();

  return (
    <Page>
      <PageHeader
        title={`${greeting(new Date().getHours())}, ${firstName(me.name, me.email)}`}
        description="Your latest projects and the state of the studio."
        actions={
          <NewProjectDialog>
            <Button>
              <PlusIcon aria-hidden="true" />
              New project
            </Button>
          </NewProjectDialog>
        }
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <RecentProjects />
        <StudioPanel />
      </div>
    </Page>
  );
}
