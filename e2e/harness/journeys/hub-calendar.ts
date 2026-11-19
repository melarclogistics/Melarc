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

/** Milliseconds from an instant to the hub's next midnight. The hub's zone keeps one offset all year, so a day of it is 24 hours. */
export function msUntilHubMidnight(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HUB_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const at = (type: 'hour' | 'minute' | 'second'): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const sinceMidnight =
    ((at('hour') * 60 + at('minute')) * 60 + at('second')) * 1000 + now.getMilliseconds();
  if (Number.isNaN(sinceMidnight)) throw new Error('The hub clock could not be read.');
  return 24 * 60 * 60 * 1000 - sinceMidnight;
}

/**
 * How long a journey that needs one day, from its first request to its last, waits for it: nothing when `needed` milliseconds of the hub's day are left, and the rest of the day and
 * two seconds more when fewer are. A run is started on its own day and a day is judged by the hub's clock, so a journey that began in the last minutes of the hub's day found the day
 * over under its hands ("That day has passed": the HTTPS journeys of a pull request, 23:58 UTC on 18 November 2026). It is not a retry: the journey starts once, on a day that is long enough.
 */
export function msToWaitForADay(needed: number, now: Date = new Date()): number {
  const left = msUntilHubMidnight(now);
  return left >= needed ? 0 : left + 2000;
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
