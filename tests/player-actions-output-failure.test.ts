/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';

import { playerActionsFixture } from './helpers/player-actions-fixture';

test('synchronous output guard allocation failure retires wet and a genuine later engagement retries', async () => {
  const f = await playerActionsFixture();
  try {
    const graph = f.graph('guard-allocation'),
      create = graph.audioContext.createWaveShaper;
    graph.audioContext.createWaveShaper = () => {
      throw Error('owned guard allocation failure');
    };
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 0.85, reverbIntensity: 1 },
      }),
      setConfig: async () => {},
    });
    await f.settle();
    expect(r.slowedReverb.workletFailed).toBe(true);
    expect(r.slowedReverb.wetGain).toBeNull();
    expect(r.slowedReverb.wetOutput).toBeNull();
    expect(f.media.playbackRate).toBe(0.85);
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
    r.onConfigChange({
      ...r.getCurrent(),
      slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 0 },
    });
    graph.audioContext.createWaveShaper = create;
    r.onConfigChange({
      ...r.getCurrent(),
      slowedReverb: { ...r.getCurrent().slowedReverb, reverbIntensity: 1 },
    });
    await f.settle();
    expect(f.loads.length).toBe(1);
    f.loads[0].resolve();
    await f.settle();
    expect(r.slowedReverb.workletFailed).toBe(false);
    expect(r.slowedReverb.reverbNode).not.toBeNull();
    expect(r.slowedReverb.wetGain.connections).toEqual(
      new Set([graph.audioGraph.masterInput]),
    );
  } finally {
    await f.close();
  }
});
