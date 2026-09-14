"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export interface LoginState {
  error: string | null;
}

/**
 * Only allow redirects back to a path on this origin.
 *
 * The `next` parameter arrives from the query string, so it is attacker-supplied.
 * Handing it to redirect() unchecked is an open redirect: a link to
 * /login?next=https://evil.example bounces the operator off-site after a
 * successful login, with the timing and styling of a legitimate flow.
 *
 * `//evil.example` is the case people miss — it has no scheme but browsers treat
 * it as protocol-relative and absolute.
 */
function safeNext(candidate: string): string {
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//")) return "/";
  return candidate;
}

export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? "/"));

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Deliberately one message for every failure mode. Supabase distinguishes
    // "wrong password" from "no such user", and reflecting that back confirms
    // whether an address has an account here.
    return { error: "That email and password did not match. Try again." };
  }

  // redirect() signals by throwing, so it has to sit outside any try/catch —
  // wrapping it swallows the redirect and the form appears to do nothing.
  redirect(next);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
