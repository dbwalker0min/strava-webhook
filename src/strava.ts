import type { Env, OAuthTokens } from "./types.js";

export async function getStravaAccessToken(env: Env): Promise<string> {
  const tokens = await env.STRAVA_TOKENS.get<OAuthTokens>("oauth", {
    type: "json",
  });

  if (!tokens) {
    throw new Error("No Strava OAuth tokens found in KV");
  }

  const now = Math.floor(Date.now() / 1000);

  //
  // Refresh if token expires within one hour.
  //
  if (tokens.expires_at > now + 3600) {
    console.log("Using existing Strava access token");
    return tokens.access_token;
  }

  console.log("Refreshing Strava access token");

  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });

  const response = await fetch(
    "https://www.strava.com/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!response.ok) {


    console.error("Strava token refresh HTTP status:", response.status);


    throw new Error(`Strava token refresh failed: ${response.status}`);
  }
  
  const refreshed = await response.json<OAuthTokens>();

  const newTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expires_at: refreshed.expires_at,
  };

  //
  // IMPORTANT: persist the newest refresh token.
  //
  await env.STRAVA_TOKENS.put(
    "oauth",
    JSON.stringify(newTokens)
  );

  console.log(
    `Strava token refreshed; expires_at=${newTokens.expires_at}`
  );

  return newTokens.access_token;
}
