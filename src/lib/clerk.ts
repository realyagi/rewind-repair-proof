// Clerk publishable keys are browser-safe by design. Override via VITE_CLERK_PUBLISHABLE_KEY.
export const CLERK_PUBLISHABLE_KEY =
  (import.meta.env['VITE_CLERK_PUBLISHABLE_KEY'] as string | undefined) ||
  "pk_test_bWF0dXJlLWthdHlkaWQtNTYwMy5jbGVyay5hY2NvdW50cy5kZXYk";

export const clerkAppearance = {
  variables: {
    colorPrimary: "oklch(0.8 0.16 75)",
    colorBackground: "oklch(0.195 0.01 260)",
    colorText: "oklch(0.93 0.01 90)",
    colorTextSecondary: "oklch(0.66 0.015 260)",
    colorInputBackground: "oklch(0.155 0.008 260)",
    colorInputText: "oklch(0.93 0.01 90)",
    colorTextOnPrimaryBackground: "oklch(0.17 0.02 70)",
    borderRadius: "0.375rem",
    fontFamily: "Space Grotesk, sans-serif",
  },
} as const;
