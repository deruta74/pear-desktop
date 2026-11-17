import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';

test('AutoMix implements bounded tempo/key analysis and a transition plan', async () => {
  expect(
    existsSync(
      new URL('../../src/plugins/automix/analysis.ts', import.meta.url),
    ),
  ).toBe(true);
  const { analyseFrames, planAutoMix, MAX_FRAMES } =
    await import('../../src/plugins/automix/analysis');
  const frames = Array.from({ length: MAX_FRAMES }, (_, i) => ({
    energy: i % 10 === 0 ? 1 : 0.01,
    chroma: [
      6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ],
  }));
  const result = analyseFrames(frames);
  expect(result.bpm).toBeCloseTo(120, 0);
  expect(result.tempoConfidence).toBeGreaterThan(0.7);
  expect(result.key?.pitchClass).toBe(0);
  const tonal = planAutoMix(result, { blendBeats: 8, maxSeconds: 6 });
  const percussive = planAutoMix(
    { ...result, key: null },
    { blendBeats: 8, maxSeconds: 6 },
  );
  expect(tonal.fadeInDuration).toBe(2000);
  expect(percussive.fadeInDuration).toBe(4000);
  expect(tonal.secondsBeforeEnd).toBe(2.5);
  expect(analyseFrames([]).bpm).toBe(0);
});
