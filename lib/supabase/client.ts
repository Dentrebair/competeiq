"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/types/database";

/**
 * Supabase client for the browser. Carries the anon key and the session cookie,
 * so reads run under RLS as the signed-in operator.
 *
 * This is also the client that opens the Realtime WebSocket. Realtime respects
 * RLS: with no matching SELECT policy the channel still reports SUBSCRIBED and
 * then silently delivers nothing, which is the single most confusing way this
 * stack fails. See section 6 of supabase/schema.sql for the smoke test.
 *
 * `createBrowserClient` memoises internally, so calling this per component is
 * fine and does not open redundant sockets.
 */
export function createClient() {
  // Deliberately literal `process.env.NEXT_PUBLIC_*` member access, NOT
  // requireEnv() from lib/env.ts. The bundler only substitutes statically
  // analysable literal reads; a dynamic lookup like `process.env[name]` is left
  // alone and evaluates to undefined in the browser. Refactoring these two lines
  // to share the server-side helper compiles cleanly and then fails at runtime.
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
