import { describe, expect, it } from "vitest";

import { type RenderClock, RenderScheduler } from "./render-scheduler.js";

class FakeClock implements RenderClock {
  current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }
  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
  get pendingCount(): number {
    return this.timers.size;
  }
  now(): number {
    return this.current;
  }
}

describe("RenderScheduler", () => {
  it("renders the first update promptly and batches a burst into one frame", () => {
    const clock = new FakeClock();
    const renders: number[] = [];
    const scheduler = new RenderScheduler(() => renders.push(clock.now()), clock, 16);

    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(renders).toEqual([0]);
    expect(clock.pendingCount).toBe(1);

    clock.advance(15);
    expect(renders).toEqual([0]);
    clock.advance(1);
    expect(renders).toEqual([0, 16]);
  });

  it("renders sparse updates immediately and flushes the latest pending update", () => {
    const clock = new FakeClock();
    const renders: number[] = [];
    const scheduler = new RenderScheduler(() => renders.push(clock.now()), clock, 16);

    scheduler.request();
    clock.advance(20);
    scheduler.request();
    scheduler.request();
    scheduler.flush();

    expect(renders).toEqual([0, 20, 20]);
    expect(clock.pendingCount).toBe(0);
  });

  it("cancels pending work on shutdown without rendering after stop", () => {
    const clock = new FakeClock();
    const renders: number[] = [];
    const scheduler = new RenderScheduler(() => renders.push(clock.now()), clock, 16);

    scheduler.request();
    scheduler.request();
    scheduler.stop();
    clock.advance(20);

    expect(renders).toEqual([0]);
    expect(clock.pendingCount).toBe(0);
  });
});
