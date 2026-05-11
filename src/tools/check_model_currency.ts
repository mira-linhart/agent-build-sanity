// check_model_currency: "is this LLM model ID still callable?"
//
// Source: deprecations.info v1 feed (CDN-cached static JSON; ~250 KB; covers
// OpenAI / Anthropic / Google / Vertex / Cohere / Bedrock / xAI lifecycle).
// Freshness arbitrage: training-data cutoffs are months stale on model
// shutdowns; provider deprecation pages are the source of truth.

import { cachedJson } from "../lib/cache";
import { SourceTracker } from "../lib/sources";
import type { ToolDefinition, ToolResponse, Summary } from "../lib/types";

const FEED = "https://deprecations.info/v1/deprecations.json";
const FEEDBACK = "https://github.com/mira-linhart/agent-build-sanity/issues";

interface DeprecationEntry {
  provider: string;
  model_id: string;
  announcement_date: string;
  shutdown_date: string;
  deprecation_date: string;
  replacement_models: string[];
  deprecation_context: string;
  url: string;
  scraped_at: string;
}

type Status = "active" | "deprecated" | "shutdown";

interface EnrichedMatch {
  provider: string;
  model_id: string;
  status: Status;
  announcement_date: string;
  deprecation_date: string;
  shutdown_date: string;
  days_until_shutdown: number | null;
  replacement_models: string[];
  provider_announcement_url: string;
}

