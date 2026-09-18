export interface RenderClock {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const systemClock: RenderClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Coalesces render requests while leaving state and item updates synchronous. */
export class RenderScheduler {
  private lastRenderAt: number | undefined;
  private pending: unknown;
  private stopped = false;

  constructor(
    private readonly render: () => void,
    private readonly clock: RenderClock = systemClock,
    private readonly frameMilliseconds = 16,
  ) {}

  request(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    if (this.lastRenderAt === undefined || now - this.lastRenderAt >= this.frameMilliseconds) {
      this.renderNow(now);
      return;
    }
    if (this.pending !== undefined) return;
    this.pending = this.clock.setTimeout(
      () => {
        this.pending = undefined;
        if (!this.stopped) this.renderNow(this.clock.now());
      },
      this.frameMilliseconds - (now - this.lastRenderAt),
    );
  }

  requestImmediate(): void {
    if (this.stopped) return;
    this.cancelPending();
    this.renderNow(this.clock.now());
  }

  flush(): void {
    if (this.stopped || this.pending === undefined) return;
    this.cancelPending();
    this.renderNow(this.clock.now());
  }

  stop(): void {
    this.stopped = true;
    this.cancelPending();
  }

  private renderNow(now: number): void {
    this.lastRenderAt = now;
    this.render();
  }

  private cancelPending(): void {
    if (this.pending === undefined) return;
    this.clock.clearTimeout(this.pending);
    this.pending = undefined;
  }
}
