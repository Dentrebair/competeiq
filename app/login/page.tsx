import { LoginForm } from "./login-form";

/**
 * `searchParams` is a Promise in Next 16 — synchronous access was removed, not
 * deprecated. `PageProps<"/login">` is a generated global type that types the
 * promise correctly for this route.
 */
export default async function LoginPage(props: PageProps<"/login">) {
  const params = await props.searchParams;
  const raw = params.next;
  const next = typeof raw === "string" ? raw : "/";

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-ink">CompeteIQ</h1>
          <p className="mt-2 text-base text-ink-muted">
            Competitor intelligence. Sign in to see today&rsquo;s signals.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-7 shadow-sm">
          <LoginForm next={next} />
        </div>

        <p className="mt-6 text-sm text-ink-faint">
          Access is provisioned by your administrator. There is no self-signup.
        </p>
      </div>
    </main>
  );
}
