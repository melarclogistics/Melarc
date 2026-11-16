import type { ParcelAnswerView, RunPageView, VendorView } from './receiving-shape';

/**
 * What a parcel's act answers, put into the run's page that was read (S1.35c). A tap, the finding of a missing parcel and an extra each answer with **the parcel as it now is, the vendor's token and the vendor's
 * counts** (`IntakeParcelAnswer`): the page keeps the run it read and takes those answers into it, so that twelve taps are twelve requests and not twenty-four, and so that what is drawn is what the API said and
 * nothing the page worked out (the counts are the API's: this copies them and counts nothing). Anything else a vendor changes (finishing it, a condition, a correction) changes more than the parcel, and the page
 * reads the run again.
 *
 * Nothing is taken in for a vendor or a parcel the page does not hold (an answer that belongs to another run is not drawn into this one), and a page that has the parcel in another vendor is not changed.
 */
export function applyParcelAnswer(
  page: RunPageView,
  intakeId: string,
  answer: ParcelAnswerView,
): RunPageView {
  const wanted = intakeId.toLowerCase();
  const at = page.vendors.findIndex((vendor) => vendor.intake_id.toLowerCase() === wanted);
  const vendor = page.vendors[at];
  if (vendor === undefined) return page;
  const parcelId = answer.parcel.id.toLowerCase();
  const known = vendor.parcels.some((parcel) => parcel.id.toLowerCase() === parcelId);
  const parcels = known
    ? vendor.parcels.map((parcel) =>
        parcel.id.toLowerCase() === parcelId ? answer.parcel : parcel,
      )
    : // An extra the officer has just added: it follows the parcels the door photos gave, in the order the API numbers them.
      [...vendor.parcels, answer.parcel].toSorted((a, b) => a.ordinal - b.ordinal);
  const taken: VendorView = {
    ...vendor,
    ...answer.counts,
    intake_etag: answer.intake_etag,
    parcels,
  };
  return {
    ...page,
    vendors: page.vendors.map((candidate, index) => (index === at ? taken : candidate)),
  };
}
