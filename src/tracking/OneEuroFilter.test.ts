import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from './OneEuroFilter';

const DT_MS = 1000 / 30; // simulate a steady 30Hz signal

describe('OneEuroFilter', () => {
  it('returns the exact input on the very first sample (seeds instantly, no startup lag)', () => {
    const filter = new OneEuroFilter();
    expect(filter.filter(5, 0)).toBe(5);
  });

  it('converges to a held constant value', () => {
    const filter = new OneEuroFilter();
    let t = 0;
    let last = filter.filter(1, t);
    for (let i = 0; i < 60; i++) {
      t += DT_MS;
      last = filter.filter(1, t);
    }
    expect(last).toBeCloseTo(1, 6);
  });

  it('suppresses small jitter around a stable mean more than it passes through', () => {
    const filter = new OneEuroFilter();
    let t = 0;
    const outputs: number[] = [];
    for (let i = 0; i < 120; i++) {
      t += DT_MS;
      const noisy = 1 + (i % 2 === 0 ? 0.05 : -0.05); // alternating jitter around 1
      outputs.push(filter.filter(noisy, t));
    }
    const settled = outputs.slice(-40);
    const outputSpread = Math.max(...settled) - Math.min(...settled);
    expect(outputSpread).toBeLessThan(0.05); // much smaller than the 0.1 input jitter spread
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    expect(mean).toBeCloseTo(1, 1); // still tracks the true mean, not lagging away from it
  });

  it('catches up to a step change rather than permanently lagging behind it', () => {
    const filter = new OneEuroFilter();
    let t = 0;
    let last = filter.filter(0, t);
    for (let i = 0; i < 30; i++) {
      t += DT_MS;
      last = filter.filter(0, t);
    }
    // Step from 0 to 10, then hold.
    for (let i = 0; i < 60; i++) {
      t += DT_MS;
      last = filter.filter(10, t);
    }
    expect(last).toBeGreaterThan(9); // caught up, not stuck lagging near 0
  });

  it('reset() reseeds instantly instead of lerping from stale state', () => {
    const filter = new OneEuroFilter();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += DT_MS;
      filter.filter(0, t);
    }
    filter.reset();
    // A large time jump (as if tracking was lost for a while) must not
    // produce a slow crawl once reset — the very next call snaps exactly.
    expect(filter.filter(100, t + 5000)).toBe(100);
  });

  it('configure() lets minCutoff be tightened at runtime (heavier smoothing = smaller settled spread)', () => {
    const loose = new OneEuroFilter({ minCutoff: 2.5, beta: 0.4, dCutoff: 1.0 });
    const tight = new OneEuroFilter({ minCutoff: 2.5, beta: 0.4, dCutoff: 1.0 });
    tight.configure({ minCutoff: 0.3 });

    let t = 0;
    const looseOutputs: number[] = [];
    const tightOutputs: number[] = [];
    for (let i = 0; i < 120; i++) {
      t += DT_MS;
      const noisy = 1 + (i % 2 === 0 ? 0.05 : -0.05);
      looseOutputs.push(loose.filter(noisy, t));
      tightOutputs.push(tight.filter(noisy, t));
    }
    const spread = (arr: number[]): number => Math.max(...arr.slice(-40)) - Math.min(...arr.slice(-40));
    expect(spread(tightOutputs)).toBeLessThan(spread(looseOutputs));
  });
});
