import type { createCalendarPayload } from "./calendar.js";
import type { Env } from "./types.js";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const COOKIE = "__Host-google-oauth";
const encoder = new TextEncoder();
interface GoogleTokens { access_token: string; refresh_token?: string; scope?: string }

async function tokenRequest(body: URLSearchParams): Promise<GoogleTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST", body, signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!response.ok) throw new Error(`Google token request failed: ${response.status}; check credentials or reconnect Google`);
  const tokens = await response.json<GoogleTokens>();
  if (!tokens.access_token) throw new Error("Google did not return an access token");
  return tokens;
}

function credentials(env: Env): Record<string, string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google credentials are missing");
  return { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET };
}

export async function insertCalendarEvent(payload: NonNullable<ReturnType<typeof createCalendarPayload>>, env: Env): Promise<void> {
  const stored = await env.STRAVA_TOKENS.get<{ refresh_token: string }>("google:oauth", "json");
  if (!stored?.refresh_token) throw new Error("Google is not connected; open /oauth/google/start");
  const tokens = await tokenRequest(new URLSearchParams({
    ...credentials(env), grant_type: "refresh_token", refresh_token: stored.refresh_token,
  }));
  if (tokens.refresh_token && tokens.refresh_token !== stored.refresh_token) {
    await env.STRAVA_TOKENS.put("google:oauth", JSON.stringify({ refresh_token: tokens.refresh_token }));
  }
  // 'strava' and decimal digits are all valid base32hex characters for Google IDs.
  const id = `strava${payload.id}`;
  const endpoint = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;
  const response = await fetch(`${endpoint}?sendUpdates=none`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id, summary: payload.title, description: payload.description,
      start: { dateTime: payload.start }, end: { dateTime: payload.end },
      extendedProperties: { private: { stravaActivityId: String(payload.id) } },
    }),
  });
  if (response.ok) return;
  if (response.status === 409) {
    const existing = await fetch(`${endpoint}/${id}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000),
    });
    if (existing.ok) {
      const event = await existing.json<{ extendedProperties?: { private?: { stravaActivityId?: string } } }>();
      if (event.extendedProperties?.private?.stravaActivityId === String(payload.id)) return;
    }
    throw new Error("Calendar event ID conflict could not be verified");
  }
  throw new Error(`Google Calendar insert failed: ${response.status}`);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(value: string, secret: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(value)));
}

async function validState(state: string, secret: string): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, timestamp, signature] = parts as [string, string, string];
  if (!/^[a-f0-9]{64}$/.test(nonce) || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const age = Date.now() - Number(timestamp);
  if (age < 0 || age > 10 * 60 * 1000) return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, (value) => parseInt(value, 16));
  return crypto.subtle.verify("HMAC", await signingKey(secret), bytes, encoder.encode(`${nonce}.${timestamp}`));
}

function reply(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  } });
}

export async function handleGoogleOAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clearCookie = { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` };
  if (!["/oauth/google/start", "/oauth/google/callback"].includes(url.pathname)) return reply("Not found", 404);
  if (!env.GOOGLE_SETUP_PASSWORD || !env.GOOGLE_CLIENT_SECRET) return reply("Google setup secrets are missing", 503);
  if (url.origin !== new URL(env.GOOGLE_REDIRECT_URI).origin) return reply("Use the configured Worker URL", 400);

  if (url.pathname === "/oauth/google/start") {
    if (request.method === "GET") return reply(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Google Calendar</title><h1>Connect Google Calendar</h1><p><a href="/about">About this app</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a></p><p>Enter your Worker setup password, then sign in with the Google account that can edit your workout calendar.</p><form method="post"><label>Setup password <input type="password" name="password" required autocomplete="current-password"></label><button>Connect Google Calendar</button></form></html>`, 200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "same-origin" });
    if (request.method !== "POST") return reply("Method not allowed", 405);
    if (request.headers.get("Origin") !== url.origin) return reply("Form origin could not be verified. Reopen /oauth/google/start and try again.", 403);
    let password: unknown;
    try { password = (await request.formData()).get("password"); } catch { return reply("Invalid form", 400); }
    // Hash before comparing so the comparison cannot reveal the password prefix.
    if (typeof password !== "string" ||
        await sign(password, env.GOOGLE_SETUP_PASSWORD) !== await sign(env.GOOGLE_SETUP_PASSWORD, env.GOOGLE_SETUP_PASSWORD)) return reply("Incorrect setup password. Use the value saved as GOOGLE_SETUP_PASSWORD, not your Google account password.", 403);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const value = `${nonce}.${Date.now()}`;
    const state = `${value}.${await sign(value, env.GOOGLE_SETUP_PASSWORD)}`;
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.GOOGLE_REDIRECT_URI,
      response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state }).toString();
    return reply("Redirecting to Google", 303, {
      Location: auth.toString(),
      "Set-Cookie": `${COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    });
  }

  if (request.method !== "GET") return reply("Method not allowed", 405);
  const state = url.searchParams.get("state") ?? "";
  const cookie = request.headers.get("Cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!state || state !== cookie || !await validState(state, env.GOOGLE_SETUP_PASSWORD)) return reply("Invalid or expired sign-in. Start again at /oauth/google/start.", 400, clearCookie);
  if (url.searchParams.has("error")) return reply("Google authorization was declined. Start again when ready.", 400, clearCookie);
  const code = url.searchParams.get("code");
  if (!code) return reply("Google did not return an authorization code", 400, clearCookie);
  try {
    const tokens = await tokenRequest(new URLSearchParams({ ...credentials(env), code, grant_type: "authorization_code", redirect_uri: env.GOOGLE_REDIRECT_URI }));
    if (!tokens.refresh_token) throw new Error("No refresh token; retry authorization and grant offline access");
    if (!tokens.scope?.split(" ").includes(SCOPE)) throw new Error("Calendar events permission was not granted");
    await env.STRAVA_TOKENS.put("google:oauth", JSON.stringify({ refresh_token: tokens.refresh_token }));
    return reply("Google Calendar connected. Future eligible Strava activities will be sent directly to your configured calendar. You can close this tab.", 200, clearCookie);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Google authorization failed");
    return reply("Google connection failed. Check the Worker logs, then start again at /oauth/google/start.", 502, clearCookie);
  }
}
