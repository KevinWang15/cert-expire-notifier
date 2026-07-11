import { SHARED_APP_NAME } from "@shared/config/runtime";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function AboutPage() {
  useDocumentTitle("About");

  return (
    <div className="rounded-lg border border-border bg-background p-4 text-sm">
      <p className="font-medium">About</p>
      <p className="mt-2 text-muted-foreground">
        {SHARED_APP_NAME} ships with React Router, route-level titles, and a shared frontend/backend
        runtime config.
      </p>
    </div>
  );
}
