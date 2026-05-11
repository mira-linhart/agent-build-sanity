// check_runtime_eol: end-of-life status for runtime / framework / OS / db.
// Source: endoflife.date (free JSON API).

import { cachedJson } from "../lib/cache";
import { SourceTracker } from "../lib/sources";
import { FEEDBACK_URL } from "../lib/constants";
import type { ToolDefinition, ToolResponse, Summary } from "../lib/types";

// Curated successor map for products with no active cycles. Each entry says
// "if you were using X, here's where to go next." Editorial — extend as the
// audit-trail surfaces unmapped retirements.
const SUCCESSOR_MAP: Record<string, string[]> = {
  centos: ["rocky-linux", "almalinux", "rhel"],
  "centos-stream": ["rocky-linux", "almalinux", "rhel"],
  "windows-7": ["windows-10", "windows-11"],
  "windows-8": ["windows-10", "windows-11"],
  "internet-explorer": ["edge"],
};

interface EolCycle {
  cycle: string;
  releaseDate?: string;
  eol?: string | boolean;
  support?: string | boolean;
  extendedSupport?: string | boolean;
  latest?: string;
  latestReleaseDate?: string;
  lts?: boolean | string;
  discontinued?: string | boolean;
}

type CycleStatus = "active" | "security_only" | "eol" | "discontinued" | "unknown";

interface EnrichedCycle extends EolCycle {
  status: CycleStatus;
  eol_date: string | null;
  days_until_eol: number | null;
}

