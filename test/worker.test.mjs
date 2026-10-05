import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { processActivity } from '../dist/worker.js';
import { insertCalendarEvent, handleGoogleOAuth } from '../dist/google.js';
import { createCalendarPayload, duration } from '../dist/calendar.js';

const activity = {
  id: 20066459982, name: '🚲 Alviso', sport_type: 'Ride',
  start_date: '2026-09-20T16:00:00Z', distance: 21.9 * 1609.344,
  total_elevation_gain: 440 / 3.28084, moving_time: 104 * 60, elapsed_time: 165 * 60,
};
const event = { object_type: 'activity', aspect_type: 'create', object_id: activity.id, subscription_id: 123 };

test('formats the Alviso example and preserves calendar times and existing fields', () => {
  const payload = createCalendarPayload(activity);
  assert.equal(payload.title, '🚲 21.9 mi · 440 ft');
  assert.equal(payload.description, 'Alviso\nRide\nMoving: 1:44\nElapsed: 2:45\n\nStrava: https://www.strava.com/activities/20066459982');
  assert.equal(payload.start, '2026-09-20T16:00:00.000Z');
  assert.equal(payload.end, '2026-09-20T18:45:00.000Z');
  assert.equal(payload.distance_miles, 21.9);
  assert.equal(payload.moving_minutes, 104);
});

test('matches rounding, duration boundaries, and thousands separators', () => {
  for (const [minutes, expected] of [[0, '0 min'], [59, '59 min'], [60, '1:00'], [65, '1:05'], [1500, '25:00']]) {
    assert.equal(duration(minutes), expected);
  }
  const payload = createCalendarPayload({ ...activity, distance: 0, moving_time: 3570, total_elevation_gain: 1234 / 3.28084 });
  assert.equal(payload.title, '🚲 0.0 mi · 1,234 ft');
  assert.match(payload.description, /Moving: 1:00/);
});

test('handles API and display sport names, and falls back for unknown sports', () => {
  for (const [sport, emoji] of [['EBikeRide', 'e🚲'], ['E-Bike Ride', 'e🚲'], ['Walk', '🚶'], ['Hike', '🥾'], ['Run', '❓']]) {
    const payload = createCalendarPayload({ ...activity, sport_type: sport });
    assert.ok(payload.title.startsWith(`${emoji} `));
    assert.equal(payload.sport_type, sport);
    if (sport === 'EBikeRide') assert.match(payload.description, /\nE-Bike Ride\n/);
  }
  for (const sport of ['WeightTraining', 'Weight Training']) {
    assert.equal(createCalendarPayload({ ...activity, sport_type: sport }), null);
  }
});

function environment(tokens) {
  const data = new Map([
    ['oauth', tokens ?? { access_token: 'strava-access', expires_at: Date.now() / 1000 + 7200 }],
    ['google:oauth', { refresh_token: 'google-refresh' }],
  ]);
  return {
    STRAVA_VERIFY_TOKEN: 'test-verify', STRAVA_CLIENT_ID: 'test-client',
    STRAVA_CLIENT_SECRET: 'test-secret', STRAVA_SUBSCRIPTION_ID: '123',
    GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_CALENDAR_ID: 'workouts@group.calendar.google.com',
    GOOGLE_REDIRECT_URI: 'https://example.test/oauth/google/callback',
    GOOGLE_SETUP_PASSWORD: 'long-random-test-password',
    ACTIVITY_QUEUE: { async send() { assert.fail('Unexpected enqueue'); } },
    STRAVA_TOKENS: {
      async get(key) { return data.get(key); },
      async put(key, value) { data.set(key, JSON.parse(value)); },
    },
  };
}
const postEvent = (value = event) => new Request('https://example.test/', { method: 'POST', body: JSON.stringify(value) });

// Unexpected network calls always fail tests instead of reaching real services.
function mockDelivery(t, sport = 'Ride', calendarStatus = 200) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://www.strava.com/api/v3/activities/')) return Response.json({ ...activity, sport_type: sport });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'google-access' });
    if (url.startsWith('https://www.googleapis.com/calendar/v3/')) return new Response('{}', { status: calendarStatus });
    throw new Error(`Unexpected URL: ${url}`);
  });
  return calls;
}

