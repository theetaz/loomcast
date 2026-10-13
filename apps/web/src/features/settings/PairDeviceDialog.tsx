import type { Device, List, PairingCode } from "@loomcast/contracts";
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
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { cn } from "@loomcast/ui/lib/cn";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";
import { useLiveEvent } from "@/lib/live";
import { queryKeys } from "@/lib/query-keys";
import { CodeBlock } from "./CopyButton";
import { formatCountdown } from "./format";
import { useCreatePairingCode } from "./queries";

/** The command the studio agent's README documents, run from the repository root. */
export function pairCommand(server: string, code: string): string {
  return `pnpm agent pair --server ${server} --code ${code}`;
}

/**
 * Wraps a trigger button. Every open asks for a fresh single-use code; the
 * dialog closes by itself when a newly paired studio agent comes online.
 */
export function PairDeviceDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);

  const onOpenChange = (next: boolean) => {
    if (next) setSession((value) => value + 1);
    setOpen(next);
  };

  const onPaired = () => {
    setOpen(false);
    toast.success("Studio agent paired", {
      description: "It's online and ready to render.",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <PairDevicePanel key={session} onPaired={onPaired} />
      </DialogContent>
    </Dialog>
  );
}

/** Milliseconds until `expiresAt`, ticking each second until it reaches zero. */
function useRemaining(expiresAt: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const end = Date.parse(expiresAt);
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= end) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return expiresAt ? Date.parse(expiresAt) - now : null;
}

function PairDevicePanel({ onPaired }: { onPaired: () => void }) {
  const queryClient = useQueryClient();
  const { mutate, reset, isError, error } = useCreatePairingCode();
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  // Devices that existed when the code was requested; only a new one closes the dialog.
  const known = useRef<ReadonlySet<string>>(new Set());
  const requested = useRef(false);

  const requestCode = useCallback(() => {
    const devices = queryClient.getQueryData<List<Device>>(queryKeys.devices);
    known.current = new Set(devices?.items.map((device) => device.id));
    setPairing(null);
    mutate(undefined, {
      onSuccess: (next) => {
        setPairing(next);
        reset();
      },
    });
  }, [queryClient, mutate, reset]);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    requestCode();
  }, [requestCode]);

  useLiveEvent("device.status", ({ payload }) => {
    if (!pairing || !payload.online || known.current.has(payload.deviceId)) return;
    onPaired();
  });

  const remaining = useRemaining(pairing?.expiresAt);
  const expired = remaining !== null && remaining <= 0;
  const command = pairing ? pairCommand(window.location.origin, pairing.code) : "";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Pair a studio agent</DialogTitle>
        <DialogDescription>
          The studio agent renders videos on your own Mac. Run this command on that Mac to connect
          it to Loomcast.
        </DialogDescription>
      </DialogHeader>

      {isError && !pairing ? (
        <ErrorState
          size="compact"
          title="Couldn't create a pairing code"
          error={error}
          onRetry={requestCode}
        />
      ) : (
        <div className="grid min-w-0 gap-4">
          <div className="flex flex-col items-center gap-1.5 rounded-lg bg-secondary px-4 pt-5 pb-4 shadow-[0_0_0_1px_var(--border)]">
            <span className="text-small text-muted-foreground">Pairing code</span>
            {pairing ? (
              <output
                data-testid="pairing-code"
                aria-label={`Pairing code ${pairing.code}`}
                className={cn(
                  "font-medium font-mono text-[30px] leading-[38px] tracking-[0.12em] tabular-nums transition-opacity duration-200 ease-out sm:text-[34px]",
                  expired && "text-muted-foreground line-through opacity-50",
                )}
              >
                {pairing.code}
              </output>
            ) : (
              <Skeleton aria-hidden="true" className="h-[38px] w-[220px] rounded-md" />
            )}
            <p className="h-[18px] text-small text-muted-foreground">
              {pairing && remaining !== null ? (
                expired ? (
                  <span role="status">This code expired.</span>
                ) : (
                  <>
                    Expires in{" "}
                    <span
                      data-testid="pairing-countdown"
                      className="font-mono text-foreground tabular-nums"
                    >
                      {formatCountdown(remaining)}
                    </span>
                  </>
                )
              ) : null}
            </p>
          </div>

          {expired ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-control text-muted-foreground">
                Codes last ten minutes and work once. Get a new one to keep going.
              </p>
              <Button variant="outline" onClick={requestCode}>
                <RotateCwIcon aria-hidden="true" />
                Get a new code
              </Button>
            </div>
          ) : (
            <div className="grid min-w-0 gap-1.5">
              <span className="font-medium text-small text-text-2">Run on the Mac</span>
              {pairing ? (
                <CodeBlock value={command} copyLabel="Copy command">
                  {command.slice(0, -pairing.code.length)}
                  {/* The code never splits at its hyphen. */}
                  <span className="whitespace-nowrap">{pairing.code}</span>
                </CodeBlock>
              ) : (
                <Skeleton aria-hidden="true" className="h-[34px] w-full rounded-md" />
              )}
              <p className="text-small text-muted-foreground text-pretty">
                From the Loomcast repository. With the agent installed, run{" "}
                <code className="font-mono text-mono text-foreground">studio-agent pair</code> with
                the same options.
              </p>
            </div>
          )}
        </div>
      )}

      <DialogFooter>
        {pairing && !expired ? (
          <p className="mr-auto flex items-center gap-2 self-center text-small text-muted-foreground max-sm:order-last max-sm:self-start">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-status-green motion-reduce:animate-none"
            />
            Waiting for the agent to connect…
          </p>
        ) : null}
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Close
          </Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
