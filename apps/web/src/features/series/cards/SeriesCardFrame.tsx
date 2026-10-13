import type { ReactNode } from "react";

/** The frame every series card uses: a 44px header with a title and an optional action. */
export function SeriesCardFrame({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg bg-card shadow-card"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-divider border-b px-3.5">
        <h3 className="font-semibold text-[13px]">{title}</h3>
        {action ? <div className="ml-auto flex items-center">{action}</div> : null}
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">{children}</div>
    </section>
  );
}
