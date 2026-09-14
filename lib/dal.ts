import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Data Access Layer — the actual authorization boundary for this app.
 *
 * Why this exists rather than trusting proxy.ts: the Next.js auth guide is
 * explicit that proxy checks are "optimistic" and optional. Proxy runs on every
 * request including prefetches, it is a network-edge concern, and history has
 * shown framework-level request-filtering to be bypassable (CVE-2025-29927 was
 * exactly a middleware auth bypass). So proxy handles session *refresh* and
 * bounces obvious anonymous traffic; authorization is verified here, adjacent to
 * the data, on every read.
 *
 * Every Server Component, Route Handler, and Server Action that touches
 * operator data calls `requireUser()` first. No exceptions — a route that skips
 * it is unprotected regardless of what proxy.ts says.
 */

/**
 * Resolve the current user, or null.
 *
 * Uses `getUser()`, never `getSession()`. `getSession()` decodes the JWT out of
 * the cookie without verifying it, so on the server it is only as trustworthy as
 * the cookie — which is to say, not. `getUser()` revalidates the token against
 * Supabase Auth. The cost is a network call, which `cache()` collapses to one per
 * request no matter how many components ask.
 */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;
  return user;
});

/**
 * Require an authenticated operator. Redirects to /login when absent.
 *
 * `redirect()` throws internally, so this never returns for an anonymous
 * caller — no need to branch on the result at call sites.
 */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Same check for Route Handlers, which should answer 401 rather than redirect.
 * Returns null on success so callers can `if (unauthorized) return unauthorized`.
 */
export async function requireUserOrRespond(): Promise<Response | null> {
  const user = await getUser();
  if (user) return null;
  return Response.json({ error: "Not authenticated" }, { status: 401 });
}
