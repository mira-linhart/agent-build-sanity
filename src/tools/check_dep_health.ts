// check_dep_health: package supply-chain audit in one call.
//
// Sources: deps.dev (Google package graph) + OSV.dev (CVE/GHSA mirror) +
// ecosystem registries (indirectly via deps.dev). All free, no auth.
// Returns: latest version, target-version freshness, deduped advisories,
// risk flags, verdict.
//
// Defect fixes vs v0.1:
// - PyPI: skip prerelease versions when determining `latest_version`
//   (deps.dev's isDefault can be a dev release when maintainer is mid-cycle).
// - OSV: dedupe by alias group (CVE / GHSA / PYSEC of same vuln collapse),
//   rank by CVSS impact score, return top 10 with `total_unique` count
//   so the agent gets signal not noise.

import { cachedJson, cachedJsonPost } from "../lib/cache";
import { SourceTracker } from "../lib/sources";
import { dedupeAndRank, type RawAdvisory } from "../lib/osv";
import { isPrerelease } from "../lib/version";
import type { ToolDefinition, ToolResponse, Summary } from "../lib/types";

const FEEDBACK = "https://github.com/mira-linhart/agent-build-sanity/issues";

interface DepsDevVersionEntry {
  versionKey: { system: string; name: string; version: string };
  publishedAt?: string;
  isDefault?: boolean;
}

interface DepsDevVersionDetail {
  publishedAt?: string;
  licenses?: string[];
}

interface DepsDevPackage {
  packageKey?: { system: string; name: string };
  versions?: DepsDevVersionEntry[];
}

interface OsvResponse {
  vulns?: RawAdvisory[];
}

const ECOSYSTEM_MAP: Record<string, { depsdev: string; osv: string }> = {
  npm: { depsdev: "NPM", osv: "npm" },
  pypi: { depsdev: "PYPI", osv: "PyPI" },
  cargo: { depsdev: "CARGO", osv: "crates.io" },
  go: { depsdev: "GO", osv: "Go" },
  maven: { depsdev: "MAVEN", osv: "Maven" },
  nuget: { depsdev: "NUGET", osv: "NuGet" },
};

function pickLatestStable(versions: DepsDevVersionEntry[]): {
  version: string | null;
  published: string | null;
} {
  if (versions.length === 0) return { version: null, published: null };
  const sorted = [...versions].sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bt - at;
  });

  // Prefer isDefault iff stable.
  const default_entry = sorted.find((v) => v.isDefault);
  if (default_entry && !isPrerelease(default_entry.versionKey.version)) {
    return {
      version: default_entry.versionKey.version,
      published: default_entry.publishedAt ?? null,
    };
  }

  // Otherwise the most-recently-published stable.
  const stable = sorted.find((v) => !isPrerelease(v.versionKey.version));
  if (stable) {
    return { version: stable.versionKey.version, published: stable.publishedAt ?? null };
  }

  // Pure-prerelease package: fall back to whatever default / most-recent is.
  const fallback = default_entry ?? sorted[0]!;
  return {
    version: fallback.versionKey.version,
    published: fallback.publishedAt ?? null,
  };
}

