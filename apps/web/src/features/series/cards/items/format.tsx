import { Button } from "@loomcast/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Skeleton } from "@loomcast/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PencilIcon, TriangleAlertIcon } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { formatsListQueryOptions } from "@/features/formats/queries";
import { HOOK_STYLE_LABELS, styleOption } from "@/features/formats/styles";
import { errorMessage } from "@/lib/api";
import { useSetSeriesFormat } from "../../queries";
import type { SeriesCard, SeriesCardProps } from "../registry";
import { SeriesCardFrame } from "../SeriesCardFrame";

function FormatCard({ series, workspace, format, workspaceParam }: SeriesCardProps) {
  const id = useId();
  const formats = useQuery(formatsListQueryOptions(workspace.id));
  const setFormat = useSetSeriesFormat();
  const editable = series.status !== "archived" && workspace.status === "active";
  const choices = (formats.data?.items ?? []).filter(
    (entry) => entry.archivedAt === null || entry.id === series.formatId,
  );

  return (
    <SeriesCardFrame
      title="Format"
      action={
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/w/$workspace/series/$seriesId/format"
            params={{ workspace: workspaceParam, seriesId: series.id }}
          >
            <PencilIcon aria-hidden="true" />
            {editable ? "Edit rules" : "View rules"}
          </Link>
        </Button>
      }
    >
      {format ? (
        <>
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 truncate font-medium text-body">{format.name}</p>
            <span className="font-mono text-mono text-muted-foreground">
              v{format.currentVersion.versionNo}
            </span>
          </div>
          <FormatFacts rules={format.currentVersion.rules} />
          {choices.length > 1 && editable ? (
            <div className="flex flex-col gap-1.5 border-divider border-t pt-2.5">
              <label htmlFor={`${id}-switch`} className="font-medium text-small text-text-2">
                Use another format
              </label>
              <Select
                value={series.formatId}
                disabled={setFormat.isPending}
                onValueChange={(formatId) =>
                  setFormat.mutate(
                    { series, formatId },
                    {
                      onSuccess: () => toast.success("Format changed"),
                      onError: (error) =>
                        toast.error("Couldn't change the format", {
                          description: errorMessage(error),
                        }),
                    },
                  )
                }
              >
                <SelectTrigger id={`${id}-switch`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.id} value={choice.id}>
                      {choice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Skeleton aria-hidden="true" className="h-3 w-40" />
          <Skeleton aria-hidden="true" className="h-3 w-52" />
        </>
      )}
    </SeriesCardFrame>
  );
}

function FormatFacts({
  rules,
}: {
  rules: NonNullable<SeriesCardProps["format"]>["currentVersion"]["rules"];
}) {
  const style = styleOption(rules.visualTemplate.styleId);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-control">
      <dt className="text-muted-foreground">Length</dt>
      <dd className="tabular-nums">
        {rules.lengthSec.min}–{rules.lengthSec.max} s
      </dd>
      <dt className="text-muted-foreground">Hook</dt>
      <dd>{HOOK_STYLE_LABELS[rules.hookStyle].label}</dd>
      <dt className="text-muted-foreground">Style</dt>
      <dd className="truncate">{style?.name ?? rules.visualTemplate.styleId}</dd>
      <dt className="text-muted-foreground">Voice</dt>
      <dd className="min-w-0">
        {rules.voiceId ? (
          <span className="block truncate font-mono text-[11.5px]">{rules.voiceId}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-status-amber">
            <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
            Not set, so production stops before the voice step
          </span>
        )}
      </dd>
      <dt className="text-muted-foreground">Topics</dt>
      <dd className="tabular-nums">
        {rules.topicPool.length} in the pool
        {rules.avoid.length > 0 ? `, ${rules.avoid.length} to avoid` : ""}
      </dd>
    </dl>
  );
}

export const card: SeriesCard = { id: "format", order: 20, Card: FormatCard };
