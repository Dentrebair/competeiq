import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Proxy — session refresh and an optimistic auth bounce.
 *
 * This file is `proxy.ts`, not `middleware.ts`. Next 16 renamed the convention
 * and the named export; `middleware.ts` still works but is deprecated. Proxy runs
 * on the `nodejs` runtime and that is not configurable — which suits us, since the
 * Supabase client wants full Node APIs.
 *
 * Two jobs, and only two:
 *   1. Refresh the Supabase session cookie. Server Components get a read-only
 *      cookie store and cannot write a rotated token, so if this file stops
 *      running, sessions quietly stop renewing and users get logged out mid-use.
 *   2. Bounce obviously-anonymous traffic away from app routes so we don't render
 *      a shell that is only going to redirect.
 *
 * It is NOT the authorization boundary. That is lib/dal.ts, checked per read.
 * Do not add data access or permission logic here.
 */

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PREFIXES = ["/login", "/auth"] as const;

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  // This response object accumulates any refreshed cookies. It must be the one
  // we return — building a fresh NextResponse at the end instead would drop the
  // rotated token and log the user out on the following request.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Calling getUser() is what triggers the token refresh — it is not merely a
  // read. Skipping it means no rotation happens. It costs one auth-server call
  // per matched request, which is why the matcher below excludes static assets.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const loginUrl = new URL("/login", request.url);
    // Preserve where they were headed so login can return them there.
    if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathname === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  /**
   * Without a matcher, proxy runs on *everything* — including `_next/static`,
   * `_next/image`, and files in `public/`. An auth redirect on those paths blocks
   * CSS and JS from loading, which presents as a completely unstyled or broken
   * page rather than as an auth problem.
   *
   * The negative lookahead also excludes /api: Route Handlers authenticate
   * themselves via requireUserOrRespond() and must answer 401, not 307 to an
   * HTML login page, or fetch() callers get an unparseable response.
   */
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
