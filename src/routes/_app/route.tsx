import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RedirectToSignIn, useAuth } from "@clerk/clerk-react";
import { useEffect } from "react";
import { setTokenGetter } from "@/lib/api";

export const Route = createFileRoute("/_app")({
  ssr: false,
  component: AppLayout,
});

function AppLayout() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(() => getToken());
  }, [getToken]);
  if (!isLoaded) return <div className="mx-auto max-w-6xl px-4 py-16 label-mono">Loading session…</div>;
  if (!isSignedIn) return <RedirectToSignIn />;
  setTokenGetter(() => getToken());
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <Outlet />
    </main>
  );
}
