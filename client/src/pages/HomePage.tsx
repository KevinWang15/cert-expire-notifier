import { useEffect, useState } from "react";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

type HealthResponse = {
  ok: boolean;
  service: string;
  app: string;
  timestamp: string;
};

export function HomePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle();

  useEffect(() => {
    fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json() as Promise<HealthResponse>;
      })
      .then((data) => setHealth(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Request failed"));
  }, []);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-4 text-sm">
      <p className="font-medium">API health</p>
      {health ? (
        <pre className="overflow-auto rounded bg-muted p-3 text-xs">
          {JSON.stringify(health, null, 2)}
        </pre>
      ) : null}
      {error ? <p className="text-red-500">{error}</p> : null}
      {!health && !error ? <p className="text-muted-foreground">Loading...</p> : null}
    </div>
  );
}
