import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";

const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const REFRESH_URL = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// Google requires a client secret to exchange a refresh token. Never embed one
// from the Antigravity client in a distributable plugin.
const CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
const USER_AGENT = "Antigravity/1.2.11";

interface StoredToken {
  token?: { access_token?: string; refresh_token?: string };
  id_token?: string;
}

interface QuotaBucket {
  remainingFraction?: number;
  resetTime?: string;
}

interface QuotaGroup {
  displayName?: string;
  buckets?: QuotaBucket[];
}

export interface QuotaSummary { groups?: QuotaGroup[] }

function error(message: string): ProviderUsageResult {
  return { supported: true, usage: { status: "error", message, accountEmail: null, planLabel: null } };
}

function accountEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export function normalizeAntigravityUsage(summary: QuotaSummary, email: string | null): ProviderUsageResult {
  const windows = (summary.groups ?? []).flatMap((group) => {
    const name = group.displayName ?? "";
    const label = /gemini/iu.test(name)
      ? "Weekly limit (Gemini)"
      : /claude|gpt/iu.test(name)
        ? "Weekly limit (Claude & GPT)"
        : name ? `Weekly limit (${name})` : "Weekly limit";
    return (group.buckets ?? []).map((bucket) => {
      const remaining = Number.isFinite(bucket.remainingFraction) ? bucket.remainingFraction! : 1;
      return {
        label,
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - remaining) * 100))),
        resetsAt: typeof bucket.resetTime === "string" ? bucket.resetTime : null,
      };
    });
  });
  if (windows.length === 0) return error("Antigravity returned no quota windows.");
  return { supported: true, usage: { status: "ok", accountEmail: email, planLabel: "Antigravity", windows } };
}

async function requestQuota(accessToken: string, fetcher: typeof fetch): Promise<Response> {
  return fetcher(QUOTA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ project: "aicode-consumers" }),
  });
}

async function refreshedAccessToken(refreshToken: string, fetcher: typeof fetch): Promise<string | null> {
  if (!CLIENT_SECRET) return null;
  const response = await fetcher(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) return null;
  const body = await response.json() as { access_token?: unknown };
  return typeof body.access_token === "string" ? body.access_token : null;
}

export async function readAntigravityUsage(options: {
  tokenPath?: string;
  fetcher?: typeof fetch;
} = {}): Promise<ProviderUsageResult> {
  const tokenPath = options.tokenPath ?? join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const fetcher = options.fetcher ?? fetch;
  let stored: StoredToken;
  try {
    stored = JSON.parse(await readFile(tokenPath, "utf8")) as StoredToken;
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
    return code === "ENOENT"
      ? { supported: true, usage: { status: "unauthenticated" } }
      : error("Could not read the Antigravity authentication token.");
  }

  const accessToken = stored.token?.access_token;
  if (!accessToken) return { supported: true, usage: { status: "unauthenticated" } };
  try {
    let response = await requestQuota(accessToken, fetcher);
    if (response.status === 401 && stored.token?.refresh_token) {
      const refreshed = await refreshedAccessToken(stored.token.refresh_token, fetcher);
      if (!refreshed) return { supported: true, usage: { status: "expired" } };
      response = await requestQuota(refreshed, fetcher);
    }
    if (response.status === 401 || response.status === 403) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!response.ok) return error(`Antigravity quota request failed (HTTP ${response.status}).`);
    return normalizeAntigravityUsage(await response.json() as QuotaSummary, accountEmail(stored.id_token));
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
}
