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
          <h1 className="text-2xl font-semibold tracking-tight text-ink">CompeteIQ</h1>
          <p className="mt-1 text-[15px] text-ink-muted">
            Competitor intelligence. Sign in to see today&rsquo;s signals.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface p-6">
          <LoginForm next={next} />
        </div>

        <p className="mt-6 text-[13px] text-ink-faint">
          Access is provisioned by your administrator. There is no self-signup.
        </p>
      </div>
    </main>
  );
}
