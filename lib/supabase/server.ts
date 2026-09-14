import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "@/lib/env";
import type { Database } from "@/lib/types/database";

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 *
 * Next 16: `cookies()` is async and synchronous access has been *removed*, not
 * just deprecated. This function is therefore async, and every call site must
 * `await createClient()`. Code written against Next 14/15 that does
 * `const supabase = createClient()` will not work here.
 *
 * Uses the anon key and the caller's session cookie, so every query runs under
 * RLS as the signed-in operator. That is intentional: RLS stays a live backstop
 * rather than something we bypass by habit.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components get a read-only cookie store, so this throws when
          // Supabase tries to write a refreshed token during a render. Safe to
          // swallow: proxy.ts runs before every matched request and refreshes
          // the session there, where cookies *are* writable. Removing that proxy
          // is what would actually break session renewal.
        }
      },
    },
  });
}
