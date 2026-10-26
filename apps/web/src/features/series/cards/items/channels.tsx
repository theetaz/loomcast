import { Link } from "@tanstack/react-router";
import { SeriesChannelsCard } from "@/features/channels/SeriesChannelsCard";
import type { SeriesCard, SeriesCardProps } from "../registry";
import { SeriesCardFrame } from "../SeriesCardFrame";

function ChannelsCard({ series, workspaceParam }: SeriesCardProps) {
  return (
    <SeriesCardFrame
      title="Channels"
      action={
        <Link
          to="/w/$workspace/settings/channels"
          params={{ workspace: workspaceParam }}
          className="rounded-sm text-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Manage
        </Link>
      }
    >
      <SeriesChannelsCard series={series} workspaceParam={workspaceParam} />
    </SeriesCardFrame>
  );
}

export const card: SeriesCard = { id: "channels", order: 30, Card: ChannelsCard };
