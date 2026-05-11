// agent-build-sanity-mcp dispatcher.
//
// One Cloudflare Worker, multiple tools. Tools live in src/tools/; each is a
// module exporting `{name, description, inputSchema, handler}`. The registry
// at src/tools/registry.ts is the single place to enumerate them.
//
// Form factor: stateless. No caller input retained. Worker isolates have
// short lifetimes; per-isolate in-memory cache is best-effort warm.

import { TOOLS, TOOLS_BY_NAME } from "./tools/registry";
import { parseMode, renderResponse } from "./lib/output";
import type { Env } from "./lib/types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function handleJsonRpc(body: JsonRpcRequest, env: Env): Promise<unknown> {
  const { id, method, params } = body;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: env.SERVER_NAME, version: env.SERVER_VERSION },
        },
      };
    case "notifications/initialized":
      return null;
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };
    case "tools/call": {
      const tool_name = params?.name;
      const tool_args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof tool_name !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "invalid params: name must be a string" },
        };
      }
      const tool = TOOLS_BY_NAME.get(tool_name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unknown tool: ${tool_name}` },
        };
      }
      const mode = parseMode(tool_args.mode);
      try {
        const response = await tool.handler(tool_args);
        const rendered = renderResponse(response, mode);
        const text =
          mode === "pretty" && rendered && typeof rendered === "object" && "markdown" in rendered
            ? (rendered as { markdown: string }).markdown
            : JSON.stringify(rendered, null, 2);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `tool error: ${String(e)}` },
        };
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      };
  }
}

const LANDING_TEXT = (env: Env) =>
  `${env.SERVER_NAME} · v${env.SERVER_VERSION} · "${env.BUNDLE_NAME}" bundle

MCP server. Connect with any client supporting the Streamable HTTP transport.
Endpoint: this URL (POST JSON-RPC).
Landing: ${env.LANDING_URL}

Tools:
  · check_model_currency  — is this LLM model ID still callable?
  · check_dep_health      — package supply-chain audit (deps.dev + OSV + registries)
  · check_runtime_eol     — runtime / framework / distro EOL with curated successors

All tools support mode={concise|json|pretty}. Default is concise (saves ~80% tokens).
Every response carries {as_of, sources[]} for auditable freshness.
Feedback: https://github.com/mira-linhart/agent-build-sanity/issues
`;

const LANDING_HTML = (env: Env) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<title>${env.SERVER_NAME} · ${env.BUNDLE_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="canonical" href="${env.LANDING_URL}" />
<meta name="robots" content="index,follow" />
<meta name="description" content="MCP server bundle. Stateless agent-facing checks: model deprecation, dependency supply-chain health, runtime EOL. Multi-source freshness with auditable sources." />
<style>
  body { font-family: 'SF Mono', 'JetBrains Mono', monospace; background: #fafafa; color: #0e0e0e; max-width: 720px; margin: 40px auto; padding: 0 24px 80px; line-height: 1.55; font-size: 15px; }
  h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -0.01em; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  p { margin: 0 0 14px; }
  code, pre { background: rgba(0,0,0,0.06); padding: 2px 5px; border-radius: 3px; font-size: 13px; }
  pre { padding: 12px 14px; overflow-x: auto; line-height: 1.45; }
  a { color: #1a4f8b; }
  ul { padding-left: 22px; }
  li { margin-bottom: 4px; }
  .meta { color: #6b6b6b; font-size: 13px; }
</style>
</head>
<body>
<h1>${env.SERVER_NAME}</h1>
<p class="meta">v${env.SERVER_VERSION} · "${env.BUNDLE_NAME}" bundle · MCP over Streamable HTTP</p>
<p>Stateless MCP server. Stitches multiple free upstream APIs into structured, agent-consumable output with auditable provenance. Inference cost stays with the calling model.</p>

<h2>Endpoint</h2>
<pre>POST https://dev.miralinhart.com/</pre>

<h2>Tools</h2>
<ul>
  <li><code>check_model_currency</code> — is this LLM model ID still callable? (OpenAI / Anthropic / Google / Vertex / Cohere / Bedrock / xAI)</li>
  <li><code>check_dep_health</code> — package supply-chain audit (npm / pypi / cargo / go / maven / nuget)</li>
  <li><code>check_runtime_eol</code> — runtime / framework / distro EOL with curated successors</li>
</ul>
<p>All tools accept <code>mode={concise|json|pretty}</code>. Default <code>concise</code> saves ~80% tokens.</p>

<h2>Connect (Claude Desktop)</h2>
<pre>{
  "mcpServers": {
    "agent-build-sanity": {
      "type": "http",
      "url": "https://dev.miralinhart.com"
    }
  }
}</pre>

<h2>Connect (Cursor / Codex / other MCP clients)</h2>
<p>Add as a Streamable HTTP MCP server with URL <code>https://dev.miralinhart.com</code>. For stdio-only clients, use <code>npx mcp-remote https://dev.miralinhart.com</code>.</p>

<h2>Full landing</h2>
<p><a href="${env.LANDING_URL}">${env.LANDING_URL}</a> — examples, demo, and the audit-trail story.</p>

<h2>Feedback / issues</h2>
<p><a href="https://github.com/mira-linhart/agent-build-sanity/issues">github.com/mira-linhart/agent-build-sanity/issues</a></p>
</body>
</html>
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET") {
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("text/html")) {
        return new Response(LANDING_HTML(env), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(LANDING_TEXT(env), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const result = await handleJsonRpc(body, env);
    if (result === null) {
      return new Response("", { status: 202 });
    }
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  },
};
