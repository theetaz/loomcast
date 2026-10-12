import { useTheme } from "@loomcast/ui/lib/theme";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts follow the Loomcast theme preference. Surface, shadow and timing come
 * from theme.css: 400ms in and 200ms out with `ease`, fade only under reduced motion.
 */
function Toaster({ ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      position="bottom-right"
      gap={8}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-[15px] text-status-green" />,
        info: <InfoIcon className="size-[15px] text-status-blue" />,
        warning: <TriangleAlertIcon className="size-[15px] text-status-amber" />,
        error: <OctagonXIcon className="size-[15px] text-status-red" />,
        loading: <Loader2Icon className="size-[15px] animate-spin text-muted-foreground" />,
      }}
      {...props}
    />
  );
}

export { Toaster };
