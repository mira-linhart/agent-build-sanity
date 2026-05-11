// Per-isolate TTL cache + fetch helpers. Worker isolates have short lifetimes
// so this is best-effort warm cache; cold misses are fine. No caller state
// is retained beyond the upstream-response cache.

const USER_AGENT = "agent-build-sanity-mcp/0.2 (+https://dev.miralinhart.com)";

type CacheEntry = { value: unknown; expires_at: number };
const cache = new Map<string, CacheEntry>();

export async function cachedJson<T>(url: string, ttl_ms: number): Promise<T> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expires_at > now) {
    return hit.value as T;
  }
  const resp = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!resp.ok) {
    throw new Error(`upstream ${url} returned HTTP ${resp.status}`);
  }
  const value = (await resp.json()) as T;
  cache.set(url, { value, expires_at: now + ttl_ms });
  return value;
}

export async function cachedJsonPost<T>(
  url: string,
  body: unknown,
  ttl_ms: number,
): Promise<T> {
  const cache_key = `POST:${url}:${JSON.stringify(body)}`;
  const now = Date.now();
  const hit = cache.get(cache_key);
  if (hit && hit.expires_at > now) {
    return hit.value as T;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`upstream ${url} returned HTTP ${resp.status}`);
  }
  const value = (await resp.json()) as T;
  cache.set(cache_key, { value, expires_at: now + ttl_ms });
  return value;
}
