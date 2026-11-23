import { useEffect, useRef } from 'react';

import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { OrderReview } from './OrderReview';
import type { OrderFlow } from './use-order-flow';
import './orders-pages.css';

const P = WORDS.form.price;

/**
 * The price beside the form (D-S7-2, 23 November 2026): what the server worked out for what is entered, **drawn and never calculated**, or what it is doing (waiting for the parcel to be filled in, checking, or
 * unable to price what was entered: the fields say why). When the price changed at the save, the earlier one is shown beside the new one and **the focus goes to it**, so that the officer reads it before the
 * save that says the new figure is pressed.
 */
export function OrderPrice({ flow }: { readonly flow: OrderFlow }) {
  const box = useRef<HTMLDivElement>(null);
  const { price } = flow;
  const earlier = price.kind === 'ready' ? price.earlier : undefined;
  useEffect(() => {
    if (earlier !== undefined) box.current?.focus();
  }, [earlier]);
  return (
    <section className="orders-price" aria-labelledby="orders-price-title">
      <h2 id="orders-price-title" className="orders-price__title">
        {P.title}
      </h2>
      <div aria-live="polite">
        {price.kind === 'ready' ? (
          <div ref={box} tabIndex={-1} className="orders-price__body">
            <OrderReview terms={price.terms} earlier={price.earlier} />
          </div>
        ) : (
          <p className="orders-note">
            {price.kind === 'checking'
              ? P.checking
              : price.kind === 'refused'
                ? P.refused
                : P.waiting}
          </p>
        )}
      </div>
    </section>
  );
}
