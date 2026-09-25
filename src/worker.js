export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    //
    // Strava webhook verification
    //
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const challenge = url.searchParams.get("hub.challenge");
      const verifyToken = url.searchParams.get("hub.verify_token");

      if (
        mode === "subscribe" &&
        challenge &&
        verifyToken === env.STRAVA_VERIFY_TOKEN
      ) {
        return Response.json({
          "hub.challenge": challenge,
        });
      }

      return new Response("Forbidden", { status: 403 });
    }

    //
    // Strava webhook event
    //
    if (request.method === "POST") {
      let event;

      try {
        event = await request.json();
      } catch {
        console.log("Invalid JSON received");
        return new Response("Invalid JSON", { status: 400 });
      }

      console.log("Webhook event:", JSON.stringify(event));

      if (
        env.STRAVA_SUBSCRIPTION_ID &&
        String(event.subscription_id) !== env.STRAVA_SUBSCRIPTION_ID
      ) {
        console.log(
          `Ignoring subscription ${event.subscription_id}; expected ${env.STRAVA_SUBSCRIPTION_ID}`
        );
        return new Response("OK", { status: 200 });
      }

      //
      // Only fetch full details for newly-created activities.
      //
      if (
        event.object_type === "activity" &&
        event.aspect_type === "create"
      ) {
        ctx.waitUntil(processActivity(event, env));
      } else {
        console.log(
          `Ignoring ${event.object_type}/${event.aspect_type} event`
        );
      }

      //
      // Respond immediately so Strava doesn't retry.
      //
      return new Response("OK", { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};


function stripLeadingEmoji(name) {
  return name.replace(
    /^\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*\s*/u,
    ""
  );
}


async function processActivity(event, env) {
  try {
    const accessToken = await getAccessToken(env);

    console.log(`Fetching Strava activity ${event.object_id}`);

    const response = await fetch(
      `https://www.strava.com/api/v3/activities/${event.object_id}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      console.error(
        `Strava activity request failed: ${response.status} ${await response.text()}`
      );
      return;
    }

    const activity = await response.json();

    console.log(
      `Fetched activity ${activity.id}: ${activity.name}`
    );

    //
    // Include the webhook metadata as well as the activity.
    //
    const start = new Date(activity.start_date);
    const end = new Date(
      start.getTime() + activity.elapsed_time * 1000
    );

    const distanceMiles = activity.distance / 1609.344;
    const elevationFeet = activity.total_elevation_gain * 3.28084;

    const payload = {
      id: activity.id,
      name: stripLeadingEmoji(activity.name),
      sport_type: activity.sport_type,

      start: start.toISOString(),
      end: end.toISOString(),

      distance_miles: Number(distanceMiles.toFixed(1)),
      elevation_feet: Math.round(elevationFeet),

      moving_minutes: Math.round(activity.moving_time / 60),
      elapsed_minutes: Math.round(activity.elapsed_time / 60),

      strava_url: `https://www.strava.com/activities/${activity.id}`,
    };

    const zapierResponse = await fetch(env.ZAPIER_HOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(`Zapier response: ${zapierResponse.status}`);

    if (!zapierResponse.ok) {
      console.error(
        `Zapier error: ${await zapierResponse.text()}`
      );
    }
  } catch (error) {
    console.error(
      `Activity processing failed: ${error?.message ?? String(error)}`
    );

    if (error?.stack) {
      console.error(error.stack);
    }
  }
}


async function getAccessToken(env) {
  const tokens = await env.STRAVA_TOKENS.get("oauth", {
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
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();

    console.error("Strava token refresh HTTP status:", response.status);
    console.error("Strava token refresh response:", errorBody);

    throw new Error(`Strava token refresh failed: ${response.status}`);
  }
  
  const refreshed = await response.json();

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