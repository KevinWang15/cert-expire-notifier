import { useEffect } from "react";
import { SHARED_APP_NAME } from "@shared/config/runtime";

export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? title + " | " + SHARED_APP_NAME : SHARED_APP_NAME;
  }, [title]);
}
