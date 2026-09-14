import type { ReactNode } from "react";

/**
 * The masthead every screen shares: title, a live indicator, one line of
 * orientation, and whatever controls that page owns on the right.
 *
 * The subtitle is not decoration — each page states what it is *for* in the
 * operator's terms ("what changed and what to consider next"), because five
 * screens of dense competitive data need to announce which question they answer.
 */
export function PageHeader({
  title,
  subtitle,
  status,
  actions,
}: {
  title: string;
  subtitle: string;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 px-8 pb-6 pt-8">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[30px] font-semibold leading-none tracking-tight text-ink">
            {title}
          </h1>
          {status}
        </div>
        <p className="mt-2 text-[15px] text-ink-muted">{subtitle}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Card shell. One radius and one border for every panel in the product. */
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-surface shadow-[var(--shadow-card)] ${className}`}
    >
      {children}
    </section>
  );
}

/** The label + heading pairing that opens most panels. */
export function PanelHeading({
  eyebrow,
  title,
  description,
  aside,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="mt-1.5 text-xl font-semibold tracking-tight text-ink">{title}</h2>
        {description ? <p className="mt-1 text-[15px] text-ink-muted">{description}</p> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  );
}
