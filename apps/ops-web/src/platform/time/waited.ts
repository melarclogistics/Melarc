/**
 * How long something has waited, in words a person says on the floor: *less than a minute*, *12 minutes*, *3 hours*, *2 days*. It is worked out when it is drawn and never kept (nothing re-draws it on a timer, and a
 * page that is read again says the new figure), from the instant the API gave and the browser's clock. It says how long, and never whether that is too long: what is late is a rule of the owner's, and this
 * decides none. A moment in the future, or one that is not an instant, is told as nothing.
 */
export function waitedText(instant: string, now: number = Date.now()): string | undefined {
  const then = Date.parse(instant);
  if (Number.isNaN(then)) return undefined;
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 0) return undefined;
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${String(days)} days`;
}