function enrich(e: DeprecationEntry, today: Date): EnrichedMatch {
  let status: Status = "active";
  let days_until_shutdown: number | null = null;
  const shutdown = e.shutdown_date ? new Date(e.shutdown_date) : null;
  const deprecation = e.deprecation_date ? new Date(e.deprecation_date) : null;
  if (shutdown && shutdown.getTime() < today.getTime()) {
    status = "shutdown";
  } else if (deprecation && deprecation.getTime() < today.getTime()) {
    status = "deprecated";
    if (shutdown) {
      days_until_shutdown = Math.floor(
        (shutdown.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
    }
  }
  return {
    provider: e.provider,
    model_id: e.model_id,
    status,
    announcement_date: e.announcement_date,
    deprecation_date: e.deprecation_date,
    shutdown_date: e.shutdown_date,
    days_until_shutdown,
    replacement_models: e.replacement_models,
    provider_announcement_url: e.url,
  };
}

function summarise(matches: EnrichedMatch[]): Summary {
  if (matches.length === 0) {
    return {
      verdict:
        "No matching deprecation found. The model is either currently active, not tracked, or the ID is wrong. Confirm with provider docs.",
      status_emoji: "🟢",
      key_facts: [],
    };
  }
  const worst = matches.find((m) => m.status === "shutdown")
    ?? matches.find((m) => m.status === "deprecated")
    ?? matches[0]!;
  const verdict =
    worst.status === "shutdown"
      ? `${worst.provider} / ${worst.model_id} is SHUT DOWN as of ${worst.shutdown_date}. API calls will return errors. Migrate to ${worst.replacement_models[0] ?? "a current model"}.`
      : worst.status === "deprecated"
        ? `${worst.provider} / ${worst.model_id} is DEPRECATED (still callable but scheduled for shutdown ${worst.shutdown_date}, ${worst.days_until_shutdown ?? "?"} days away). Plan migration to ${worst.replacement_models[0] ?? "a current model"}.`
        : `${worst.provider} / ${worst.model_id} appears active. ${matches.length} total match(es).`;
  const emoji = worst.status === "shutdown" ? "🔴" : worst.status === "deprecated" ? "🟡" : "🟢";
  const key_facts = [
    { label: "Provider", value: worst.provider },
    { label: "Model ID", value: worst.model_id },
    { label: "Status", value: worst.status },
    { label: "Shutdown date", value: worst.shutdown_date || "—" },
    {
      label: "Days until shutdown",
      value:
        worst.days_until_shutdown === null
          ? worst.status === "shutdown"
            ? "passed"
            : "—"
          : String(worst.days_until_shutdown),
    },
    {
      label: "Replacement",
      value: worst.replacement_models.join(", ") || "—",
    },
    ...(matches.length > 1
      ? [{ label: "Other matches", value: String(matches.length - 1) }]
      : []),
  ];
  return { verdict, status_emoji: emoji, key_facts };
}

async function handler(input: Record<string, unknown>): Promise<ToolResponse> {
  const provider = typeof input.provider === "string" ? input.provider : undefined;
  const model_id = typeof input.model_id === "string" ? input.model_id : undefined;
  const sources = new SourceTracker();

  const entries = await cachedJson<DeprecationEntry[]>(FEED, 60 * 60 * 1000);
  sources.add(FEED);

  const today = new Date();
  const today_iso = today.toISOString().slice(0, 10);

  if (!provider && !model_id) {
    const providers_seen = [...new Set(entries.map((e) => e.provider))].sort();
    return {
      as_of: today_iso,
      sources: sources.out(),
      query: { provider: null, model_id: null },
      summary: {
        verdict: `${entries.length} deprecations tracked across ${providers_seen.length} providers. Call with {provider, model_id} to check a specific model.`,
        status_emoji: "ℹ️",
        key_facts: [
          { label: "Total tracked", value: String(entries.length) },
          { label: "Providers", value: providers_seen.slice(0, 5).join(", ") + (providers_seen.length > 5 ? "…" : "") },
        ],
      },
      data: {
        total_deprecations_tracked: entries.length,
        providers_with_deprecations: providers_seen,
      },
      feedback_url: FEEDBACK,
    };
  }

  const matches = entries.filter((e) => {
    const provider_match =
      !provider || e.provider.toLowerCase().includes(provider.toLowerCase());
    const model_match =
      !model_id || e.model_id.toLowerCase().includes(model_id.toLowerCase());
    return provider_match && model_match;
  });

  const enriched = matches.map((e) => enrich(e, today));

  return {
    as_of: today_iso,
    sources: sources.out(),
    query: { provider: provider ?? null, model_id: model_id ?? null },
    summary: summarise(enriched),
    data: { match_count: enriched.length, matches: enriched },
    feedback_url: FEEDBACK,
  };
}

export const tool: ToolDefinition = {
  name: "check_model_currency",
  description:
    "Check whether an LLM model ID is still callable. Returns deprecation status (active / deprecated / shutdown), days until shutdown, and replacement-model suggestions, sourced from deprecations.info's tracked feed of OpenAI / Anthropic / Google / Vertex / Cohere / Bedrock model lifecycle events. Saves ~3,000 tokens per call vs the calling model reading provider deprecation pages. Invoke before writing any code that instantiates an SDK with a hard-coded model string — training data is months stale and providers shut down models constantly. Default mode is 'concise' (verdict + key facts only); pass mode='json' for the full structured response or mode='pretty' for human / generative-UI rendering. Response includes auditable {as_of, sources[]}.",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description:
          "Optional. Provider name to filter by (e.g. 'OpenAI', 'Anthropic', 'Google', 'Google Vertex', 'Cohere', 'Bedrock', 'xAI'). Substring match; case-insensitive.",
      },
      model_id: {
        type: "string",
        description:
          "Optional. Model ID to check (e.g. 'claude-3-5-sonnet', 'gpt-4o-mini', 'gemini-1.5-pro'). Substring match. If omitted with provider, returns all tracked deprecations for that provider.",
      },
      mode: {
        type: "string",
        enum: ["concise", "json", "pretty"],
        description:
          "Output mode. 'concise' (default) returns just verdict + key facts (saves ~80% tokens). 'json' returns full structured response with all fields. 'pretty' returns markdown formatted for human / generative-UI rendering.",
      },
    },
    additionalProperties: false,
  },
  handler,
};
