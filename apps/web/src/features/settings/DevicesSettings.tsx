import type { Device } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { StatusPill } from "@loomcast/ui/components/StatusPill";
import { useQuery } from "@tanstack/react-query";
import { LaptopIcon, PlusIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { RelativeTime } from "@/components/RelativeTime";
import { devicesQueryOptions } from "@/features/devices/queries";
import { formatPlatform } from "./format";
import { PairDeviceDialog } from "./PairDeviceDialog";
import { useRevokeDevice } from "./queries";
import { RevokeDialog } from "./RevokeDialog";
import { SettingsCard, TableSkeleton, td, th } from "./SettingsCard";

/** Paired studio agents with live status, pairing and revoking. */
export function DevicesSettings() {
  const query = useQuery(devicesQueryOptions());
  // The target outlives `open` so the dialog keeps its title while it fades out.
  const [target, setTarget] = useState<Device | null>(null);
  const [confirming, setConfirming] = useState(false);
  const revoke = useRevokeDevice();

  const count = query.isSuccess ? query.data.length : null;

  const confirmRevoke = () => {
    if (!target) return;
    revoke.mutate(target, {
      onSuccess: () => {
        setConfirming(false);
        toast.success("Device revoked", { description: target.name });
      },
    });
  };

  return (
    <>
      <SettingsCard
        title="Studio agents"
        count={count}
        busy={query.isPending}
        action={
          <PairDeviceDialog>
            <Button size="sm">
              <PlusIcon aria-hidden="true" />
              Pair a device
            </Button>
          </PairDeviceDialog>
        }
      >
        {query.isPending ? (
          <TableSkeleton columns={["w-32", "w-24", "w-10", "w-14", "w-10"]} />
        ) : query.isError ? (
          <ErrorState
            size="compact"
            title="Couldn't load devices"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={LaptopIcon}
            title="No studio agent yet"
            description="The studio agent runs on your own Mac and renders the videos. Pair one to start producing."
            action={
              <PairDeviceDialog>
                <Button>
                  <PlusIcon aria-hidden="true" />
                  Pair a device
                </Button>
              </PairDeviceDialog>
            }
          />
        ) : (
          <table aria-label="Paired devices" className="w-full table-fixed text-left">
            <thead>
              <tr className="h-9 border-divider border-b">
                <th scope="col" className={th("pl-3.5")}>
                  Name
                </th>
                <th scope="col" className={th("hidden w-[22%] md:table-cell")}>
                  Platform
                </th>
                <th scope="col" className={th("hidden w-[13%] sm:table-cell")}>
                  Agent
                </th>
                <th scope="col" className={th("w-[84px]")}>
                  Status
                </th>
                <th scope="col" className={th("w-[76px] text-right sm:w-[92px]")}>
                  Last seen
                </th>
                <th scope="col" className={th("w-11 pr-2")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  onRevoke={() => {
                    revoke.reset();
                    setTarget(device);
                    setConfirming(true);
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>

      <RevokeDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Revoke ${target?.name ?? "this device"}?`}
        description="It disconnects now and can't take render jobs until you pair it again."
        confirmLabel="Revoke device"
        pendingLabel="Revoking…"
        pending={revoke.isPending}
        error={revoke.error}
        onConfirm={confirmRevoke}
      />
    </>
  );
}

function DeviceRow({ device, onRevoke }: { device: Device; onRevoke: () => void }) {
  return (
    <tr className="h-10 border-divider border-t first:border-t-0">
      <td className={td("pl-3.5")}>
        <span className="block truncate text-body text-foreground">{device.name}</span>
      </td>
      <td className={td("hidden md:table-cell")}>
        <span className="block truncate text-control text-text-2" title={device.platform}>
          {formatPlatform(device.platform)}
        </span>
      </td>
      <td className={td("hidden sm:table-cell")}>
        <span className="block truncate font-mono text-mono text-muted-foreground">
          {device.agentVersion ?? "—"}
        </span>
      </td>
      <td className={td()}>
        <StatusPill kind="device" status={device.online ? "online" : "offline"} />
      </td>
      <td className={td("text-right")}>
        {device.lastSeenAt ? (
          <RelativeTime
            value={device.lastSeenAt}
            className="font-mono text-[11px] text-muted-foreground"
          />
        ) : (
          <span className="text-small text-muted-foreground">Never</span>
        )}
      </td>
      <td className={td("pr-2 text-right")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Revoke ${device.name}`}
          title="Revoke"
          onClick={onRevoke}
        >
          <UnplugIcon aria-hidden="true" />
        </Button>
      </td>
    </tr>
  );
}
