import { ApiError } from "@/lib/api";

export function ApiNotice({ error }: { error: unknown }) {
  const offline =
    error instanceof ApiError &&
    (error.status === 0 || error.status === 404 || error.status === 502);
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
    >
      <p className="font-semibold text-destructive">{(error as Error).message}</p>
      {offline && (
        <p className="mt-1 text-muted-foreground">
          The REWIND backend (API, worker, database, sandbox) runs on your own server via Docker
          Compose. See DEPLOY.md in the repository.
        </p>
      )}
    </div>
  );
}
