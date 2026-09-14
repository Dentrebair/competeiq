/**
 * Environment access that fails loudly.
 *
 * `process.env.FOO` returning undefined propagates as a confusing downstream
 * error — a Supabase client built with an undefined URL fails at request time
 * with a fetch error, not a config error. Read through `requireEnv` so a missing
 * variable names itself at the point of use.
 *
 * Next 16 note: values read here are inlined at build time during prerendering.
 * Everything in this app that reads secrets does so from a Route Handler or a
 * Server Action, both of which are request-time, so that is fine. If you ever
 * need a server env var inside a *prerendered* component, call `connection()`
 * from `next/server` first or the build-time value gets baked in.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.local.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Public (browser-visible) Supabase config. Safe to expose — RLS is the guard. */
export const supabaseUrl = () => requireEnv("NEXT_PUBLIC_SUPABASE_URL");
export const supabaseAnonKey = () => requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