test('verifies subscriptions and ignores invalid or irrelevant webhook events', async () => {
  const valid = new Request('https://example.test/?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=test-verify');
  assert.deepEqual(await (await worker.fetch(valid, environment())).json(), { 'hub.challenge': 'abc' });
  assert.equal((await worker.fetch(new Request('https://example.test/'), environment())).status, 403);
  for (const [body, status] of [['invalid', 400], ['null', 400], [JSON.stringify({ ...event, object_id: -1 }), 400], [JSON.stringify({ ...event, subscription_id: 999 }), 200], [JSON.stringify({ ...event, aspect_type: 'update' }), 200], [JSON.stringify({ ...event, aspect_type: 'delete' }), 200]]) {
    assert.equal((await worker.fetch(new Request('https://example.test/', { method: 'POST', body }), environment())).status, status);
  }
});

test('acknowledges only after queue acceptance and returns 503 on enqueue failure', async () => {
  const env = environment();
  let accepted = false;
  env.ACTIVITY_QUEUE.send = async (body) => { assert.deepEqual(body, event); accepted = true; };
  assert.equal((await worker.fetch(postEvent(), env)).status, 200);
  assert.ok(accepted);
  env.ACTIVITY_QUEUE.send = async () => { throw new Error('queue unavailable'); };
  assert.equal((await worker.fetch(postEvent(), env)).status, 503);
});

test('sends calendar-ready events directly to Google', async (t) => {
  const calls = mockDelivery(t);
  await processActivity(event, environment());
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.body.get('refresh_token'), 'google-refresh');
  assert.ok(calls[2].url.includes('workouts%40group.calendar.google.com'));
  assert.equal(calls[2].init.headers.Authorization, 'Bearer google-access');
  const body = JSON.parse(calls[2].init.body);
  assert.equal(body.id, 'strava20066459982');
  assert.equal(body.summary, '🚲 21.9 mi · 440 ft');
  assert.equal(body.start.dateTime, '2026-09-20T16:00:00.000Z');
  assert.equal(body.end.dateTime, '2026-09-20T18:45:00.000Z');
  assert.equal(body.extendedProperties.private.stravaActivityId, String(activity.id));
});

test('weight training makes no Google requests', async (t) => {
  for (const sport of ['WeightTraining', 'Weight Training']) {
    const calls = mockDelivery(t, sport);
    await processActivity(event, environment());
    assert.equal(calls.length, 1);
    t.mock.restoreAll();
  }
});

test('retries failed delivery with backoff and acknowledges successful deliveries', async (t) => {
  for (const status of [429, 503, 403, 200]) {
    mockDelivery(t, 'Ride', status);
    let acked = false, delay;
    await worker.queue({ messages: [{ body: event, attempts: 3, ack() { acked = true; }, retry(options) { delay = options.delaySeconds; } }] }, environment());
    assert.equal(acked, status === 200);
    assert.equal(delay, status === 200 ? undefined : 240);
    t.mock.restoreAll();
  }
});

test('duplicate event insertion is successful only when the existing event matches', async (t) => {
  for (const match of [true, false]) {
    let inserted;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access' });
      if (init.method === 'POST') { inserted = JSON.parse(init.body); return new Response('', { status: 409 }); }
      assert.ok(url.endsWith('/strava20066459982'));
      return Response.json({ extendedProperties: { private: { stravaActivityId: match ? String(activity.id) : 'other' } } });
    });
    const promise = insertCalendarEvent(createCalendarPayload(activity), environment());
    if (match) await promise;
    else await assert.rejects(promise, /conflict/);
    assert.equal(inserted.id, 'strava20066459982');
    t.mock.restoreAll();
  }
});

test('persists refreshed Strava OAuth tokens before fetching activity', async (t) => {
  const env = environment({ access_token: 'expired', refresh_token: 'old-refresh', expires_at: 0 });
  const refreshed = { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 9999999999 };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/oauth/token')) return Response.json(refreshed);
    assert.deepEqual(await env.STRAVA_TOKENS.get('oauth'), refreshed);
    assert.equal(init.headers.Authorization, 'Bearer new-access');
    return Response.json({ ...activity, sport_type: 'WeightTraining' });
  });
  await processActivity(event, env);
  assert.deepEqual(await env.STRAVA_TOKENS.get('oauth'), refreshed);
});

async function start(env, password = env.GOOGLE_SETUP_PASSWORD, origin = 'https://example.test') {
  return handleGoogleOAuth(new Request('https://example.test/oauth/google/start', {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ password }),
  }), env);
}
function callback(state, cookie, query = 'code=authorization-code') {
  return new Request(`https://example.test/oauth/google/callback?state=${encodeURIComponent(state)}&${query}`, { headers: { Cookie: cookie } });
}