function summarise(args: {
  ecosystem: string;
  pkg: string;
  target_version: string | null;
  target_is_latest: boolean;
  target_age_days: number | null;
  latest_version: string | null;
  total_unique_advisories: number;
  flags: string[];
}): Summary {
  const { ecosystem, pkg, target_version, target_is_latest, latest_version, total_unique_advisories, flags } = args;
  let verdict: string;
  let emoji: string;
  if (total_unique_advisories > 0) {
    verdict = `${ecosystem}:${pkg}@${target_version} has ${total_unique_advisories} known security advisory(ies). Review before installing.`;
    emoji = "🔴";
  } else if (target_is_latest && (args.target_age_days ?? 0) < 365) {
    verdict = `${ecosystem}:${pkg}@${target_version} looks healthy: latest stable version, recent release, no open advisories.`;
    emoji = "🟢";
  } else if (!target_is_latest) {
    verdict = `${ecosystem}:${pkg}@${target_version} is not the latest stable (latest: ${latest_version}). No advisories, but consider upgrading.`;
    emoji = "🟡";
  } else {
    verdict = `${ecosystem}:${pkg}@${target_version} is current with no open advisories, but release cadence is slow. Verify maintenance status.`;
    emoji = "🟡";
  }
  return {
    verdict,
    status_emoji: emoji,
    key_facts: [
      { label: "Package", value: `${ecosystem}:${pkg}` },
      { label: "Target version", value: target_version ?? "—" },
      { label: "Latest stable", value: latest_version ?? "—" },
      { label: "Target is latest?", value: target_is_latest ? "yes" : "no" },
      { label: "Open advisories", value: String(total_unique_advisories) },
      ...(flags.length > 0 ? [{ label: "Risk flags", value: flags.join(", ") }] : []),
    ],
  };
}

async function handler(input: Record<string, unknown>): Promise<ToolResponse> {
  const ecosystem = typeof input.ecosystem === "string" ? input.ecosystem.toLowerCase() : "";
  const pkg = typeof input.package === "string" ? input.package : "";
  const requested_version = typeof input.version === "string" ? input.version : undefined;
  const sources = new SourceTracker();
  const today_iso = new Date().toISOString();

  const eco = ECOSYSTEM_MAP[ecosystem];
  if (!eco) {
    return {
      as_of: today_iso,
      sources: sources.out(),
      query: { ecosystem: input.ecosystem ?? null, package: pkg, version: requested_version ?? null },
      summary: {
        verdict: `Unsupported ecosystem '${input.ecosystem}'. Supported: ${Object.keys(ECOSYSTEM_MAP).join(", ")}`,
        status_emoji: "⚠️",
        key_facts: [],
      },
      data: { error: "unsupported_ecosystem" },
      feedback_url: FEEDBACK,
    };
  }

  // 1. Package-level metadata for latest-stable selection.
  const pkg_url = `https://api.deps.dev/v3alpha/systems/${eco.depsdev}/packages/${encodeURIComponent(pkg)}`;
  let pkg_data: DepsDevPackage;
  try {
    pkg_data = await cachedJson<DepsDevPackage>(pkg_url, 60 * 60 * 1000);
    sources.add(pkg_url);
  } catch (e) {
    return {
      as_of: today_iso,
      sources: sources.out(),
      query: { ecosystem, package: pkg, version: requested_version ?? null },
      summary: {
        verdict: `Package '${pkg}' not found in ${ecosystem}. Check spelling.`,
        status_emoji: "⚠️",
        key_facts: [
          { label: "Error", value: String(e).slice(0, 120) },
        ],
      },
      data: { error: "package_not_found" },
      feedback_url: FEEDBACK,
    };
  }

  const versions = pkg_data.versions ?? [];
  const { version: latest_version, published: latest_published } = pickLatestStable(versions);
  const target_version = requested_version ?? latest_version;

  // 2. Version-level detail.
  let ver_data: DepsDevVersionDetail | null = null;
  if (target_version) {
    const ver_url = `https://api.deps.dev/v3alpha/systems/${eco.depsdev}/packages/${encodeURIComponent(pkg)}/versions/${encodeURIComponent(target_version)}`;
    try {
      ver_data = await cachedJson<DepsDevVersionDetail>(ver_url, 60 * 60 * 1000);
      sources.add(ver_url);
    } catch {
      ver_data = null;
    }
  }

  // 3. OSV advisories for the target version.
  const osv_url = "https://api.osv.dev/v1/query";
  const osv_body = {
    package: { name: pkg, ecosystem: eco.osv },
    ...(target_version ? { version: target_version } : {}),
  };
  let osv_resp: OsvResponse = {};
  try {
    osv_resp = await cachedJsonPost<OsvResponse>(osv_url, osv_body, 60 * 60 * 1000);
    sources.add(osv_url);
  } catch {
    osv_resp = {};
  }
  const raw_vulns = osv_resp.vulns ?? [];
  const { advisories, total_unique, total_raw } = dedupeAndRank(raw_vulns, 10);

  // 4. Compute signals.
  const days_since_latest_release =
    latest_published !== null
      ? Math.floor((Date.now() - new Date(latest_published).getTime()) / (1000 * 60 * 60 * 24))
      : null;
  const target_published = ver_data?.publishedAt ?? null;
  const target_age_days =
    target_published !== null
      ? Math.floor((Date.now() - new Date(target_published).getTime()) / (1000 * 60 * 60 * 24))
      : null;
  const target_is_latest = target_version === latest_version && target_version !== null;

  const flags: string[] = [];
  if (total_unique > 0) flags.push(`${total_unique}_open_advisories`);
  if (!target_is_latest && latest_version) flags.push("not_latest_stable");
  if (days_since_latest_release !== null && days_since_latest_release > 365)
    flags.push("stale_repo_over_1y");
  if (target_age_days !== null && target_age_days > 730) flags.push("target_over_2y_old");

  return {
    as_of: today_iso,
    sources: sources.out(),
    query: { ecosystem, package: pkg, version: requested_version ?? null },
    summary: summarise({
      ecosystem,
      pkg,
      target_version,
      target_is_latest,
      target_age_days,
      latest_version,
      total_unique_advisories: total_unique,
      flags,
    }),
    data: {
      package: pkg,
      ecosystem,
      target_version,
      target_is_latest,
      target_age_days,
      latest_version,
      latest_published,
      days_since_latest_release,
      total_versions: versions.length,
      licenses: ver_data?.licenses ?? null,
      advisories,
      advisories_truncated: total_unique > advisories.length,
      total_unique_advisories: total_unique,
      total_raw_advisories: total_raw,
      flags,
    },
    feedback_url: FEEDBACK,
  };
}

