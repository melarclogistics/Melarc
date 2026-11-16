/**
 * What the browser says when its own policy (the page's Content-Security-Policy) stops a request or a picture: a `securitypolicyviolation` event of the window, which a failed request or a picture that would
 * not load says nothing of (it says only that it failed). **A thing the policy blocked is told as blocked** (the production policy allows the portal's own origin alone until the bucket's origin is configured,
 * OB-S1-107): said as a lost connection or a link that ran out, it would send the officer back to a button that cannot help. The words are `PHOTO_BLOCKED` and `STORE_BLOCKED`.
 */

/** The directives this portal watches: where pictures come from, and where a request may go. */
export type WatchedDirective = 'img-src' | 'connect-src';

/**
 * Whether a violation is this address's own: the directive's family (`img-src`, `img-src-elem`), for the address the thing was asked at. The browser reports the whole address, or only its origin for another
 * origin, so the address starts with what was blocked; a violation with no address, of another directive or of another address is somebody else's.
 */
export function violationBlocks(
  event: Pick<SecurityPolicyViolationEvent, 'blockedURI'> &
    Partial<Pick<SecurityPolicyViolationEvent, 'effectiveDirective' | 'violatedDirective'>>,
  directive: WatchedDirective,
  url: string,
): boolean {
  const effective = event.effectiveDirective ?? event.violatedDirective ?? '';
  const blocked = event.blockedURI;
  return effective.startsWith(directive) && blocked !== '' && url.startsWith(blocked);
}

export interface PolicyWatch {
  /** Whether the browser has reported a violation of the policy for this address since the watch began. */
  blocked(): boolean;
  /** Stops listening. It is always called: a listener left on the window would be one for every request that was ever made. */
  stop(): void;
}

/** Listens for the browser's report from this moment to `stop()`: begun before the request is sent, because the report may come as soon as the browser has decided. */
export function watchPolicy(directive: WatchedDirective, url: string): PolicyWatch {
  let seen = false;
  const listener = (event: Event): void => {
    if (violationBlocks(event as SecurityPolicyViolationEvent, directive, url)) seen = true;
  };
  window.addEventListener('securitypolicyviolation', listener);
  return {
    blocked: () => seen,
    stop: () => {
      window.removeEventListener('securitypolicyviolation', listener);
    },
  };
}

/** Lets a report the browser queued reach its listeners: the event is a task of its own and may come just after the failure of the request it is about. */
export function afterQueuedEvents(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
