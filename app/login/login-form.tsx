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
        <label htmlFor="email" className="text-[15px] font-medium text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="rounded-md border border-border bg-surface px-3 py-2 text-ink
                     placeholder:text-ink-faint focus:border-accent focus:outline-none"
          placeholder="you@yourbrand.com"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-[15px] font-medium text-ink">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-border bg-surface px-3 py-2 text-ink
                     focus:border-accent focus:outline-none"
        />
      </div>

      {state.error ? (
        // aria-live so the failure is announced, not just repainted.
        <p role="alert" aria-live="polite" className="text-[15px] text-sev-critical">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="mt-1 rounded-md bg-accent px-4 py-2 font-medium text-accent-contrast
                   transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {isPending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
