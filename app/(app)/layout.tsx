import { AppSidebar } from "@/components/app-sidebar";
import { ChatProvider } from "@/components/chat-provider";
import { requireUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

/**
 * The authenticated shell. `/login` sits outside this route group so it renders
 * without the rail — a sign-in page with a navigation sidebar you cannot use is
 * a small thing that reads as broken.
 *
 * Route groups do not appear in the URL, so `/`, `/alerts` and the rest are
 * unchanged by living under `(app)`.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  // The authorization boundary — see lib/dal.ts for why this is here and not in
  // proxy.ts. Every page inside this group is covered by it, and each still
  // calls requireUser() itself: a layout is not a guarantee, because a page can
  // be rendered without its layout during some navigations.
  const user = await requireUser();
  const supabase = await createClient();

  // Drives the badge on Alerts. Cheap enough to run per navigation — it is a
  // count with no row payload, and a stale badge on a triage queue is worse
  // than the query.
  const { count } = await supabase
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .eq("is_read", false);

  return (
    <ChatProvider>
      <div className="flex min-h-screen">
        <AppSidebar email={user.email ?? ""} unreadCount={count ?? 0} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </ChatProvider>
  );
}
