// Output-mode rendering. Each tool returns the full structured response;
// the dispatcher converts to the caller's requested mode.
//
// concise (default): {as_of, sources, query, summary, feedback_url} — drops `data`.
//                    Saves ~80% tokens on the common "is this OK?" path.
// json:              Full structured response. For agents that want to filter,
//                    aggregate, or further process.
// pretty:            Markdown formatted for human / generative-UI rendering.
//                    Harnesses that render markdown (Claude Desktop, Cursor,
//                    Codex, IDE plugins) lay this out as visual cards.

import type { Mode, ToolResponse } from "./types";

export function parseMode(input: unknown): Mode {
  if (input === "json" || input === "pretty" || input === "concise") {
    return input;
  }
  return "concise";
}

export function renderResponse(response: ToolResponse, mode: Mode): unknown {
  if (mode === "json") {
    return response;
  }
  if (mode === "concise") {
    const { as_of, sources, query, summary, feedback_url } = response;
    return { as_of, sources, query, summary, feedback_url };
  }
  return { content_type: "text/markdown", markdown: renderMarkdown(response) };
}

function renderMarkdown(response: ToolResponse): string {
  const { as_of, sources, summary, feedback_url } = response;
  const emoji = summary.status_emoji ? summary.status_emoji + " " : "";

  const facts_block =
    summary.key_facts.length === 0
      ? ""
      : "\n| Field | Value |\n|---|---|\n" +
        summary.key_facts.map((f) => `| ${f.label} | ${f.value} |`).join("\n") +
        "\n";

  const sources_block =
    sources.length === 0
      ? ""
      : "\n**Sources** (as_of " + as_of + "):\n" +
        sources.map((s) => `- [${s.url}](${s.url}) — fetched ${s.fetched_at}`).join("\n") +
        "\n";

  return (
    `${emoji}**Verdict:** ${summary.verdict}\n` +
    facts_block +
    sources_block +
    `\n_If this looks wrong, [report it](${feedback_url})._\n`
  );
}
