import vm from 'node:vm';
import { computeDattorroParams } from '../../../../src/plugins/player-actions/slowed-reverb/engine.ts';
import { DATTORRO_WORKLET_SOURCE } from '../../../../src/plugins/player-actions/slowed-reverb/worklet.ts';

const [rate, stepFrames, mix, ...intensities] = process.argv.slice(2);
const sampleRate = Number(rate);
const stepSize = Number(stepFrames);
let Processor;
vm.runInNewContext(DATTORRO_WORKLET_SOURCE, {
  sampleRate,
  AudioWorkletProcessor: class {
    port = { onmessage: null };
  },
  registerProcessor: (name, constructor) => {
    if (name === 'dattorro-reverb') Processor = constructor;
  },
});

const tank = new Processor();
const byteLength =
  intensities.length * stepSize * 4 * Float32Array.BYTES_PER_ELEMENT;
const fixture = Buffer.alloc(byteLength);
let byteOffset = 0;
let seed = 0x9e3779b9;
function sample() {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return seed / 2147483648;
}

// Stream little-endian interleaved L/R input and L/R expected wet output.
// The synthetic signal combines asymmetric noise, transients and silence.
for (const intensity of intensities) {
  const params = computeDattorroParams(Number(intensity));
  if (mix === 'binary' && params.wetGain > 0) params.wetGain = 1;
  tank.handleMessage({ type: 'setParams', params });

  for (let offset = 0; offset < stepSize; offset += 128) {
    const frames = Math.min(128, stepSize - offset);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const wetLeft = new Float32Array(frames);
    const wetRight = new Float32Array(frames);
    for (let i = 0; i < frames && offset + i < stepSize / 2; i++) {
      left[i] = 0.6 * sample();
      right[i] = 0.35 * sample();
    }
    if (offset === 0) {
      left[0] = 1;
      right[0] = -0.5;
    }

    if (!tank.process([[left, right]], [[wetLeft, wetRight]])) {
      throw new Error('Worklet processor stopped unexpectedly');
    }

    for (let i = 0; i < frames; i++) {
      for (const value of [left[i], right[i], wetLeft[i], wetRight[i]]) {
        byteOffset = fixture.writeFloatLE(value, byteOffset);
      }
    }
  }
}
process.stdout.write(fixture);
