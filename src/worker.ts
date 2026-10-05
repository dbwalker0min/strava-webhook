import { publicPage } from "./pages.js";
import { createCalendarPayload, type StravaActivity } from "./calendar.js";
import { handleGoogleOAuth, insertCalendarEvent } from "./google.js";
import { getStravaAccessToken } from "./strava.js";
import type { Env, WebhookEvent } from "./types.js";

export async function processActivity(event: WebhookEvent, env: Env): Promise<void> {
  const accessToken = await getStravaAccessToken(env);
  const response = await fetch(`https://www.strava.com/api/v3/activities/${event.object_id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Strava activity request failed: ${response.status}`);
  const activity = await response.json<StravaActivity>();
  if (activity.id !== event.object_id) throw new Error("Strava activity ID mismatch");
  const payload = createCalendarPayload(activity);
  if (!payload) {
    console.log(`Skipping weight training activity ${activity.id}`);
    return;
  }
  await insertCalendarEvent(payload, env);
  console.log(`Calendar delivery complete for activity ${activity.id}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const page = publicPage(request);
    if (page) return page;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/oauth/google/")) return handleGoogleOAuth(request, env);
    if (request.method === "GET") {
      const challenge = url.searchParams.get("hub.challenge");
      if (url.searchParams.get("hub.mode") === "subscribe" && challenge &&
          env.STRAVA_VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === env.STRAVA_VERIFY_TOKEN) {
        return Response.json({ "hub.challenge": challenge });
      }
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let event: WebhookEvent;
    try {
      event = await request.json<WebhookEvent>();
      if (!event || typeof event !== "object" || typeof event.object_type !== "string" ||
          typeof event.aspect_type !== "string" || !Number.isSafeInteger(event.object_id) || event.object_id <= 0) {
        return new Response("Invalid event", { status: 400 });
      }
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!env.STRAVA_SUBSCRIPTION_ID) return new Response("Subscription not configured", { status: 503 });
    if (String(event.subscription_id) !== env.STRAVA_SUBSCRIPTION_ID ||
        event.object_type !== "activity" || event.aspect_type !== "create") return new Response("OK");
    try {
      // Acknowledge only once the job has been durably accepted.
      await env.ACTIVITY_QUEUE.send(event);
      return new Response("OK");
    } catch {
      console.error("Unable to enqueue Strava activity");
      return new Response("Please retry", { status: 503 });
    }
  },

  async queue(batch: MessageBatch<WebhookEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processActivity(message.body, env);
        message.ack();
      } catch (error) {
        console.error(`Activity ${message.body.object_id} attempt ${message.attempts} failed: ${error instanceof Error ? error.message : "Unexpected failure"}`);
        message.retry({ delaySeconds: Math.min(60 * 2 ** (message.attempts - 1), 3600) });
      }
    }
  },
};
