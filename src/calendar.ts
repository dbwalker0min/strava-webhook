export interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  distance: number;
  total_elevation_gain: number;
  moving_time: number;
  elapsed_time: number;
}

const sports: Record<string, { label: string; emoji: string }> = {
  Ride: { label: "Ride", emoji: "🚲" },
  EBikeRide: { label: "E-Bike Ride", emoji: "e🚲" },
  "E-Bike Ride": { label: "E-Bike Ride", emoji: "e🚲" },
  Walk: { label: "Walk", emoji: "🚶" },
  Hike: { label: "Hike", emoji: "🥾" },
};

export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours ? `${hours}:${String(mins).padStart(2, "0")}` : `${mins} min`;
}

function stripLeadingEmoji(name: string): string {
  return name.replace(
    /^\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*\s*/u,
    "",
  );
}

/** Returns null for activities that must never reach the calendar handoff. */
export function createCalendarPayload(activity: StravaActivity) {
  if (["WeightTraining", "Weight Training"].includes(activity.sport_type)) {
    return null;
  }

  const sport = sports[activity.sport_type] ?? { label: activity.sport_type, emoji: "❓" };
  const start = new Date(activity.start_date);
  const end = new Date(start.getTime() + activity.elapsed_time * 1000);
  // Preserve the original Worker's rounding before applying the Python formatting.
  const distance = Number((activity.distance / 1609.344).toFixed(1));
  const elevation = Math.round(activity.total_elevation_gain * 3.28084);
  const moving = Math.round(activity.moving_time / 60);
  const elapsed = Math.round(activity.elapsed_time / 60);
  const name = stripLeadingEmoji(activity.name);
  const stravaUrl = `https://www.strava.com/activities/${activity.id}`;

  return {
    id: activity.id,
    name,
    sport_type: activity.sport_type,
    start: start.toISOString(),
    end: end.toISOString(),
    distance_miles: distance,
    elevation_feet: elevation,
    moving_minutes: moving,
    elapsed_minutes: elapsed,
    strava_url: stravaUrl,
    title: `${sport.emoji} ${distance.toFixed(1)} mi · ${elevation.toLocaleString("en-US")} ft`,
    description: [name, sport.label, `Moving: ${duration(moving)}`, `Elapsed: ${duration(elapsed)}`, "", `Strava: ${stravaUrl}`].join("\n"),
  };
}
