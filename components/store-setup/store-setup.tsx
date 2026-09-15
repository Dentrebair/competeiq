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
    <main className="pb-12">
      <div className="flex flex-col gap-4 px-8">
        <Panel className="p-5">
          <PanelHeading
            eyebrow="Your business"
            title={verified || competitors.length > 0 ? "All set" : "Let's start"}
            description={
              verified
                ? "Your store is verified. Everything the product recommends is written against this."
                : competitors.length > 0
                  ? "We found 2 competitors to monitor."
                  : "Tell us about your business so we can find competitors to monitor."
            }
          />

          {mode === "url" ? (
            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="eyebrow">Your store URL</span>
                <div className="mt-1.5 flex gap-2">
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setVerified(false);
                    }}
                    placeholder="yourstore.com"
                    disabled={verified}
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                  {verified && <span className="flex items-center text-2xl text-green-600">✓</span>}
                </div>
              </label>

              {!verified && (
                <button
                  onClick={verifyUrl}
                  disabled={reading || !url.trim()}
                  className="rounded-lg bg-solid px-4 py-2.5 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
                >
                  {reading ? "Verifying…" : "Verify"}
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setMode("description");
                  setError(null);
                }}
                className="text-[15px] text-ink-muted underline-offset-4 hover:text-ink hover:underline"
              >
                I don't have a website yet
              </button>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="eyebrow">Describe your business (max 4 lines)</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  maxLength={400}
                  placeholder="What you sell, who buys it, how you'd describe your positioning…"
                  className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                />
              </label>

              <button
                onClick={discoverCompetitors}
                disabled={reading || !description.trim()}
                className="rounded-lg bg-solid px-4 py-2.5 text-[15px] font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-50"
              >
                {reading ? "Finding competitors…" : "Find competitors"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode("url");
                  setError(null);
                }}
                className="text-[15px] text-ink-muted underline-offset-4 hover:text-ink hover:underline"
              >
                I have a website
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-lg bg-sev-critical-wash px-3 py-2 text-[15px] text-sev-critical">
              {error}
            </p>
          )}
        </Panel>

        {competitors.length > 0 && (
          <Panel className="p-5">
            <PanelHeading eyebrow="Ready to monitor" title="Your competitors" />
            <div className="mt-5 space-y-3">
              {competitors.map((c) => (
                <a
                  key={c.url}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-lg border border-border p-3 hover:bg-surface-sunken"
                >
                  <div className="font-medium text-ink">{c.name}</div>
                  <div className="text-[13px] text-ink-muted">{c.url}</div>
                  {c.rationale && (
                    <div className="mt-2 text-[13px] text-ink-faint">{c.rationale}</div>
                  )}
                </a>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </main>
  );
}