function classify(c: EolCycle, today: Date): {
  status: CycleStatus;
  eol_date: string | null;
  days_until_eol: number | null;
} {
  if (c.discontinued && c.discontinued !== false) {
    return {
      status: "discontinued",
      eol_date: typeof c.discontinued === "string" ? c.discontinued : null,
      days_until_eol: null,
    };
  }
  if (c.eol === true) return { status: "eol", eol_date: null, days_until_eol: null };
  if (typeof c.eol === "string") {
    const eol_date = new Date(c.eol);
    if (eol_date.getTime() < today.getTime()) {
      return { status: "eol", eol_date: c.eol, days_until_eol: 0 };
    }
    const days_until_eol = Math.floor(
      (eol_date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (
      c.support === false ||
      (typeof c.support === "string" && new Date(c.support).getTime() < today.getTime())
    ) {
      return { status: "security_only", eol_date: c.eol, days_until_eol };
    }
    return { status: "active", eol_date: c.eol, days_until_eol };
  }
  return { status: "unknown", eol_date: null, days_until_eol: null };
}

function summariseProduct(
  product: string,
  enriched: EnrichedCycle[],
  recommended_target: EnrichedCycle | null,
  fully_retired: boolean,
  successors: string[],
): Summary {
  if (fully_retired) {
    const succ = successors.length > 0 ? successors.join(", ") : "no curated successors yet";
    return {
      verdict: `${product} is FULLY RETIRED — all cycles are end-of-life. Successor products: ${succ}.`,
      status_emoji: "🔴",
      key_facts: [
        { label: "Product", value: product },
        { label: "Status", value: "fully_retired" },
        { label: "Cycles tracked", value: String(enriched.length) },
        { label: "Successors", value: succ },
      ],
    };
  }
  if (!recommended_target) {
    return {
      verdict: `No active cycles found for ${product}. Verify product name on endoflife.date.`,
      status_emoji: "⚠️",
      key_facts: [{ label: "Product", value: product }, { label: "Cycles tracked", value: String(enriched.length) }],
    };
  }
  return {
    verdict: `Recommended target for ${product}: cycle ${recommended_target.cycle} (EOL ${recommended_target.eol_date ?? "—"}, ${recommended_target.days_until_eol ?? "?"} days away). ${enriched.filter((c) => c.status === "active").length} active cycle(s); ${enriched.filter((c) => c.status === "eol").length} EOL.`,
    status_emoji: "🟢",
    key_facts: [
      { label: "Product", value: product },
      { label: "Recommended cycle", value: recommended_target.cycle },
      { label: "EOL date", value: recommended_target.eol_date ?? "—" },
      { label: "Days until EOL", value: String(recommended_target.days_until_eol ?? "—") },
      { label: "LTS?", value: recommended_target.lts ? "yes" : "no" },
      { label: "Active cycles", value: String(enriched.filter((c) => c.status === "active").length) },
    ],
  };
}

function summariseCycle(product: string, version: string, cycle: EnrichedCycle): Summary {
  const status_text = cycle.status.replace("_", " ");
  const verdict =
    cycle.status === "eol"
      ? `${product} ${version} is END-OF-LIFE (since ${cycle.eol_date}). No security patches. Upgrade required.`
      : cycle.status === "security_only"
        ? `${product} ${version} is in SECURITY-ONLY mode (full support ended; EOL ${cycle.eol_date}, ${cycle.days_until_eol} days away). Plan upgrade.`
        : cycle.status === "active"
          ? `${product} ${version} is ACTIVELY supported (EOL ${cycle.eol_date}, ${cycle.days_until_eol} days away).`
          : cycle.status === "discontinued"
            ? `${product} ${version} is DISCONTINUED.`
            : `${product} ${version} status is unknown — verify on endoflife.date.`;
  const emoji =
    cycle.status === "eol" || cycle.status === "discontinued"
      ? "🔴"
      : cycle.status === "security_only"
        ? "🟡"
        : cycle.status === "active"
          ? "🟢"
          : "⚠️";
  return {
    verdict,
    status_emoji: emoji,
    key_facts: [
      { label: "Product / cycle", value: `${product} ${cycle.cycle}` },
      { label: "Status", value: status_text },
      { label: "EOL date", value: cycle.eol_date ?? "—" },
      { label: "Days until EOL", value: String(cycle.days_until_eol ?? "—") },
      { label: "LTS?", value: cycle.lts ? "yes" : "no" },
      { label: "Latest release", value: cycle.latest ?? "—" },
    ],
  };
}

async function handler(input: Record<string, unknown>): Promise<ToolResponse> {
  const product = typeof input.product === "string" ? input.product.toLowerCase() : "";
  const version = typeof input.version === "string" ? input.version : undefined;
  const sources = new SourceTracker();
  const today = new Date();
  const today_iso = today.toISOString().slice(0, 10);
  const url = `https://endoflife.date/api/${encodeURIComponent(product)}.json`;

  let cycles: EolCycle[];
  try {
    cycles = await cachedJson<EolCycle[]>(url, 6 * 60 * 60 * 1000);
    sources.add(url);
  } catch (e) {
    return {
      as_of: today_iso,
      sources: sources.out(),
      query: { product, version: version ?? null },
      summary: {
        verdict: `Product '${product}' not found on endoflife.date. Try a different slug (e.g. 'nodejs' not 'node', 'python' for Python, 'ubuntu' for Ubuntu).`,
        status_emoji: "⚠️",
        key_facts: [{ label: "Error", value: String(e).slice(0, 120) }],
      },
      data: { error: "product_not_found" },
      feedback_url: FEEDBACK_URL,
    };
  }

  const enriched: EnrichedCycle[] = cycles.map((c) => ({ ...c, ...classify(c, today) }));
  const has_any_active = enriched.some((c) => c.status === "active" || c.status === "security_only");
  const fully_retired = !has_any_active && enriched.length > 0;
  const successors = SUCCESSOR_MAP[product] ?? [];

  if (version) {
    const matched =
      enriched.find(
        (c) =>
          c.cycle === version ||
          c.cycle === version.replace(/\.\d+$/, "") ||
          version.startsWith(c.cycle + "."),
      ) ?? null;
    if (!matched) {
      return {
        as_of: today_iso,
        sources: sources.out(),
        query: { product, version },
        summary: {
          verdict: `No cycle matches version '${version}' for product '${product}'.`,
          status_emoji: "⚠️",
          key_facts: [
            { label: "Available cycles", value: enriched.map((c) => c.cycle).join(", ") || "—" },
          ],
        },
        data: { error: "version_not_matched", available_cycles: enriched.map((c) => c.cycle) },
        feedback_url: FEEDBACK_URL,
      };
    }
    return {
      as_of: today_iso,
      sources: sources.out(),
      query: { product, version },
      summary: summariseCycle(product, version, matched),
      data: matched,
      feedback_url: FEEDBACK_URL,
    };
  }

  const active_lts = enriched.find((c) => c.status === "active" && c.lts);
  const latest_active = enriched.find((c) => c.status === "active");
  const recommended_target = active_lts ?? latest_active ?? null;

  return {
    as_of: today_iso,
    sources: sources.out(),
    query: { product, version: null },
    summary: summariseProduct(product, enriched, recommended_target, fully_retired, successors),
    data: {
      cycles: enriched,
      recommended_target: recommended_target?.cycle ?? null,
      recommended_target_eol: recommended_target?.eol ?? null,
      fully_retired,
      successor_products: successors,
    },
    feedback_url: FEEDBACK_URL,
  };
}

export const tool: ToolDefinition = {
  name: "check_runtime_eol",
  description:
    "Check end-of-life status for a runtime / framework / OS / database / programming language. Returns active support status, security-only window, EOL date, days until EOL, and the currently recommended LTS target. For fully-retired products (CentOS, Windows 7, etc.) returns curated successor product names. Sources endoflife.date (455+ tracked products). Saves ~2,000 tokens per call vs the calling model reading per-product EOL pages. Invoke when writing Dockerfile FROM lines, CI matrix configs, `engines` fields in package.json, or any deployment decision touching a versioned runtime. Default mode 'concise'; 'json' for full cycle matrix; 'pretty' for human / generative-UI rendering. Response includes auditable {as_of, sources[]}.",
  inputSchema: {
    type: "object",
    properties: {
      product: {
        type: "string",
        description:
          "Product slug as it appears on endoflife.date (e.g. 'nodejs', 'python', 'ubuntu', 'postgresql', 'redis', 'go', 'php', 'ruby', 'kubernetes', 'centos'). Use the slug, not the display name.",
      },
      version: {
        type: "string",
        description:
          "Optional. Specific version cycle to look up (e.g. '18' for Node 18.x, '3.11' for Python 3.11). If omitted, returns the full matrix plus a recommended target.",
      },
      mode: {
        type: "string",
        enum: ["concise", "json", "pretty"],
        description:
          "Output mode. 'concise' (default) returns verdict + key facts. 'json' returns full cycle matrix. 'pretty' returns markdown for human / generative-UI rendering.",
      },
    },
    required: ["product"],
    additionalProperties: false,
  },
  handler,
};
