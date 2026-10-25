import { test, expect } from '@playwright/test';

import {
  computeDattorroParams,
  computeWetPeakReserve,
} from '../src/plugins/player-actions/slowed-reverb/engine';
import { playerActionsFixture } from './helpers/player-actions-fixture';

test('only the latest audio-thread acknowledgement can release retained wet headroom', async () => {
  const f = await playerActionsFixture();
  try {
    const graph = f.graph('headroom');
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 1 },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    const c = r.slowedReverb,
      node = c.reverbNode;
    const maximum = computeWetPeakReserve(computeDattorroParams(1));
    c.config = { ...c.config, reverbIntensity: 0.35 };
    c.applyReverb();
    const stale = c.paramRevision;
    c.config = { ...c.config, reverbIntensity: 0.4 };
    c.applyReverb();
    c.applyReverb();
    expect(c.reservedWetPeak).toBeCloseTo(maximum, 10);
    node.port.onmessage({ data: { type: 'params-applied', revision: stale } });
    expect(c.reservedWetPeak).toBeCloseTo(maximum, 10);
    node.port.onmessage({
      data: { type: 'params-applied', revision: c.paramRevision },
    });
    expect(c.reservedWetPeak).toBeCloseTo(
      computeWetPeakReserve(computeDattorroParams(0.4)),
      10,
    );
    const oldAck = node.port.onmessage;
    r.stop();
    const replacement = graph.audioGraph.registerWetMixPeak();
    replacement.update(1);
    oldAck({ data: { type: 'params-applied', revision: c.paramRevision } });
    expect(graph.audioGraph.masterSourcePeak).toBe(1);
    expect(graph.audioGraph.masterInput.gain.value).toBeCloseTo(0.5, 10);
    replacement.release();
    expect(graph.audioGraph.masterInput.gain.value).toBe(1);
    expect(graph.audioSource.connections.has(graph.audioGraph.dryInput)).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test('interrupted intensity ramps retain headroom until both the latest audio-clock completion and parameter acknowledgement', async () => {
  const f = await playerActionsFixture();
  try {
    const graph = f.graph('ramp-handshake');
    f.announce(graph);
    const r = f.source.plugin.renderer;
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 1 },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    const c = r.slowedReverb,
      node = c.reverbNode,
      maximum = computeWetPeakReserve(computeDattorroParams(1));
    graph.audioContext.currentTime = 1;
    c.config = { ...c.config, reverbIntensity: 0.01 };
    c.applyReverb();
    const oldRevision = c.paramRevision;
    node.port.onmessage({
      data: { type: 'params-applied', revision: oldRevision },
    });
    expect(c.reservedWetPeak).toBeCloseTo(maximum, 10);
    expect(c.wetEnvelope.end).toBeCloseTo(1.02, 10);
    graph.audioContext.currentTime = 1.01;
    const midpoint =
      (computeDattorroParams(1).wetGain + computeDattorroParams(0.01).wetGain) /
      2;
    c.config = { ...c.config, reverbIntensity: 1 };
    c.applyReverb();
    expect(c.wetEnvelope.from).toBeCloseTo(midpoint, 10);
    expect(c.wetEnvelope.start).toBeCloseTo(1.01, 10);
    expect(c.wetEnvelope.end).toBeCloseTo(1.03, 10);
    graph.audioContext.currentTime = 1.015;
    const interrupted =
      midpoint + (computeDattorroParams(1).wetGain - midpoint) / 4;
    c.config = { ...c.config, reverbIntensity: 0.35 };
    c.applyReverb();
    const latest = c.paramRevision;
    expect(c.wetEnvelope.from).toBeCloseTo(interrupted, 10);
    // Clock progress alone and a completion with the latest revision cannot
    // substitute for a lost acknowledgement of those actual tank parameters.
    graph.audioContext.currentTime = 1.04;
    node.port.onmessage({
      data: { type: 'wet-ramp-complete', revision: latest },
    });
    expect(c.reservedWetPeak).toBeCloseTo(maximum, 10);
    node.port.onmessage({
      data: { type: 'params-applied', revision: oldRevision },
    });
    expect(c.reservedWetPeak).toBeCloseTo(maximum, 10);
    node.port.onmessage({ data: { type: 'params-applied', revision: latest } });
    expect(c.reservedWetPeak).toBeCloseTo(
      computeWetPeakReserve(computeDattorroParams(0.35)),
      10,
    );
    const oldPortHandler = node.port.onmessage;
    r.stop();
    const replacement = graph.audioGraph.registerWetMixPeak();
    replacement.update(1);
    oldPortHandler({ data: { type: 'wet-ramp-complete', revision: latest } });
    expect(graph.audioGraph.masterInput.gain.value).toBeCloseTo(0.5, 10);
    replacement.release();
  } finally {
    await f.close();
  }
});
