import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseNotificationPage,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationPageView,
  type NotificationState,
} from './notification-shape';

/**
 * The read of the message log (S1.12e), judged before it is believed (`notification-shape.ts`). As the identity, vendor, rider and pickup
 * screens' reads, it is not read again on focus or reconnect (every accepted request is activity), and nothing is kept once the screen lets
 * go (`gcTime: 0`). A failed read is retried by the person, not by the page.
 */
const NOT_KEPT = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  gcTime: 0,
} as const;

export interface NotificationListParams {
  readonly state?: NotificationState;
  readonly audience?: NotificationAudience;
  readonly channel?: NotificationChannel;
  /** Only the messages raised about this record: the identifier of the pickup request they announce. */
  readonly subjectId?: string;
  readonly pageToken?: string;
  readonly enabled?: boolean;
}

/**
 * `listNotifications`: a page of the messages of the hubs the session's grant reaches (`notification.read`), newest first, scoped by the
 * server and filtered by state, audience, channel and the record they are about. The Ops feed is this list with `channel=FEED` and
 * `audience=OPS_FEED`. **Nothing here asks for, holds or builds a number, a text or a code**: the filters are closed words and an identifier,
 * and an entry has no such field.
 */
export function useNotifications(
  params: NotificationListParams,
): UseQueryResult<NotificationPageView> {
  const client = useApiClient();
  const { state, audience, channel, subjectId, pageToken, enabled = true } = params;
  return useQuery({
    queryKey: [
      'notifications',
      'list',
      state ?? null,
      audience ?? null,
      channel ?? null,
      subjectId ?? null,
      pageToken ?? null,
    ],
    enabled,
    ...NOT_KEPT,
    queryFn: async () => {
      const answer = answerOf(
        await client.GET('/notifications', {
          params: {
            query: {
              ...(state === undefined ? {} : { state }),
              ...(audience === undefined ? {} : { audience }),
              ...(channel === undefined ? {} : { channel }),
              ...(subjectId === undefined ? {} : { subject_id: subjectId }),
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
          },
        }),
      );
      const page = parseNotificationPage(answer.data);
      // Filtered, every message carries what it was filtered by: a page that does not is not this query's.
      if (
        page === undefined ||
        page.items.some(
          (message) =>
            (state !== undefined && message.state !== state) ||
            (audience !== undefined && message.audience !== audience) ||
            (channel !== undefined && message.channel !== channel) ||
            (subjectId !== undefined &&
              message.subject.id.toLowerCase() !== subjectId.toLowerCase()),
        )
      ) {
        throw unexpectedResponse(answer.status);
      }
      return page;
    },
  });
}