test('OAuth start requires secrets, correct password, and same-origin submission', async () => {
  const env = environment();
  assert.equal((await start(env, 'wrong')).status, 403);
  assert.equal((await start(env, env.GOOGLE_SETUP_PASSWORD, 'https://attacker.test')).status, 403);
  assert.equal((await start({ ...env, GOOGLE_CLIENT_SECRET: '' })).status, 503);
  const response = await start(env);
  assert.equal(response.status, 303);
  const auth = new URL(response.headers.get('Location'));
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.searchParams.get('redirect_uri'), env.GOOGLE_REDIRECT_URI);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('OAuth rejects missing, tampered, expired, or cross-browser state before token exchange', async (t) => {
  const env = environment();
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Must not exchange code'); });
  const response = await start(env);
  const state = new URL(response.headers.get('Location')).searchParams.get('state');
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  for (const [value, browserCookie] of [['', cookie], [state, ''], [state + 'a', cookie], [state + 'a', '__Host-google-oauth=' + state + 'a']]) {
    assert.equal((await handleGoogleOAuth(callback(value, browserCookie), env)).status, 400);
  }
  t.mock.method(Date, 'now', () => Number(state.split('.')[1]) + 601000);
  assert.equal((await handleGoogleOAuth(callback(state, cookie), env)).status, 400);
});

test('OAuth callback stores only refresh token separately from Strava and clears cookie', async (t) => {
  const env = environment();
  const response = await start(env);
  const state = new URL(response.headers.get('Location')).searchParams.get('state');
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.body.get('code'), 'authorization-code');
    assert.equal(init.body.get('redirect_uri'), env.GOOGLE_REDIRECT_URI);
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', scope: 'https://www.googleapis.com/auth/calendar.events' });
  });
  const result = await handleGoogleOAuth(callback(state, cookie), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.deepEqual(await env.STRAVA_TOKENS.get('google:oauth'), { refresh_token: 'new-refresh' });
  assert.equal((await env.STRAVA_TOKENS.get('oauth')).access_token, 'strava-access');
  assert.doesNotMatch(await result.text(), /new-refresh|new-access/);
});

test('OAuth denial or missing permission/refresh token never replaces working credentials', async (t) => {
  const env = environment();
  const response = await start(env);
  const state = new URL(response.headers.get('Location')).searchParams.get('state');
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await handleGoogleOAuth(callback(state, cookie, 'error=access_denied'), env)).status, 400);
  for (const tokens of [{ access_token: 'access' }, { access_token: 'access', refresh_token: 'new', scope: 'openid' }]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(tokens));
    assert.equal((await handleGoogleOAuth(callback(state, cookie), env)).status, 502);
    assert.deepEqual(await env.STRAVA_TOKENS.get('google:oauth'), { refresh_token: 'google-refresh' });
    t.mock.restoreAll();
  }
});

test('unconnected Google and upstream failures propagate so jobs are retried', async (t) => {
  const env = environment();
  await env.STRAVA_TOKENS.put('google:oauth', '{}');
  await assert.rejects(insertCalendarEvent(createCalendarPayload(activity), env), /not connected/);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(processActivity(event, environment()), /Strava activity request failed: 503/);
  await assert.rejects(insertCalendarEvent(createCalendarPayload(activity), environment()), /Google token request failed: 503/);
});


test('sign-in form preserves same-origin POST metadata while callback responses suppress referrers', async () => {
  const env = environment();
  const form = await handleGoogleOAuth(new Request('https://example.test/oauth/google/start'), env);
  assert.equal(form.status, 200);
  assert.equal(form.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal(form.headers.get('Cache-Control'), 'no-store');
  const nullOrigin = await start(env, env.GOOGLE_SETUP_PASSWORD, 'null');
  assert.equal(nullOrigin.status, 403);
  assert.match(await nullOrigin.text(), /origin could not be verified/);
  const wrongPassword = await start(env, 'wrong');
  assert.equal(wrongPassword.status, 403);
  assert.match(await wrongPassword.text(), /Incorrect setup password/);
  const authorized = await start(env);
  assert.equal(authorized.status, 303);
  assert.equal(authorized.headers.get('Referrer-Policy'), 'no-referrer');
  const invalidCallback = await handleGoogleOAuth(callback('', ''), env);
  assert.equal(invalidCallback.headers.get('Referrer-Policy'), 'no-referrer');
});
