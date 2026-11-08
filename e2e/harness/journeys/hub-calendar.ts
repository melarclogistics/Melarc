/**
 * The hub's calendar as the journeys need it (S1.25). The API judges a run's day by the hub's clock, `Africa/Accra`, whatever the browser's own
 * clock says (the harness freezes that on 5 October 2026), and the hub works Monday to Saturday: "every zone operates the same Monday to
 * Saturday calendar" (PROJECT_MASTER_SPECIFICATION section 21.1, `MSC-DEC-149`; `apps/api/src/pickup/booking-rules.ts`). A manifest is for a
 * day the hub works, and a run starts on its own day, so a journey that builds and runs a manifest today has nothing valid to walk on a
 * Sunday: the API refuses the day ("The hub does not run on that day"). The first hosted run of the journey, on a Sunday, found that.
 */
const HUB_TIME_ZONE = 'Africa/Accra';

/** Today at the hub, `YYYY-MM-DD`. */
export function hubToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HUB_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Whether the hub works on a calendar day, `YYYY-MM-DD`: Monday to Saturday. A date that is not a real day is refused. */
export function hubRunsOn(day: string): boolean {
  const noon = new Date(`${day}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(noon.getTime()) ||
    noon.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`"${day}" is not a calendar day in the form YYYY-MM-DD.`);
  }
  return noon.getUTCDay() !== 0;
}
