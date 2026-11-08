import { Module } from '@nestjs/common';

import { NotificationLogController } from './notification-log.controller.js';
import { notificationLogProviders } from './notification-log-providers.js';

/**
 * The `notification` permission domain's reads (S1.12e, `SLICE-001`): the Ops message log. It depends on the platform and nothing depends
 * on it. The messages themselves are raised by the operations that own their events (the business act writes an envelope in its own
 * transaction) and sent by the notification lane of the delivery worker (`platform/notifications/`); this module only shows what became
 * of them. The Vendor's feed is read by the Vendor client's own slice.
 */
@Module({
  controllers: [NotificationLogController],
  providers: [...notificationLogProviders],
})
export class NotificationsModule {}
