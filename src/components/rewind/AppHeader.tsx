import { Link } from "@tanstack/react-router";
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";

export function Logo() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2 font-mono text-sm font-semibold tracking-[0.3em]"
    >
      <span className="grid size-6 place-items-center rounded-sm bg-primary text-primary-foreground text-xs">
        ◀◀
      </span>
      REWIND
    </Link>
  );
}

const nav = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/projects/new", label: "Import" },
  { to: "/inspect", label: "Website" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Logo />
        <SignedIn>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {nav.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="rounded-sm px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                activeProps={{ className: "text-foreground bg-secondary" }}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </SignedIn>
        <div className="ml-auto flex items-center gap-2">
          <SignedOut>
            <SignInButton mode="modal">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="sm">Get started</Button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </div>
      </div>
      <SignedIn>
        <nav
          className="flex gap-1 overflow-x-auto border-t px-2 py-1 md:hidden"
          aria-label="Main mobile"
        >
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="shrink-0 rounded-sm px-3 py-1 text-xs text-muted-foreground"
              activeProps={{ className: "text-foreground bg-secondary" }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </SignedIn>
    </header>
  );
}
