# Strava → Google Calendar

A TypeScript Cloudflare Worker that receives Strava webhooks, queues new
activities, filters out weight training, and writes formatted events directly to
Google Calendar. Zapier is no longer used by this version.

## Finish setup

The Worker URL, OAuth client ID, calendar ID, existing Strava settings, and KV
binding are configured in `wrangler.jsonc`. In Google Cloud, enable the Calendar
API and configure the OAuth web client with this exact authorized redirect URI:

```
https://strava-webhook.dbwalker0min.workers.dev/oauth/google/callback
```

Request the `https://www.googleapis.com/auth/calendar.events` scope. Move the
OAuth consent app out of Testing before connecting for ongoing use; Calendar
refresh tokens issued in Testing expire after seven days. Sign in using the
Google account with write access to the configured calendar.

From this project directory, enter the two secrets at Wrangler's hidden prompts:

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_SETUP_PASSWORD
```

The first is the client secret from Google Cloud. The second is a new, random
password (at least 32 characters, saved in your password manager). This password
protects the setup page; it is not your Google account password. Do not commit
secrets or paste them into chat. Existing `STRAVA_VERIFY_TOKEN` and
`STRAVA_CLIENT_SECRET` secrets must remain configured.

Create the queues once (skip a creation if that queue already exists):

```sh
npx wrangler queues create strava-calendar-activities
npx wrangler queues create strava-calendar-failed
npm test
npm run deploy
```

Deploying replaces the existing Worker and removes the Zapier handoff. Soon after
deploying, open:

https://strava-webhook.dbwalker0min.workers.dev/oauth/google/start

Enter your setup password and complete Google sign-in. The callback stores a
refresh token under `google:oauth` in the existing KV namespace; Strava's `oauth`
key is unchanged. A successful connection confirms authorization, not delivery
of a calendar event. Create/upload a new eligible activity and confirm it appears
in Google Calendar. Use `npx wrangler tail` to inspect delivery errors.

Until authorization finishes, eligible activities queue and retry. Complete
sign-in promptly, within the retry/retention window. Once direct delivery is
confirmed, disable the old Zap. This change does not backfill old workouts or
remove events previously created by Zapier.

## Development

Requires Node.js 22 or newer and npm.

```sh
npm install
npm run build       # TypeScript → JavaScript in dist/
npm test            # Compile and run tests on the JavaScript; external calls mocked
npm run typecheck
npm run dev         # Local Worker and queue simulation
npx wrangler types --include-runtime false
```

- `src/calendar.ts`: pure filtering, conversions, title and description formatting.
- `src/worker.ts`: webhook validation, enqueueing, and queue processing.
- `src/strava.ts`: Strava token refresh.
- `src/google.ts`: protected Google authorization, refresh, and Calendar API calls.
- `src/types.ts`: application binding and data types.
- `worker-configuration.d.ts`: Wrangler-generated binding reference.

Generated JavaScript is ignored by Git. Wrangler bundles the TypeScript entry
point directly for local development and deployment. Tests need no credentials;
live local API testing needs an ignored `.dev.vars` file and local KV data.
The OAuth flow uses secure cookies and the configured HTTPS origin, so normal
localhost HTTP development is not intended for live Google sign-in.

## Behavior

WeightTraining and Weight Training are discarded before Google is contacted.
Emoji mappings are Ride 🚲, EBikeRide / E-Bike Ride e🚲, Walk 🚶, Hike 🥾,
with ❓ for other sports. A leading emoji is removed from the activity name.

Example event:

```
🚲 21.9 mi · 440 ft

Alviso
Ride
Moving: 1:44
Elapsed: 2:45

Strava: https://www.strava.com/activities/20066459982
```

Distance, elevation, and minute rounding follow the original Worker. Calendar
start/end use UTC ISO timestamps and exact elapsed seconds. Only newly created
activities are processed; edits and deletions are ignored.

Webhook acknowledgements wait for durable queue acceptance. Failures receive
up to ten retries with exponential delays from one minute to one hour. Final
failures go to `strava-calendar-failed` for inspection/manual recovery. This is
not indefinite storage: the Workers Free plan retains queue messages for 24
hours. Check the queue dashboard and logs if an activity does not appear. There
are no automatic failure notifications in this version. After correcting a
problem, copy the failed webhook JSON into the main queue through Cloudflare's
queue dashboard before retention expires, then acknowledge/remove the failed
copy. If it has expired, recovery requires the original Strava activity ID and
an equivalent create-event message.

Calendar event IDs are derived from Strava activity IDs (`strava20066459982`).
Retried inserts get a conflict response and verify the existing event's stored
Strava ID before treating delivery as complete. This covers retries of events
created by this Worker; it does not deduplicate against old Zapier-created events.

OAuth start requires a setup password and a same-origin form submission. Callback
state is signed, expires after ten minutes, and must match a secure HttpOnly
browser cookie. Tokens are never returned to the browser or written to logs.
Query strings are redacted from Worker observability because OAuth callbacks
contain authorization codes. Keep the setup password to reconnect if Google
access is revoked.

## References and costs

- [Calendar event creation](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Google OAuth server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queue limits and retention](https://developers.cloudflare.com/queues/platform/limits/)

Queues are available on Workers Free with an included daily allowance. Personal
workout volume should fit comfortably, subject to other account usage. No paid
plan has been enabled by these local code changes.
