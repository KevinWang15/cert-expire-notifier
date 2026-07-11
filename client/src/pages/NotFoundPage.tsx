import { Link } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Not Found");

  return (
    <div className="rounded-lg border border-border bg-background p-4 text-sm">
      <p className="font-medium">Page not found</p>
      <p className="mt-2 text-muted-foreground">
        The route you requested does not exist in this starter app.
      </p>
      <Link
        className="mt-4 inline-flex rounded-md border border-border px-3 py-2 hover:bg-muted"
        to="/"
      >
        Back to home
      </Link>
    </div>
  );
}
