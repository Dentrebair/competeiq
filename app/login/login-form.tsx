"use client";

import { useActionState } from "react";

import { login, type LoginState } from "@/app/actions/auth";

const INITIAL: LoginState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, isPending] = useActionState(login, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-base font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-ink
                     placeholder:text-ink-faint focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          placeholder="you@yourbrand.com"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-base font-medium text-ink">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-ink
                     focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent"
        />
      </div>

      {state.error ? (
        // aria-live so the failure is announced, not just repainted.
        <p role="alert" aria-live="polite" className="text-base text-sev-critical">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="mt-1 rounded-xl bg-accent px-4 py-3 text-base font-semibold text-accent-contrast
                   transition-all hover:bg-accent-hover hover:shadow-md disabled:opacity-60"
      >
        {isPending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
