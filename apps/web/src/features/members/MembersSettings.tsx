import type { Me, UserSummary } from "@loomcast/contracts";
import { Avatar, AvatarFallback } from "@loomcast/ui/components/avatar";
import { Badge } from "@loomcast/ui/components/badge";
import { Button } from "@loomcast/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loomcast/ui/components/dropdown-menu";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery } from "@tanstack/react-query";
import {
  BanIcon,
  EllipsisIcon,
  Link2Icon,
  ShieldIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { useMe } from "@/features/auth/queries";
import { RevokeDialog } from "@/features/settings/RevokeDialog";
import { SettingsCard, TableSkeleton, td, th } from "@/features/settings/SettingsCard";
import { initials } from "@/lib/format";
import { InviteDialog } from "./InviteDialog";
import { type MemberStatus, memberStatus, membersQueryOptions, useDisableMember } from "./queries";
import { ResetLinkDialog } from "./ResetLinkDialog";

/** Owner only: the people who can sign in, invitations, reset links and disabling access. */
export function MembersSettings() {
  const me = useMe();
  if (me.role !== "owner") return <OwnerOnly />;
  return <MembersList me={me} />;
}

function OwnerOnly() {
  return (
    <div className="rounded-lg bg-card shadow-card">
      <EmptyState
        icon={ShieldIcon}
        title="Only the owner manages members"
        description="Ask the workspace owner to invite someone or to send a new password link."
      />
    </div>
  );
}

function InviteButton({ size }: { size?: "sm" }) {
  return (
    <InviteDialog>
      <Button size={size}>
        <UserPlusIcon aria-hidden="true" />
        Invite member
      </Button>
    </InviteDialog>
  );
}

function MembersList({ me }: { me: Me }) {
  const query = useQuery(membersQueryOptions());
  const disable = useDisableMember();
  // Targets outlive the open flags so dialogs keep their titles while they fade out.
  const [disableTarget, setDisableTarget] = useState<UserSummary | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const confirmDisable = () => {
    if (!disableTarget) return;
    disable.mutate(disableTarget, {
      onSuccess: (user) => {
        setConfirmingDisable(false);
        toast.success("Access disabled", { description: user.name || user.email });
      },
    });
  };

  return (
    <div className="grid gap-4">
      <SettingsCard
        title="Members"
        count={query.isSuccess ? query.data.length : null}
        busy={query.isPending}
        action={<InviteButton size="sm" />}
      >
        {query.isPending ? (
          <TableSkeleton columns={["w-12", "w-10", "w-12"]} />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load members"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <>
            <MembersTable
              members={query.data}
              me={me}
              onReset={(user) => {
                setResetTarget(user);
                setResetOpen(true);
              }}
              onDisable={(user) => {
                disable.reset();
                setDisableTarget(user);
                setConfirmingDisable(true);
              }}
            />
            {query.data.length <= 1 ? (
              <EmptyState
                size="compact"
                icon={UsersIcon}
                title="It's just you so far"
                description="Invite the people you make videos with. Each gets a link to choose a password."
                className="border-divider border-t"
              />
            ) : null}
          </>
        )}
      </SettingsCard>

      <ResetLinkDialog user={resetTarget} open={resetOpen} onOpenChange={setResetOpen} />

      <RevokeDialog
        open={confirmingDisable}
        onOpenChange={setConfirmingDisable}
        title={`Disable ${disableTarget?.name || disableTarget?.email || "this member"}?`}
        description="They are signed out everywhere and can't sign in again. Their access tokens and unused links stop working, and the studio devices they paired are disconnected and revoked; their work stays in the workspace."
        confirmLabel="Disable access"
        pendingLabel="Disabling…"
        pending={disable.isPending}
        error={disable.error}
        onConfirm={confirmDisable}
      />
    </div>
  );
}

interface MembersTableProps {
  members: UserSummary[];
  me: Me;
  onReset: (user: UserSummary) => void;
  onDisable: (user: UserSummary) => void;
}

function MembersTable({ members, me, onReset, onDisable }: MembersTableProps) {
  return (
    <table aria-label="Members" className="w-full table-fixed text-left">
      <thead>
        <tr className="h-9 border-divider border-b">
          <th scope="col" className={th("pl-3.5")}>
            Member
          </th>
          <th scope="col" className={th("hidden w-[84px] sm:table-cell")}>
            Role
          </th>
          <th scope="col" className={th("hidden w-[96px] text-right md:table-cell")}>
            Last sign-in
          </th>
          <th scope="col" className={th("w-[92px]")}>
            Status
          </th>
          <th scope="col" className={th("w-11 pr-2")}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {members.map((user) => (
          <MemberRow
            key={user.id}
            user={user}
            isMe={user.id === me.id}
            onReset={() => onReset(user)}
            onDisable={() => onDisable(user)}
          />
        ))}
      </tbody>
    </table>
  );
}

const STATUS_META: Record<MemberStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-status-green/11 text-status-green" },
  pending: { label: "Invited", className: "bg-status-amber/11 text-status-amber" },
  disabled: { label: "Disabled", className: "bg-status-gray/11 text-status-gray" },
};

function StatusLabel({ status }: { status: MemberStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-[21px] items-center gap-[5px] whitespace-nowrap rounded-full px-[7px] font-medium text-[11.5px]",
        "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

interface MemberRowProps {
  user: UserSummary;
  isMe: boolean;
  onReset: () => void;
  onDisable: () => void;
}

function MemberRow({ user, isMe, onReset, onDisable }: MemberRowProps) {
  const status = memberStatus(user);
  const label = user.name || user.email;
  // The owner's account and your own can't be disabled or reset from here (the API answers 409).
  const manageable = user.role !== "owner" && !isMe;
  const disabled = status === "disabled";

  return (
    <tr
      data-status={status}
      className="h-12 border-divider border-t first:border-t-0 data-[status=disabled]:text-muted-foreground"
    >
      <td className={td("pl-3.5")}>
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar className={cn("size-7 shrink-0", disabled && "opacity-60")}>
            <AvatarFallback className="text-[11px]">{initials(label)}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-body",
                  disabled ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {user.name || user.email}
              </span>
              {isMe ? (
                <span className="shrink-0 text-small text-muted-foreground">(you)</span>
              ) : null}
            </span>
            <span className="truncate text-small text-muted-foreground">{user.email}</span>
          </div>
        </div>
      </td>
      <td className={td("hidden sm:table-cell")}>
        <Badge variant={user.role === "owner" ? "default" : "secondary"}>
          {user.role === "owner" ? "Owner" : "Admin"}
        </Badge>
      </td>
      <td className={td("hidden text-right md:table-cell")}>
        {user.lastLoginAt ? (
          <RelativeTime
            value={user.lastLoginAt}
            className="font-mono text-[11px] text-muted-foreground"
          />
        ) : (
          <span className="text-small text-muted-foreground">Never</span>
        )}
      </td>
      <td className={td()}>
        <StatusLabel status={status} />
      </td>
      <td className={td("pr-2 text-right")}>
        {manageable && !disabled ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Manage ${label}`}>
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onSelect={onReset}>
                <Link2Icon aria-hidden="true" />
                New password link
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDisable}>
                <BanIcon aria-hidden="true" />
                Disable access
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </td>
    </tr>
  );
}
