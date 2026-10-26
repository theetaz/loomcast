import { SERIES_NAME_MAX_LENGTH, SeriesNameSchema } from "@loomcast/contracts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { formatsListQueryOptions, useCreateFormat } from "@/features/formats/queries";
import { errorMessage } from "@/lib/api";
import { useCreateSeries } from "./queries";

const NEW_FORMAT = "__new";

/**
 * Wraps a trigger button. A series needs a name and a format: one of the workspace's formats, or a
 * new format with the default rules, named after the series and edited next.
 */
export function NewSeriesDialog({
  workspaceId,
  workspaceParam,
  children,
}: {
  workspaceId: string;
  workspaceParam: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setFormKey((key) => key + 1);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <NewSeriesForm
          key={formKey}
          workspaceId={workspaceId}
          workspaceParam={workspaceParam}
          onCreated={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewSeriesForm({
  workspaceId,
  workspaceParam,
  onCreated,
}: {
  workspaceId: string;
  workspaceParam: string;
  onCreated: () => void;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const formats = useQuery(formatsListQueryOptions(workspaceId));
  const createFormat = useCreateFormat();
  const createSeries = useCreateSeries();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formatChoice, setFormatChoice] = useState<string | null>(null);
  // A format created by a try whose series then failed is reused, not created twice.
  const [createdFormatId, setCreatedFormatId] = useState<string | null>(null);
  const available = (formats.data?.items ?? []).filter((format) => format.archivedAt === null);
  const formatId = formatChoice ?? NEW_FORMAT;
  const pending = createFormat.isPending || createSeries.isPending;
  const error = createFormat.error ?? createSeries.error;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const parsed = SeriesNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError("Give the series a name.");
      nameRef.current?.focus();
      return;
    }
    try {
      let newFormatId = formatId === NEW_FORMAT ? createdFormatId : null;
      if (formatId === NEW_FORMAT && newFormatId === null) {
        const format = await createFormat.mutateAsync({ workspaceId, name: parsed.data });
        newFormatId = format.id;
        setCreatedFormatId(format.id);
      }
      const series = await createSeries.mutateAsync({
        workspaceId,
        name: parsed.data,
        formatId: newFormatId ?? formatId,
      });
      onCreated();
      toast.success("Series created", { description: series.name });
      void navigate({
        to: newFormatId
          ? "/w/$workspace/series/$seriesId/format"
          : "/w/$workspace/series/$seriesId",
        params: { workspace: workspaceParam, seriesId: series.id },
      });
    } catch {
      // Shown below the fields.
    }
  };

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New series</DialogTitle>
        <DialogDescription>
          A series groups videos that share a format: their tone, length, look and publishing
          cadence.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          ref={nameRef}
          id={`${id}-name`}
          value={name}
          autoComplete="off"
          maxLength={SERIES_NAME_MAX_LENGTH}
          placeholder="Ownership basics"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(null);
          }}
        />
        {nameError ? (
          <p id={`${id}-name-error`} className="text-small text-destructive">
            {nameError}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-format`}>Format</Label>
        <Select value={formatId} onValueChange={setFormatChoice}>
          <SelectTrigger id={`${id}-format`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_FORMAT}>New format with default rules</SelectItem>
            {available.map((format) => (
              <SelectItem key={format.id} value={format.id}>
                {format.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-small text-muted-foreground">
          {formatId === NEW_FORMAT
            ? "You set its rules next. Formats can be shared by several series."
            : "The series follows this format's rules, shared with every series that uses it."}
        </p>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {errorMessage(error, "Couldn't create the series. Try again.")}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create series"}
        </Button>
      </DialogFooter>
    </form>
  );
}
