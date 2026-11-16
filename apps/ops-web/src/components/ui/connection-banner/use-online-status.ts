import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** What the browser says, which is a guess in one direction: `false` is a connection that is certainly gone, `true` is only a network that is there. A browser that cannot say is taken to be online. */
const read = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

/**
 * Whether the browser says it is online (`navigator.onLine`), kept current by the window's `online` and `offline` events. It is what the browser says and no more: a browser that says it is online can still
 * fail to reach the server (a captive portal, a signal that carries nothing), which is why a page that has seen a request fail for the network says so itself (`ConnectionBanner`, `requestFailed`).
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
