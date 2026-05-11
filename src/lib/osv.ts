// OSV advisory de-duplication and severity ranking.
//
// OSV returns each underlying vulnerability multiple times with different
// IDs (CVE, GHSA, PYSEC, BIT). The aliases array links them. We collapse
// to one entry per canonical vulnerability, picking the entry with the
// richest data (has summary, has severity), and rank by CVSS score.

export interface RawAdvisory {
  id: string;
  summary?: string | null;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  published?: string;
}

export interface DedupedAdvisory {
  id: string;
  aliases: string[];
  summary: string | null;
  severity_score: string | null;
  severity_rank: number;
  published: string | null;
}

// CVSS:3.1 scores look like "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H".
// We use the C/I/A impact triad as a coarse rank: count of HIGH impacts gives
// 0-3. Combined with AV:N (network attack vector), this ranks the worst
// vulnerabilities to the top without parsing the full CVSS base score.
function rankCvss(score: string | null): number {
  if (!score) return 0;
  const highs =
    (score.match(/C:H/) ? 1 : 0) +
    (score.match(/I:H/) ? 1 : 0) +
    (score.match(/A:H/) ? 1 : 0);
  const av_network = score.match(/AV:N/) ? 1 : 0;
  const ac_low = score.match(/AC:L/) ? 1 : 0;
  return highs * 10 + av_network * 3 + ac_low * 2;
}

export function dedupeAndRank(
  raw: RawAdvisory[],
  top_n = 10,
): { advisories: DedupedAdvisory[]; total_unique: number; total_raw: number } {
  // Build alias groups: every entry contributes its id and aliases to a set,
  // and any two entries that share any id become one group.
  const id_to_group = new Map<string, Set<string>>();
  for (const adv of raw) {
    const ids = [adv.id, ...(adv.aliases ?? [])];
    let existing: Set<string> | null = null;
    for (const id of ids) {
      const g = id_to_group.get(id);
      if (g) {
        existing = g;
        break;
      }
    }
    if (!existing) {
      existing = new Set<string>();
    }
    for (const id of ids) {
      existing.add(id);
      id_to_group.set(id, existing);
    }
  }

  // Walk groups: pick the canonical entry as the one with richest data.
  const seen_groups = new Set<Set<string>>();
  const groups: Array<{ group: Set<string>; entries: RawAdvisory[] }> = [];
  for (const adv of raw) {
    const g = id_to_group.get(adv.id)!;
    if (seen_groups.has(g)) {
      const bucket = groups.find((b) => b.group === g);
      bucket?.entries.push(adv);
      continue;
    }
    seen_groups.add(g);
    groups.push({ group: g, entries: [adv] });
  }

  const deduped: DedupedAdvisory[] = groups.map(({ group, entries }) => {
    const richest =
      entries.find((e) => e.summary && e.severity?.[0]?.score) ??
      entries.find((e) => e.summary) ??
      entries.find((e) => e.severity?.[0]?.score) ??
      entries[0]!;
    const score = richest.severity?.[0]?.score ?? null;
    const canonical_id =
      [...group].find((id) => id.startsWith("CVE-")) ??
      [...group].find((id) => id.startsWith("GHSA-")) ??
      richest.id;
    return {
      id: canonical_id,
      aliases: [...group].filter((id) => id !== canonical_id).sort(),
      summary: richest.summary ?? null,
      severity_score: score,
      severity_rank: rankCvss(score),
      published: richest.published ?? null,
    };
  });

  deduped.sort((a, b) => {
    if (b.severity_rank !== a.severity_rank) return b.severity_rank - a.severity_rank;
    const at = a.published ? new Date(a.published).getTime() : 0;
    const bt = b.published ? new Date(b.published).getTime() : 0;
    return bt - at;
  });

  return {
    advisories: deduped.slice(0, top_n),
    total_unique: deduped.length,
    total_raw: raw.length,
  };
}
