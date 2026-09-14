import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CompeteIQ",
  description: "Competitor intelligence for ecommerce and D2C brands.",
  // Single-client internal tool: keep it out of search results entirely.
  robots: { index: false, follow: false },
};

/**
 * Applied before first paint, on purpose.
 *
 * The theme lives in localStorage, which React cannot read during SSR. Setting
 * `data-theme` from an effect instead would paint the wrong theme first and
 * correct it a frame later — a white flash on every navigation for anyone who
 * chose dark. This runs synchronously in <head>, before the body renders.
 *
 * It only ever writes an *explicit* choice. With nothing stored the attribute
 * stays absent, which is what lets `prefers-color-scheme` decide — the
 * three-state behaviour the stylesheet is built around.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem("competeiq-theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full font-sans antialiased">{children}</body>
    </html>
  );
}