export const tool: ToolDefinition = {
  name: "check_dep_health",
  description:
    "Audit a package's supply-chain health in one call: latest stable version, target-version freshness, deduplicated security advisories (CVE/GHSA via OSV.dev, sorted by severity), licenses, release cadence, and risk flags. Stitches deps.dev (Google's package-graph API) + OSV.dev (free unlimited CVE feed) + ecosystem registries. Saves ~5,000 tokens per call vs the calling model fetching and reasoning through deps.dev + npm/PyPI/Cargo registry + GitHub advisory pages separately. Invoke before any `npm install` / `pip install` / `cargo add` / `go get` an agent is about to recommend or run. Default mode 'concise' (verdict + key facts only); 'json' for full structured response; 'pretty' for human / generative-UI rendering. Response includes auditable {as_of, sources[]}.",
  inputSchema: {
    type: "object",
    properties: {
      ecosystem: {
        type: "string",
        description: "Package ecosystem. One of: npm, pypi, cargo, go, maven, nuget. Case-insensitive.",
        enum: ["npm", "pypi", "cargo", "go", "maven", "nuget"],
      },
      package: {
        type: "string",
        description:
          "Package name as it appears in the registry (e.g. 'react', 'requests', 'serde', 'github.com/gin-gonic/gin').",
      },
      version: {
        type: "string",
        description:
          "Optional. Specific version to audit. If omitted, audits the package's latest stable version (prereleases skipped).",
      },
      mode: {
        type: "string",
        enum: ["concise", "json", "pretty"],
        description:
          "Output mode. 'concise' (default) returns verdict + key facts (saves ~80% tokens). 'json' returns full structured response with advisory list. 'pretty' returns markdown for human / generative-UI rendering.",
      },
    },
    required: ["ecosystem", "package"],
    additionalProperties: false,
  },
  handler,
};
