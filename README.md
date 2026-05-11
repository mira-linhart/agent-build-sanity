# agent-build-sanity

MCP server bundle for agentic coding harnesses. Three stateless tools that catch the things training data is months stale on — dead model IDs, dependencies with open CVEs, end-of-life runtimes — before the agent ships broken code.

**Endpoint:** [`https://dev.miralinhart.com`](https://dev.miralinhart.com)
**Landing:** [miralinhart.com/dev/](https://miralinhart.com/dev/)
**Launch story:** [I shipped a build-sanity MCP because my agent kept writing broken code](https://miralinhart.com/writing/2026-05-12-agent-build-sanity-launch)

Free, no auth, stateless (no caller input retained). Cloudflare Worker hosted. Five-minute integration.

## The problem

Yesterday I asked my coding agent to scaffold a small Python service. It picked `claude-3-5-sonnet` as the LLM model. It picked `python:3.9` as the Docker base. It picked `django==3.2` as a dependency. All three were sensible choices in 2024. In May 2026 they are, respectively: **shut down** (October 2025), **end-of-life** (October 2025), and **carrying 30 open CVEs**. The agent had no way to know any of this — its training data ended before any of it happened.

This bundle is the freshness layer. Three MCP tools. Each stitches multiple free public APIs into a single agent-consumable response with auditable `{as_of, sources[]}` provenance.

## The three tools

### `check_model_currency`

Is this LLM model ID still callable? Returns deprecation status (active / deprecated / shutdown), days until shutdown, and replacement-model suggestions, sourced from [deprecations.info](https://deprecations.info)'s tracked feed of OpenAI / Anthropic / Google / Vertex / Cohere / Bedrock / xAI lifecycle events.

**Saves ~3,000 tokens per call** vs the calling model reading provider deprecation pages.

### `check_dep_health`

Package supply-chain audit in one call: latest stable version, target-version freshness, deduplicated security advisories (CVE/GHSA via OSV.dev, sorted by CVSS severity), licenses, release cadence, risk flags. Stitches [deps.dev](https://deps.dev) (Google's package-graph API) + [OSV.dev](https://osv.dev) + ecosystem registries.

Supports `npm`, `pypi`, `cargo`, `go`, `maven`, `nuget`.

**Saves ~5,000 tokens per call** vs the calling model fetching and reasoning through deps.dev + npm/PyPI/Cargo registry + GitHub advisory pages separately.

### `check_runtime_eol`

End-of-life status for a runtime / framework / OS / database / programming language. Returns active-support status, security-only window, EOL date, days until EOL, recommended LTS target. Fully-retired products (CentOS, Windows 7) return curated successor recommendations. Sources [endoflife.date](https://endoflife.date) (455+ tracked products).

**Saves ~2,000 tokens per call** vs the calling model reading per-product EOL pages.

## Three output modes

All tools accept `mode={concise|json|pretty}`:

- **`concise`** (default) — verdict + key facts only, saves ~80% of response tokens for the common "is this OK?" path.
- **`json`** — full structured response with the complete data block.
- **`pretty`** — markdown formatted for human / generative-UI rendering. Harnesses that render markdown lay this out as a visual card.

## Quick start

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "agent-build-sanity": {
      "type": "http",
      "url": "https://dev.miralinhart.com"
    }
  }
}
```

### Cursor / Codex / other Streamable-HTTP clients

Add as MCP server with URL `https://dev.miralinhart.com`.

### stdio-only clients

```sh
npx mcp-remote https://dev.miralinhart.com
```

### Just curl

```sh
curl -X POST https://dev.miralinhart.com \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"check_model_currency",
    "arguments":{"provider":"Anthropic","model_id":"claude-3-5-sonnet"}}}'
```

## Example response

`check_model_currency({provider: "Anthropic", model_id: "claude-3-5-sonnet"})` in default `concise` mode returns:

```json
{
  "as_of": "2026-05-11",
  "sources": [
    {
      "url": "https://deprecations.info/v1/deprecations.json",
      "fetched_at": "2026-05-11T10:40:01.003Z"
    }
  ],
  "query": { "provider": "Anthropic", "model_id": "claude-3-5-sonnet" },
  "summary": {
    "verdict": "Anthropic / claude-3-5-sonnet-20240620 is SHUT DOWN as of 2025-10-28. API calls will return errors. Migrate to claude-sonnet-4-6.",
    "status_emoji": "🔴",
    "key_facts": [
      { "label": "Provider", "value": "Anthropic" },
      { "label": "Model ID", "value": "claude-3-5-sonnet-20240620" },
      { "label": "Status", "value": "shutdown" },
      { "label": "Shutdown date", "value": "2025-10-28" },
      { "label": "Replacement", "value": "claude-sonnet-4-6" }
    ]
  },
  "feedback_url": "https://github.com/mira-linhart/agent-build-sanity/issues"
}
```

## Architecture

Single Cloudflare Worker, multiple tools, shared in-memory TTL cache. Tools live in `src/tools/`; each is a self-contained module exporting `{name, description, inputSchema, handler}`. The registry at `src/tools/registry.ts` is the single place to enumerate them. Adding a new tool is ~50 lines.

- **Stateless.** No caller input retained. No PII storage.
- **Auditable.** Every response carries `{as_of, sources: [{url, fetched_at}]}` — the Bloomberg "trust the number" property made machine-verifiable.
- **Cost-shifted.** The MCP returns structured truth (~500 tokens); the calling agent's model does the reasoning. Our marginal compute cost per call is ~£0.

## Why this exists

Every model has a training cutoff. The world keeps moving past it. By the time the model has been trained, evaluated, deployed, and you're using it, the cutoff is at least three months stale. Inside that window: provider deprecations land, CVEs get published, runtimes hit EOL, packages get hijacked, defaults change. An MCP that's *current* about the moving parts of the world is structurally differentiated from anything the calling model can derive itself. And the gap widens every quarter.

This is the Bloomberg Terminal shape at indie scale. The data isn't the moat (every Bloomberg fact is fetched from somewhere). The moat is editorial freshness, workflow integration, and verifiable trust.

## Roadmap

In priority order:

- `check_breaking_change_path` — structured upgrade-path planner between major versions
- `recommend_packages` — ranked package recommendations by category, freshness-aware
- `check_supply_chain_incident` — recent maintainer-handoff / typosquat / takedown events
- `domain_reputation_stack` — crt.sh × Wayback × threat-feed composite for URL trust

Feedback shapes priority. Open an [issue](https://github.com/mira-linhart/agent-build-sanity/issues) with what you'd want next.

## Local development

```sh
npm install
npx wrangler dev   # local dev server on :8787
npx wrangler deploy
```

The Worker reads its config from `wrangler.toml`. Custom domain is `dev.miralinhart.com`; if you fork, update that route or remove it to use the workers.dev subdomain.

## Feedback

[github.com/mira-linhart/agent-build-sanity/issues](https://github.com/mira-linhart/agent-build-sanity/issues) — bug reports, false positives, missing products, success stories. Especially welcome: cases where the tool returned a wrong or noisy answer, with the exact arguments. That's how the curation improves.

## Licence

MIT. See [LICENSE](LICENSE).

## About

By [Mira Linhart](https://miralinhart.com) — independent UK software engineer building small, specific tools for agent-driven workflows. Part of a portfolio: see also [Mira Review](https://miralinhart.com/review/) (adversarial decision review) and [kill_my_idea MCP](https://mcp.miralinhart.com).
