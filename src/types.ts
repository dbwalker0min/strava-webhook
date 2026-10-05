export interface Env {
  STRAVA_VERIFY_TOKEN: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_SUBSCRIPTION_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_REDIRECT_URI: string;
  GOOGLE_SETUP_PASSWORD: string;
  ACTIVITY_QUEUE: Queue<WebhookEvent>;
  STRAVA_TOKENS: KVNamespace;
}

export interface WebhookEvent {
  object_id: number;
  object_type: string;
  aspect_type: string;
  subscription_id: number;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
