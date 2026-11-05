import {
  MANIFEST_FILTER_STATES,
  type ManifestFilterState,
} from '../../../platform/manifest/manifest-shape';
import { calendarDateOf } from '../../../platform/pickup/pickup-shape';

/**
 * The two filters of the manifest list (`listPickupManifests`, OB-S1-25) as the address carries them (`?state=DRAFT&date=2026-11-04`), in the
 * names the pickup queue's address uses (`state`, `date`; the request names the second `service_date`). The address is the person's to edit,
 * so **a value that is not one is no filter**: a state that is not one of the contract's five (another case, a trailing blank, an empty value),
 * a day that does not exist or is not written `YYYY-MM-DD`. Only the first of a repeated parameter is read, so what is asked of the server is
 * never a repeated parameter. Nothing here reads a storage or the server, and nothing is judged from what a list returned.
 */
export interface ManifestListFilters {
  readonly state?: ManifestFilterState;
  /** A calendar date, `YYYY-MM-DD`. */
  readonly date?: string;
}

/** A state from the address, or nothing: one of the five exactly. */
export const stateOfText = (text: string | null): ManifestFilterState | undefined =>
  MANIFEST_FILTER_STATES.find((state) => state === text);

/** The filters an address holds, each judged. */
export function filtersOf(params: URLSearchParams): ManifestListFilters {
  const state = stateOfText(params.get('state'));
  const date = calendarDateOf(params.get('date'));
  return {
    ...(state === undefined ? {} : { state }),
    ...(date === undefined ? {} : { date }),
  };
}

/** The filters that are set, as the address carries them, or nothing when none is. */
export function searchOf(filters: ManifestListFilters): string {
  const out = new URLSearchParams();
  if (filters.state !== undefined) out.set('state', filters.state);
  if (filters.date !== undefined) out.set('date', filters.date);
  const text = out.toString();
  return text === '' ? '' : `?${text}`;
}
