import { useEffect } from "react";

const APP_NAME = "Loomcast";

/** Sets the document title as `<page> · Loomcast`. */
export function useTitle(page: string | undefined) {
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}
