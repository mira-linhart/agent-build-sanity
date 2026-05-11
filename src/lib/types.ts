// Shared types for the agent-build-sanity bundle.

export interface Env {
  SERVER_NAME: string;
  SERVER_VERSION: string;
  BUNDLE_NAME: string;
  LANDING_URL: string;
}

export type Mode = "concise" | "json" | "pretty";

export interface SourceRef {
  url: string;
  fetched_at: string;
}

export interface KeyFact {
  label: string;
  value: string;
}

export interface Summary {
  verdict: string;
  status_emoji?: string;
  key_facts: KeyFact[];
}

export interface ToolResponse<T = unknown> {
  as_of: string;
  sources: SourceRef[];
  query: Record<string, unknown>;
  summary: Summary;
  data: T;
  feedback_url: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<ToolResponse>;
}
