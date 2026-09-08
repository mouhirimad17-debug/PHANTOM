import { describe, expect, it } from 'vitest';
import { TrackingHistory } from './TrackingHistory';
import { createTrackingFrame } from './trackingFrame';

function frameAt(timestampMs: number, marker: number) {
  const frame = createTrackingFrame();
  frame.timestampMs = timestampMs;
  frame.state = 'TRACKING';
  frame.present = true;
  frame.bodyScale = marker; // cheap scalar marker to identify which frame we got back
  return frame;
}

describe('TrackingHistory', () => {
  it('getLatest() returns null before anything is pushed', () => {
    const history = new TrackingHistory();
    expect(history.getLatest()).toBeNull();
    expect(history.size).toBe(0);
  });

  it('getLatest() returns the most recently pushed frame', () => {
    const history = new TrackingHistory();
    history.push(frameAt(0, 1));
    history.push(frameAt(100, 2));
    history.push(frameAt(200, 3));
    expect(history.getLatest()?.timestampMs).toBe(200);
    expect(history.getLatest()?.bodyScale).toBe(3);
    expect(history.size).toBe(3);
  });

  it('push() stores an independent snapshot — mutating the source afterward does not affect history', () => {
    const history = new TrackingHistory();
    const live = frameAt(0, 42);
    history.push(live);

    // Simulate TrackingManager continuing to mutate its single reused frame object.
    live.timestampMs = 999;
    live.bodyScale = -1;
    live.landmarks[0]!.position.set(7, 7, 7);

    const stored = history.getLatest();
    expect(stored?.timestampMs).toBe(0);
    expect(stored?.bodyScale).toBe(42);
    expect(stored?.landmarks[0]!.position.x).toBe(0);
  });

  it('getAtOffset() returns the frame closest to (latest - offset)', () => {
    const history = new TrackingHistory(5000);
    for (let i = 0; i <= 10; i++) {
      history.push(frameAt(i * 100, i)); // timestamps 0,100,...,1000; marker == index
    }
    // latest.timestampMs = 1000; offset 250 -> target 750 -> closest stored is 700 or 800 (both 50ms away; either is acceptable)
    const result = history.getAtOffset(250);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.timestampMs - 750)).toBeLessThanOrEqual(50);
  });

  it('getAtOffset(0) behaves like getLatest()', () => {
    const history = new TrackingHistory();
    history.push(frameAt(0, 1));
    history.push(frameAt(100, 2));
    expect(history.getAtOffset(0)?.timestampMs).toBe(history.getLatest()?.timestampMs);
  });

  it('respects the configured maximum duration — an offset beyond it finds nothing beyond the window', () => {
    const history = new TrackingHistory(300); // only remember 300ms of logical history
    for (let i = 0; i <= 20; i++) {
      history.push(frameAt(i * 100, i)); // spans 0..2000ms
    }
    // latest = 2000ms; asking 1000ms back (900ms outside the 300ms window) must not
    // reach all the way back to a frame from ~1000 seconds "ago" in stored order.
    const result = history.getAtOffset(1000);
    expect(result).not.toBeNull();
    // Nothing returned should be older than maxDuration relative to latest.
    expect(2000 - result!.timestampMs).toBeLessThanOrEqual(300);
  });

  it('clear() empties the buffer', () => {
    const history = new TrackingHistory();
    history.push(frameAt(0, 1));
    history.clear();
    expect(history.getLatest()).toBeNull();
    expect(history.size).toBe(0);
  });

  it('wraps around at capacity without growing or erroring', () => {
    const history = new TrackingHistory(60_000, 10); // tiny capacity to exercise wraparound
    for (let i = 0; i < 25; i++) {
      history.push(frameAt(i * 10, i));
    }
    expect(history.size).toBe(10); // capped at capacity
    expect(history.capacity).toBe(10);
    expect(history.getLatest()?.bodyScale).toBe(24); // most recent push survives
  });
});
