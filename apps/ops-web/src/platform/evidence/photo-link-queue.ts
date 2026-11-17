import { createBoundedQueue, type BoundedQueue } from '../api/bounded-queue';

/**
 * The asking for photo links, bounded. A page that draws sixty photos asks the platform for sixty retrieval authorizations (`createEvidenceRetrievalAuthorization`, one for each tile that comes near the
 * screen), and every request of an authenticated session counts toward the session's limit, so the asking is **bounded**: at most `limit` at once, in the order they were asked for, and **a request that is
 * abandoned while it waits gives its place up and never runs** (a tile that scrolled away, or a page that was left). The queue knows nothing of what it runs: it is the portal's one bounded queue
 * (`platform/api/bounded-queue.ts`).
 */
export type PhotoLinkQueue = BoundedQueue;

export const createPhotoLinkQueue = createBoundedQueue;

/** The one queue of the page: four at a time is what a tablet's connection and the session's limit can carry, and a tile that is near the screen waits for no more than its turn. */
export const photoLinkQueue: PhotoLinkQueue = createBoundedQueue(4);
