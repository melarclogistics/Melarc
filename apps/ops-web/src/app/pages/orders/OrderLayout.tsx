import type { ReactNode } from 'react';

import './orders-pages.css';

/**
 * The form of an order with what it is about beside it (the review of 23 November 2026, item 1): **the parcel's photo, and the price**. Where there is room (about 40rem of the form's own width, a tablet at 768px
 * has it) they are a column beside the fields that **stays in view while the fields scroll**; where there is not, the photo is at the top of the page and stays there while the fields scroll under it, and
 * the price follows the fields, above the save. It is the order pages' own layout: the task form's rail is for forms whose summary is not a picture.
 */
export function OrderLayout({
  photo,
  price,
  children,
}: {
  /** The parcel's photo, or nothing for a vendor counted without photos. */
  readonly photo: ReactNode;
  readonly price: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="orders-layout">
      <div className="orders-layout__side">
        {photo === null ? null : <div className="orders-layout__photo">{photo}</div>}
        <div className="orders-layout__price">{price}</div>
      </div>
      <div className="orders-layout__fields">{children}</div>
    </div>
  );
}
