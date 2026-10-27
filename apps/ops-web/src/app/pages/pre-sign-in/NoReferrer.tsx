/**
 * Tells the browser to send no referrer while a link page is open (SECURITY_DESIGN section 13.9a: the page "sends `no-referrer`"). A grant lives
 * in the fragment, which a browser never sends in a referrer, and the page is served with `Referrer-Policy: no-referrer`; this is the page's own
 * statement of it, so that the policy holds wherever the page is served from and for every request it makes while open. React puts the element
 * in the document head and removes it when the page goes.
 */
export function NoReferrer() {
  return <meta name="referrer" content="no-referrer" />;
}
