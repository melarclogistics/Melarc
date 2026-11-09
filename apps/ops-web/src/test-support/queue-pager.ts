import { screen } from '@testing-library/react';

/**
 * The status region of a queue's pager (the line "Showing 25 requests. More follow on the next page."), found by the place the kit draws it in. A test that says the pager is the same
 * element through a read holds on to it before the read and looks again after (the review of 499399c: a pager taken out of the page while the next page is read is made anew
 * with its words, which most screen readers do not announce). Never imported by application code.
 */
export function pagerRegion(): HTMLElement {
  const region = screen
    .getAllByRole('status')
    .find((element) => element.classList.contains('ui-queue-pager__count'));
  if (region === undefined) throw new Error('The page draws no pager.');
  return region;
}
