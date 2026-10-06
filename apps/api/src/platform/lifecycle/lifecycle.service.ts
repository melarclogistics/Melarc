import { Injectable } from '@nestjs/common';

export type LifecycleState = 'starting' | 'ready' | 'draining';

/**
 * Where this instance is in its life. Readiness reads it: an instance is in rotation only while it
 * is ready, and it leaves rotation the moment it starts draining.
 */
@Injectable()
export class LifecycleService {
  private current: LifecycleState = 'starting';

  get state(): LifecycleState {
    return this.current;
  }

  /** Called once the listener is open. A draining instance never returns to ready. */
  markReady(): void {
    if (this.current === 'starting') this.current = 'ready';
  }

  beginDraining(): void {
    this.current = 'draining';
  }
}
