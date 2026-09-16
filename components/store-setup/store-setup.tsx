"use client";

import { useState, useTransition } from "react";

import {
  readStoreDraft,
  readStoreDraftFromDescription,
  saveBrandProfile,
  suggestCompetitors,
  type BrandProfileDraft,
} from "@/app/actions/onboarding";
import { Panel, PanelHeading } from "@/components/page-header";
import type { BrandProfile, CompetitorSuggestion } from "@/lib/types/database";

export function StoreSetup({
  profile,
  initialSuggestions,
}: {
  profile: BrandProfile | null;
  initialSuggestions?: CompetitorSuggestion[];
}) {
  const [mode, setMode] = useState<"url" | "description">(profile?.catalogue_source === "described" ? "description" : "url");
  const [url, setUrl] = useState(profile?.url ?? "");
  const [description, setDescription] = useState("");
  const [verified, setVerified] = useState(Boolean(profile?.url));
  const [error, setError] = useState<string | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorSuggestion[]>(initialSuggestions ?? []);
  const [reading, startReading] = useTransition();
  const [saving, startSaving] = useTransition();

  const verifyUrl = () =>
    startReading(async () => {
      setError(null);
      const result = await readStoreDraft(url);
      if (result.ok) {
        startSaving(async () => {
          const saveResult = await saveBrandProfile(result.draft);
          if (saveResult.ok) {
            setVerified(true);
            setError(null);
          } else {
            setError(saveResult.error ?? "Could not save.");
          }
        });
      } else {
        setError(result.error);
      }
    });

  const discoverCompetitors = () =>
    startReading(async () => {
      setError(null);
      const result = await readStoreDraftFromDescription(description);
      if (result.ok) {
        startSaving(async () => {
          const saveResult = await saveBrandProfile(result.draft);
          if (!saveResult.ok) {
            setError(saveResult.error ?? "Could not save profile.");
            return;
          }
          // Now discover competitors based on the saved profile
          const suggestions = await suggestCompetitors();
          if (suggestions.ok) {
            setCompetitors(suggestions.suggestions ?? []);
          } else {
            setError(suggestions.error ?? "Could not find competitors.");
          }
        });
      } else {
        setError(result.error);
      }
    });

  return (
    <main className="min-h-screen bg-gradient-to-br from-surface to-surface-sunken pb-20">
      <div className="mx-auto max-w-2xl px-6 pt-12">
        {/* Header */}
        <div className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-ink">Tell us about your business</h1>
          <p className="mt-3 text-lg text-ink-muted">
            We'll find competitors to monitor and help you stay ahead.
          </p>
        </div>

        {/* Main card */}
        <div className="rounded-2xl border border-border bg-surface p-8 shadow-sm">
          {/* Mode toggle */}
          <div className="mb-8 flex gap-3 rounded-xl bg-surface-sunken p-1">
            <button
              onClick={() => {
                setMode("url");
                setError(null);
              }}
              className={`flex-1 rounded-lg px-4 py-3 text-base font-semibold transition-all ${
                mode === "url"
                  ? "bg-accent text-accent-contrast shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              I have a website
            </button>
            <button
              onClick={() => {
                setMode("description");
                setError(null);
              }}
              className={`flex-1 rounded-lg px-4 py-3 text-base font-semibold transition-all ${
                mode === "description"
                  ? "bg-accent text-accent-contrast shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              No website yet
            </button>
          </div>

          {/* URL Mode */}
          {mode === "url" && (
            <div className="space-y-5">
              <div>
                <label htmlFor="url" className="block text-sm font-semibold text-ink">
                  Your store URL
                </label>
                <p className="mt-1 text-sm text-ink-faint">
                  Enter your Shopify store domain for verification
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    id="url"
                    type="url"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setVerified(false);
                    }}
                    placeholder="yourstore.myshopify.com"
                    disabled={verified}
                    className="flex-1 rounded-lg border border-border bg-surface px-4 py-3 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent disabled:bg-surface-sunken disabled:opacity-50"
                  />
                  {verified && (
                    <div
                      className="flex items-center justify-center rounded-lg bg-sev-low-wash px-4"
                      role="status"
                    >
                      <span aria-hidden className="text-2xl text-sev-low">✓</span>
                      <span className="sr-only">Store verified</span>
                    </div>
                  )}
                </div>
              </div>

              {!verified && (
                <button
                  onClick={verifyUrl}
                  disabled={reading || !url.trim()}
                  className="w-full rounded-lg bg-accent px-4 py-3 text-base font-semibold text-accent-contrast transition-all hover:bg-accent-hover disabled:opacity-60"
                >
                  {reading ? "Verifying…" : "Verify store"}
                </button>
              )}

              {error && (
                <div role="alert" className="rounded-lg border border-sev-critical bg-sev-critical-wash px-4 py-3">
                  <p className="text-sm font-medium text-sev-critical">{error}</p>
                </div>
              )}
            </div>
          )}

          {/* Description Mode */}
          {mode === "description" && (
            <div className="space-y-5">
              <div>
                <label htmlFor="description" className="block text-sm font-semibold text-ink">
                  Describe your business
                </label>
                <p className="mt-1 text-sm text-ink-faint">
                  What you sell, your target customers, and how you'd position yourself
                </p>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  maxLength={400}
                  placeholder="E.g., Premium outdoor gear for hikers and campers, 25-55 years old, eco-conscious buyers willing to pay for quality."
                  className="mt-3 w-full rounded-lg border border-border bg-surface px-4 py-3 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent"
                />
                <p className="mt-2 text-xs text-ink-faint">
                  {description.length}/400 characters
                </p>
              </div>

              <button
                onClick={discoverCompetitors}
                disabled={reading || !description.trim()}
                className="w-full rounded-lg bg-accent px-4 py-3 text-base font-semibold text-accent-contrast transition-all hover:bg-accent-hover disabled:opacity-60"
              >
                {reading ? "Finding competitors…" : "Find competitors"}
              </button>

              {error && (
                <div role="alert" className="rounded-lg border border-sev-critical bg-sev-critical-wash px-4 py-3">
                  <p className="text-sm font-medium text-sev-critical">{error}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Competitors section */}
        {competitors.length > 0 && (
          <div className="mt-12">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-ink">
                Ready to monitor
              </h2>
              <p className="mt-2 text-ink-muted">
                {competitors.length} competitor{competitors.length !== 1 ? 's' : ''} found in your category
              </p>
            </div>

            <div className="grid gap-4">
              {competitors.map((c) => (
                <a
                  key={c.url}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group rounded-xl border border-border bg-surface p-5 transition-all hover:border-accent hover:bg-surface-sunken hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg font-semibold text-ink group-hover:text-accent">
                        {c.name}
                      </h3>
                      <p className="mt-1 text-sm text-ink-muted">{c.url}</p>
                      {c.rationale && (
                        <p className="mt-3 text-sm text-ink-faint leading-relaxed">
                          {c.rationale}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-2xl text-accent opacity-0 transition-opacity group-hover:opacity-100">
                      →
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
