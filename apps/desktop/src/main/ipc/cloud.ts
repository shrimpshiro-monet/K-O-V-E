import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getKeyStore } from "./keychain";

export type CloudService =
  | "elevenlabs"
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "anthropic-compatible"
  | "cloudflare";

interface ServiceConfig {
  baseUrl: string;
  authHeaders: (key: string) => Record<string, string>;
}

// Mirror of apps/web/src/services/api-proxy.ts DIRECT_CONFIG. apps/desktop cannot import apps/web,
// so this is a deliberate duplication — keep it in sync if the web config changes.
export const DIRECT_CONFIG: Record<
  Exclude<
    CloudService,
    "openai-compatible" | "anthropic-compatible" | "cloudflare"
  >,
  ServiceConfig
> = {
  elevenlabs: {
    baseUrl: "https://api.elevenlabs.io/v1",
    authHeaders: (key) => ({ "xi-api-key": key }),
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
};

/**
 * Cloudflare Workers AI credentials for the desktop main process.
 *
 * Read at REQUEST time from the environment (packaged apps) or .dev.vars
 * (development checkouts) — never bundled into the renderer. The renderer's
 * cloudflare LLM transport relays through this service, so the token only
 * ever exists in the main process.
 */
export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

function parseDevVarsText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function devVarsCandidates(): string[] {
  const candidates = [path.resolve(process.cwd(), ".dev.vars")];
  // Running from apps/desktop/ (the common dev cwd): the repo-root .dev.vars.
  candidates.push(path.resolve(__dirname, "../../../../.dev.vars"));
  return candidates;
}

export function resolveCloudflareCredentials(): CloudflareCredentials | null {
  const fromEnv: CloudflareCredentials = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  };
  if (fromEnv.accountId && fromEnv.apiToken) return fromEnv;
  for (const file of devVarsCandidates()) {
    if (!existsSync(file)) continue;
    try {
      const vars = parseDevVarsText(readFileSync(file, "utf-8"));
      const accountId = fromEnv.accountId || vars.CLOUDFLARE_ACCOUNT_ID || "";
      const apiToken = fromEnv.apiToken || vars.CLOUDFLARE_API_TOKEN || "";
      if (accountId && apiToken) return { accountId, apiToken };
    } catch {
      // unreadable .dev.vars — keep looking
    }
  }
  return null;
}

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function normalizeCompatibleBaseUrl(input: string | undefined): string {
  const value = input?.trim() ?? "";
  if (!value) throw new Error("Missing compatible API base URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Compatible endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Compatible endpoint cannot contain credentials, query, or fragment");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(?:chat\/completions|messages|models)$/i, "");
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

export function buildUpstreamRequest(
  service: CloudService,
  path: string,
  key: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    baseUrl?: string;
  },
): UpstreamRequest {
  if (
    service === "openai-compatible" ||
    service === "anthropic-compatible"
  ) {
    const allowedPaths =
      service === "openai-compatible"
        ? ["/chat/completions", "/models"]
        : ["/messages", "/models"];
    if (!allowedPaths.includes(path)) {
      throw new Error(`Unsupported ${service} API path`);
    }
    const safeHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter(
        ([name]) =>
          ![
            "authorization",
            "x-api-key",
            "anthropic-version",
            "anthropic-dangerous-direct-browser-access",
          ].includes(name.toLowerCase()),
      ),
    );
    const authHeaders: Record<string, string> = {};
    if (service === "openai-compatible") {
      if (key) authHeaders.Authorization = `Bearer ${key}`;
    } else {
      authHeaders["anthropic-version"] = "2023-06-01";
      if (key) {
        authHeaders["x-api-key"] = key;
        authHeaders.Authorization = `Bearer ${key}`;
      }
    }
    return {
      url: `${normalizeCompatibleBaseUrl(options.baseUrl)}${path}`,
      method: options.method ?? "GET",
      headers: {
        ...safeHeaders,
        ...authHeaders,
      },
      body: options.body,
    };
  }

  if (service === "cloudflare") {
    // Server-side relay for the web client's same-origin /api/llm path:
    // credentials come from the main-process env/.dev.vars (see
    // resolveCloudflareCredentials), never from the renderer or the keychain.
    const creds = resolveCloudflareCredentials();
    if (!creds) {
      throw new Error(
        "Cloudflare credentials not configured (set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID or .dev.vars)",
      );
    }
    const allowedPaths = ["/v1/chat/completions", "/v1/models"];
    if (!allowedPaths.includes(path)) {
      throw new Error(`Unsupported Cloudflare API path: ${path}`);
    }
    const safeHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter(
        ([name]) => !["authorization"].includes(name.toLowerCase()),
      ),
    );
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai${path}`,
      method: options.method ?? "GET",
      headers: { ...safeHeaders, Authorization: `Bearer ${creds.apiToken}` },
      body: options.body,
    };
  }

  const cfg = DIRECT_CONFIG[service];
  return {
    url: `${cfg.baseUrl}${path}`,
    method: options.method ?? "GET",
    // auth headers win over any renderer-supplied header of the same name
    headers: { ...(options.headers ?? {}), ...cfg.authHeaders(key) },
    body: options.body,
  };
}

export interface CloudFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export async function cloudFetch(args: {
  service: CloudService;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  baseUrl?: string;
}): Promise<CloudFetchResult> {
  // "cloudflare" uses main-process credentials (env/.dev.vars), not a
  // keychain entry — resolveCloudflareCredentials() is called inside
  // buildUpstreamRequest and throws a descriptive error when unset.
  const key =
    args.service === "cloudflare"
      ? ""
      : (await getKeyStore().get(args.service)) ?? "";
  if (!key && !args.service.endsWith("-compatible") && args.service !== "cloudflare") {
    return {
      status: 401,
      statusText: `No API key stored for ${args.service}`,
      headers: {},
      body: new ArrayBuffer(0),
    };
  }
  let req;
  try {
    req = buildUpstreamRequest(args.service, args.path, key, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 503,
      statusText: `Cloudflare relay unavailable: ${message}`,
      headers: { "Content-Type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ error: { code: "GATEWAY_NOT_CONFIGURED", message } })).buffer,
    };
  }
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const body = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: res.status, statusText: res.statusText, headers, body };
}
