"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, type ReactNode } from "react";

import { signOut } from "@/app/actions/auth";

/**
 * The rail.
 *
 * Fixed dark across both themes — see app/globals.css. Navigation is furniture:
 * it should recede so the evidence beside it reads as the thing you came for.
 */

const ICON = {
  overview: (
    <>
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.4" />
      <rect x="10" y="2.5" width="5.5" height="5.5" rx="1.4" />
      <rect x="2.5" y="10" width="5.5" height="5.5" rx="1.4" />
      <rect x="10" y="10" width="5.5" height="5.5" rx="1.4" />
    </>
  ),
  intelligence: (
    <>
      <path d="M9 2.5 10.4 6 14 7.4 10.4 8.8 9 12.4 7.6 8.8 4 7.4 7.6 6 9 2.5Z" />
      <path d="M4 11.5 4.7 13.3 6.5 14 4.7 14.7 4 16.5 3.3 14.7 1.5 14 3.3 13.3 4 11.5Z" />
    </>
  ),
  competitors: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <circle cx="9" cy="9" r="2.6" />
    </>
  ),
  alerts: (
    <>
      <path d="M4.5 7.5a4.5 4.5 0 0 1 9 0c0 3.4 1.2 4.6 1.2 4.6H3.3s1.2-1.2 1.2-4.6Z" />
      <path d="M7.4 14.6a1.8 1.8 0 0 0 3.2 0" />
    </>
  ),
  reports: (
    <>
      <path d="M4 2.6h6l4 4v9a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V3.5a.9.9 0 0 1 .9-.9Z" />
      <path d="M10 2.6v4h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="9" cy="9" r="2.4" />
      <path d="M9 1.8v1.8M9 14.4v1.8M16.2 9h-1.8M3.6 9H1.8M14.1 3.9l-1.3 1.3M5.2 12.8l-1.3 1.3M14.1 14.1l-1.3-1.3M5.2 5.2 3.9 3.9" />
    </>
  ),
  pricing: (
    <>
      <path d="M9.5 2.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-.3.7l-6.5 6.5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 0-1.4l6.5-6.5a1 1 0 0 1 .7-.3Z" />
      <circle cx="12.2" cy="5.8" r="0.9" />
    </>
  ),
  moon: <path d="M14.5 10.4A6 6 0 0 1 7.6 3.5a6 6 0 1 0 6.9 6.9Z" />,
  sun: (
    <>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M9 1.8v1.6M9 14.6v1.6M16.2 9h-1.6M3.4 9H1.8M14.1 3.9l-1.1 1.1M5 13l-1.1 1.1M14.1 14.1 13 13M5 5 3.9 3.9" />
    </>
  ),
} as const;

function Icon({ shape, className = "size-[18px]" }: { shape: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 18 18"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shape}
    </svg>
  );
}

const NAV = [
  { href: "/", label: "Overview", icon: ICON.overview },
  { href: "/intelligence", label: "Intelligence", icon: ICON.intelligence },
  { href: "/competitors", label: "Competitors", icon: ICON.competitors },
  { href: "/alerts", label: "Alerts", icon: ICON.alerts, badge: true },
  { href: "/reports", label: "Reports", icon: ICON.reports },
] as const;

/** Exact match for "/", prefix match for the rest, so nested routes stay lit. */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * Theme toggle, with no state.
 *
 * The active theme is already expressed in the DOM and in CSS, so asking React
 * to track it as well means reading localStorage — unreadable during SSR, which
 * forces either a flash of the wrong label or a setState inside an effect. Both
 * labels are rendered and CSS shows the right one; the click reads the current
 * theme from the document rather than from a copy of it.
 */
function ThemeToggle() {
  const toggle = useCallback(() => {
    const root = document.documentElement;
    const current =
      root.dataset.theme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("competeiq-theme", next);
    } catch {
      // Private browsing, or storage disabled. The theme still applies for this
      // session; it simply will not be remembered.
    }
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[15px] text-rail-ink-muted
                 transition-colors hover:bg-rail-raised hover:text-rail-ink"
    >
      <span className="theme-light-only items-center gap-3">
        <Icon shape={ICON.moon} />
        Dark theme
      </span>
      <span className="theme-dark-only items-center gap-3">
        <Icon shape={ICON.sun} />
        Light theme
      </span>
    </button>
  );
}

export function AppSidebar({
  email,
  unreadCount,
}: {
  email: string;
  unreadCount: number;
}) {
  const pathname = usePathname();
  const initials =
    email
      .split("@")[0]
      .split(/[.\-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "OP";

  /*
    The rail is pinned to the viewport, not to the page.

    As a plain flex child it stretched to the height of whatever was beside it,
    so on a long Overview the bottom block — Store setup, the theme toggle, the
    account — sat hundreds of pixels below the fold and only appeared after
    scrolling the content. `self-start` stops the stretch, `h-screen` fixes the
    height to the window, and `sticky top-0` keeps it in place while the right
    pane scrolls past it.
  */
  return (
    <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col self-start overflow-hidden bg-rail text-rail-ink">
      <div className="flex items-center gap-3 px-5 py-6">
        <span
          aria-hidden
          className="grid size-9 place-items-center rounded-xl bg-brand text-[15px] font-bold tracking-tight text-brand-ink"
        >
          CI
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-base font-semibold tracking-tight">CompeteIQ</span>
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-rail-ink-muted">
            Decision console
          </span>
        </span>
      </div>

      {/* Only the links scroll, and only on a viewport too short to hold them.
          The account block below must never be the thing that scrolls away. */}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors ${
                active
                  ? "bg-rail-raised font-medium text-rail-ink"
                  : "text-rail-ink-muted hover:bg-rail-raised/60 hover:text-rail-ink"
              }`}
            >
              {/* Lime marks identity and position, never state — see globals.css. */}
              {active ? (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand"
                />
              ) : null}
              <Icon shape={item.icon} />
              {item.label}
              {"badge" in item && item.badge && unreadCount > 0 ? (
                <span className="tabular ml-auto rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-brand-ink">
                  {unreadCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 flex-col gap-1 px-3 pb-3">
        <Link
          href="/store-setup"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] transition-colors ${
            isActive(pathname, "/store-setup")
              ? "bg-rail-raised text-rail-ink"
              : "text-rail-ink-muted hover:bg-rail-raised hover:text-rail-ink"
          }`}
        >
          <Icon shape={ICON.settings} />
          Store setup
        </Link>

        <Link
          href="/pricing"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] transition-colors ${
            isActive(pathname, "/pricing")
              ? "bg-rail-raised text-rail-ink"
              : "text-rail-ink-muted hover:bg-rail-raised hover:text-rail-ink"
          }`}
        >
          <Icon shape={ICON.pricing} />
          Pricing
        </Link>

        <ThemeToggle />

        <div className="mt-2 flex items-center gap-3 border-t border-rail-border px-3 pt-4">
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-full bg-rail-raised text-xs font-semibold text-rail-ink"
          >
            {initials}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[15px] font-medium">{email.split("@")[0]}</span>
            <span className="text-xs text-rail-ink-muted">Owner</span>
          </span>
          <form action={signOut} className="ml-auto">
            <button
              type="submit"
              title="Sign out"
              className="rounded-md p-1.5 text-rail-ink-muted transition-colors hover:bg-rail-raised hover:text-rail-ink"
            >
              <svg
                aria-hidden
                viewBox="0 0 18 18"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 15.5H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h3M12 12.5 15.5 9 12 5.5M15.5 9H7" />
              </svg>
              <span className="sr-only">Sign out</span>
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
