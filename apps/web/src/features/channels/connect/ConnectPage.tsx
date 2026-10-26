import type {
  AcceptConnectionResponse,
  CandidateAccount,
  ConnectionCandidates,
  OAuthConnectSearch,
  OAuthProvider,
  Workspace,
} from "@loomcast/contracts";
import { Avatar, AvatarFallback, AvatarImage } from "@loomcast/ui/components/avatar";
import { Button } from "@loomcast/ui/components/button";
import { Label } from "@loomcast/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ClockIcon, type LucideIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";
import { Page, PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { pickHomeWorkspace } from "@/features/workspace/home";
import { WorkspaceAvatar } from "@/features/workspace/WorkspaceAvatar";
import { workspacesQueryOptions } from "@/features/workspaces/queries";
import { errorMessage, isApiError } from "@/lib/api";
import { initials } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { channelLabel, PLATFORM_META, PlatformTile, platformLabel } from "../platforms";
import { Checkbox } from "./Checkbox";
import { connectReturnPath, readConnectWorkspace, startOAuth } from "./navigation";
import { connectErrorText, connectProviders, PROVIDER_META } from "./providers";
import { connectionQueryOptions, useAcceptConnection, useXPublishing } from "./queries";
import { orderCandidates, toggleCandidate } from "./selection";

/**
 * Where a sign-in comes back to (`/channels/connect`), outside any workspace. With `?connection=`
 * it lists the accounts the sign-in can publish as and asks which workspace they join, starting
 * from the one the sign-in began in; with `?error=` it says what went wrong; with neither it offers
 * the sign-ins.
 */
export function ConnectPage({ search }: { search: OAuthConnectSearch }) {
  const workspaces = useQuery(workspacesQueryOptions());
  const active = useMemo(
    () => (workspaces.data ?? []).filter((workspace) => workspace.status === "active"),
    [workspaces.data],
  );
  const [chosenId, setChosenId] = useState<string | null>(readConnectWorkspace);
  const workspace =
    active.find((entry) => entry.id === chosenId) ?? pickHomeWorkspace(active) ?? null;

  return (
    <Page className="max-w-[760px]">
      <PageHeader
        title="Connect channels"
        description="Choose the accounts Loomcast may publish as, and the workspace they belong to."
      />
      {search.error ? (
        <SignInFailed error={search.error} provider={search.provider} workspace={workspace} />
      ) : search.connection ? (
        <AccountPicker
          key={search.connection}
          connectionId={search.connection}
          provider={search.provider}
          workspaces={active}
          workspacesPending={workspaces.isPending}
          workspace={workspace}
          onWorkspaceChange={setChosenId}
        />
      ) : (
        <ChooseProvider workspace={workspace} />
      )}
    </Page>
  );
}

/** Whether the server lets `provider` sign in: X only behind its flag. */
function useCanSignIn(): (provider: OAuthProvider | undefined) => provider is OAuthProvider {
  const xPublishing = useXPublishing();
  return (provider): provider is OAuthProvider =>
    provider !== undefined && connectProviders(xPublishing).includes(provider);
}

function BackToChannels({
  workspace,
  children = "Back to channels",
}: {
  workspace: Workspace | null;
  children?: ReactNode;
}) {
  return (
    <Button asChild variant="outline">
      {workspace ? (
        <Link to="/w/$workspace/settings/channels" params={{ workspace: workspace.slug }}>
          {children}
        </Link>
      ) : (
        <Link to="/workspaces">{children}</Link>
      )}
    </Button>
  );
}

/** A centred outcome inside the card: what happened and what to do next. */
function Outcome({
  icon: Icon,
  tone,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  tone: "amber" | "red";
  title: string;
  description: string;
  actions: ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2.5 px-6 py-12 text-center">
      <span
        className={cn(
          "flex size-9 items-center justify-center rounded-lg",
          tone === "red"
            ? "bg-status-red/11 text-status-red"
            : "bg-status-amber/11 text-status-amber",
        )}
      >
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <p className="text-heading text-foreground">{title}</p>
        <p className="text-control text-muted-foreground text-pretty">{description}</p>
      </div>
      <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>
    </div>
  );
}

function SignInAgain({
  provider,
  workspace,
}: {
  provider: OAuthProvider;
  workspace: Workspace | null;
}) {
  if (!workspace) return null;
  return <Button onClick={() => startOAuth(provider, workspace)}>Sign in again</Button>;
}

function SignInFailed({
  error,
  provider,
  workspace,
}: {
  error: NonNullable<OAuthConnectSearch["error"]>;
  provider: OAuthProvider | undefined;
  workspace: Workspace | null;
}) {
  const canSignIn = useCanSignIn();
  const { title, description } = connectErrorText(error, provider);
  const retry = error !== "not_configured" && canSignIn(provider);
  return (
    <SettingsCard title="Connect an account">
      <Outcome
        icon={TriangleAlertIcon}
        tone={error === "access_denied" ? "amber" : "red"}
        title={title}
        description={description}
        actions={
          <>
            {retry ? <SignInAgain provider={provider} workspace={workspace} /> : null}
            <BackToChannels workspace={workspace} />
          </>
        }
      />
    </SettingsCard>
  );
}

function Expired({
  provider,
  workspace,
}: {
  provider: OAuthProvider | undefined;
  workspace: Workspace | null;
}) {
  const canSignIn = useCanSignIn();
  return (
    <SettingsCard title="Choose accounts">
      <Outcome
        icon={ClockIcon}
        tone="amber"
        title="This sign-in has expired"
        description="A sign-in stays open for 30 minutes and connects once. Nothing was connected; sign in again to choose the accounts."
        actions={
          <>
            {canSignIn(provider) ? <SignInAgain provider={provider} workspace={workspace} /> : null}
            <BackToChannels workspace={workspace} />
          </>
        }
      />
    </SettingsCard>
  );
}

/** No sign-in to finish: the sign-ins the server offers, for the workspace that would get them. */
function ChooseProvider({ workspace }: { workspace: Workspace | null }) {
  const providers = connectProviders(useXPublishing());
  return (
    <SettingsCard title="Connect an account">
      <p className="border-divider border-b px-3.5 py-2.5 text-control text-muted-foreground text-pretty">
        Sign in with the platform, then choose the accounts Loomcast may publish as
        {workspace ? ` in ${workspace.name}` : ""}. New channels start in dry-run.
      </p>
      <ul aria-label="Sign-ins">
        {providers.map((provider) => {
          const meta = PROVIDER_META[provider];
          return (
            <li
              key={provider}
              className="flex items-center gap-3 border-divider border-t px-3.5 py-3 first:border-t-0"
            >
              <PlatformTile platform={meta.platform} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-body text-foreground">{meta.label}</span>
                <span className="text-small text-muted-foreground">{meta.hint}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Sign in with ${meta.signIn}`}
                disabled={!workspace}
                onClick={() => workspace && startOAuth(provider, workspace)}
              >
                Sign in
              </Button>
            </li>
          );
        })}
      </ul>
    </SettingsCard>
  );
}

interface WorkspaceChoice {
  workspaces: Workspace[];
  workspacesPending: boolean;
  /** The workspace the accounts join; null while the workspaces load or when there is none. */
  workspace: Workspace | null;
  onWorkspaceChange: (id: string) => void;
}

function AccountPicker({
  connectionId,
  provider,
  ...choice
}: {
  connectionId: string;
  provider: OAuthProvider | undefined;
} & WorkspaceChoice) {
  const query = useQuery(connectionQueryOptions(connectionId));
  const now = useNow();
  const [expired, setExpired] = useState(false);

  if (query.isPending) return <PickerSkeleton />;
  if (query.isError) {
    if (isApiError(query.error, 410)) {
      return <Expired provider={provider} workspace={choice.workspace} />;
    }
    return (
      <SettingsCard title="Choose accounts">
        <ErrorState
          size="compact"
          title={
            isApiError(query.error, 404) ? "No sign-in to finish" : "Couldn't load the accounts"
          }
          error={query.error}
          onRetry={isApiError(query.error, 404) ? undefined : () => void query.refetch()}
          retrying={query.isFetching}
          action={<BackToChannels workspace={choice.workspace} />}
        />
      </SettingsCard>
    );
  }
  if (expired || Date.parse(query.data.expiresAt) <= now) {
    return <Expired provider={query.data.provider} workspace={choice.workspace} />;
  }
  return <Picker connection={query.data} onExpired={() => setExpired(true)} {...choice} />;
}

function PickerSkeleton() {
  return (
    <SettingsCard title="Choose accounts" busy>
      <div aria-hidden="true">
        {["w-48", "w-40", "w-44"].map((width) => (
          <div
            key={width}
            className="flex items-center gap-3 border-divider border-t px-3.5 py-3 first:border-t-0"
          >
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className={cn("h-3", width)} />
              <Skeleton className="h-2.5 w-24" />
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

function connectedToast(result: AcceptConnectionResponse) {
  const [first, ...rest] = result.channels;
  if (!first) return;
  toast.success(
    rest.length === 0
      ? `Connected ${channelLabel(first)}`
      : `Connected ${result.channels.length} channels`,
    {
      description:
        rest.length === 0
          ? "New channels dry-run until you switch dry run off."
          : `${result.channels.map(channelLabel).join(", ")}. New channels dry-run until you switch dry run off.`,
    },
  );
}

/** The workspace a `409 channel_in_other_workspace` names, from its details. */
function otherWorkspaceName(error: unknown): string | null {
  if (!isApiError(error, 409) || error.code !== "channel_in_other_workspace") return null;
  const name = (error.details as { workspaceName?: unknown } | undefined)?.workspaceName;
  return typeof name === "string" && name ? name : "another workspace";
}

function Picker({
  connection,
  onExpired,
  workspaces,
  workspacesPending,
  workspace,
  onWorkspaceChange,
}: {
  connection: ConnectionCandidates;
  onExpired: () => void;
} & WorkspaceChoice) {
  const id = useId();
  const navigate = useNavigate();
  const accept = useAcceptConnection(connection.id);
  const accounts = useMemo(() => orderCandidates(connection.accounts), [connection.accounts]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => {
    const only = accounts.length === 1 ? accounts[0] : undefined;
    return new Set(only ? [only.id] : []);
  });
  const names = new Map(accounts.map((account) => [account.id, account.name]));
  const signIn = PROVIDER_META[connection.provider].signIn;
  const count = selected.size;
  const otherWorkspace = otherWorkspaceName(accept.error);

  const submit = () => {
    if (count === 0 || accept.isPending || !workspace) return;
    const target = workspace;
    accept.mutate(
      {
        workspaceId: target.id,
        accountIds: accounts
          .filter((account) => selected.has(account.id))
          .map((account) => account.id),
      },
      {
        onSuccess: (result) => {
          connectedToast(result);
          void navigate({ to: connectReturnPath(target), replace: true });
        },
        onError: (error) => {
          if (isApiError(error, 410)) onExpired();
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <SettingsCard title="Choose accounts" count={accounts.length}>
        <p className="border-divider border-b px-3.5 py-2.5 text-control text-muted-foreground text-pretty">
          Signed in with {signIn}. Choose the accounts Loomcast may publish as; new channels start
          in dry-run. This sign-in expires{" "}
          <RelativeTime value={connection.expiresAt} format="relative" />.
        </p>
        <ul aria-label="Accounts to connect">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              id={`${id}-${account.id}`}
              account={account}
              parentName={account.parentId ? names.get(account.parentId) : undefined}
              checked={selected.has(account.id)}
              disabled={accept.isPending}
              onCheckedChange={(checked) =>
                setSelected((current) => toggleCandidate(accounts, current, account.id, checked))
              }
            />
          ))}
        </ul>
      </SettingsCard>

      <WorkspaceField
        workspaces={workspaces}
        pending={workspacesPending}
        workspace={workspace}
        disabled={accept.isPending}
        onChange={(id) => {
          accept.reset();
          onWorkspaceChange(id);
        }}
      />

      {accept.error && !isApiError(accept.error, 410) ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {otherWorkspace
            ? `An account you chose is already connected in ${otherWorkspace}. An account belongs to one workspace, so connect it from ${otherWorkspace} instead.`
            : errorMessage(accept.error, "Couldn't connect the accounts. Try again.")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <p aria-live="polite" className="mr-auto px-1 text-small text-muted-foreground">
          {count === 0 ? "No account chosen" : `${count} of ${accounts.length} chosen`}
        </p>
        <BackToChannels workspace={workspace}>Cancel</BackToChannels>
        <Button onClick={submit} disabled={count === 0 || accept.isPending || !workspace}>
          {accept.isPending
            ? "Connecting…"
            : count <= 1
              ? "Connect account"
              : `Connect ${count} accounts`}
        </Button>
      </div>
    </div>
  );
}

/** Which workspace the accounts join. Every workspace has its own channels. */
function WorkspaceField({
  workspaces,
  pending,
  workspace,
  disabled,
  onChange,
}: {
  workspaces: Workspace[];
  pending: boolean;
  workspace: Workspace | null;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-card px-3.5 py-3 shadow-card sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label htmlFor={`${id}-workspace`}>Connect to workspace</Label>
        <p id={`${id}-hint`} className="text-small text-muted-foreground">
          The channels appear in this workspace only.
        </p>
      </div>
      {!pending && workspaces.length === 0 ? (
        <p className="text-small text-muted-foreground">
          No active workspace.{" "}
          <Link to="/workspaces" className="text-foreground underline underline-offset-2">
            Create one first
          </Link>
          .
        </p>
      ) : (
        <Select value={workspace?.id ?? ""} onValueChange={onChange} disabled={disabled || pending}>
          <SelectTrigger
            id={`${id}-workspace`}
            aria-describedby={`${id}-hint`}
            className="w-full sm:w-64"
          >
            <SelectValue placeholder="Loading workspaces…" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                <WorkspaceAvatar workspace={entry} />
                <span className="truncate">{entry.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function AccountRow({
  id,
  account,
  parentName,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  account: CandidateAccount;
  parentName: string | undefined;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const child = account.parentId !== null;
  const details = [
    platformLabel(account.platform),
    account.username && account.username !== account.name ? `@${account.username}` : null,
    parentName ? `through ${parentName}` : null,
  ].filter(Boolean);
  return (
    <li data-account-id={account.id} className="border-divider border-t first:border-t-0">
      <label
        htmlFor={id}
        className={cn(
          "flex cursor-pointer items-center gap-3 py-2.5 pr-3.5 pl-3.5 transition-colors",
          "[@media(hover:hover)]:hover:bg-accent/50",
          child && "sm:pl-10",
          disabled && "cursor-not-allowed",
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-label={channelLabel({ displayName: account.name, platform: account.platform })}
          aria-describedby={`${id}-details`}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <InitialsAvatar
          name={account.name}
          platform={account.platform}
          pictureUrl={account.pictureUrl}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-body text-foreground">{account.name}</span>
          <span id={`${id}-details`} className="truncate text-small text-muted-foreground">
            {details.join(" · ")}
            {account.alreadyConnected ? (
              <span className="sr-only">
                , already connected: connecting it again refreshes its access
              </span>
            ) : null}
          </span>
        </span>
        {account.alreadyConnected ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-green/11 px-2 py-0.5 text-[11.5px] text-status-green">
            <CheckIcon aria-hidden="true" className="size-3" />
            Connected
          </span>
        ) : null}
      </label>
    </li>
  );
}

/**
 * The account's profile picture in a circle, with its platform's colour as a dot; its initials
 * while the picture loads, when it fails, or when there is none. The picture comes through the
 * API: the content security policy allows no image hosts.
 */
function InitialsAvatar({
  name,
  platform,
  pictureUrl,
}: {
  name: string;
  platform: CandidateAccount["platform"];
  pictureUrl?: string | null | undefined;
}) {
  const letters = initials(name.replace(/^@/, ""));
  return (
    <span
      aria-hidden="true"
      className="relative flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-accent font-medium text-[11.5px] text-text-2"
    >
      {pictureUrl ? (
        <Avatar className="size-full">
          <AvatarImage src={pictureUrl} alt="" />
          <AvatarFallback className="text-[11.5px]">{letters}</AvatarFallback>
        </Avatar>
      ) : (
        letters
      )}
      <span
        className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card"
        style={{ background: PLATFORM_META[platform]?.color }}
      />
    </span>
  );
}
