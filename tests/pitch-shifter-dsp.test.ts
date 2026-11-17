/* oxlint-disable @stylistic/no-mixed-operators */
import vm from 'node:vm';

import { test, expect } from '@playwright/test';

import { registerPitchShifterProcessor } from '../src/plugins/pitch-shifter/processor';

type Processor = {
  port: { onmessage: (event: { data: unknown }) => void };
  channels: unknown[];
  process(
    input: Float32Array[][],
    output: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
};
function processor() {
  let Type!: new () => Processor;
  vm.runInNewContext(
    `(${registerPitchShifterProcessor.toString()})('test-pitch')`,
    {
      sampleRate: 48000,
      AudioWorkletProcessor: class {
        port = { onmessage: null };
      },
      registerProcessor: (_name: string, value: new () => Processor) => {
        Type = value;
      },
    },
  );
  return new Type();
}
function render(semitones: number, frequency = 440, blocks = 750) {
  const dsp = processor(),
    samples = new Float32Array(blocks * 128);
  for (let block = 0; block < blocks; block++) {
    const input = Float32Array.from(
      { length: 128 },
      (_, i) =>
        0.2 * Math.sin((2 * Math.PI * frequency * (block * 128 + i)) / 48000),
    );
    const output = new Float32Array(128);
    dsp.process([[input]], [[output]], {
      semitones: new Float32Array([semitones]),
    });
    samples.set(output, block * 128);
  }
  return samples;
}
function frequency(samples: Float32Array) {
  const positions = [];
  for (let i = 16385; i < samples.length; i++)
    if (samples[i - 1] < 0 && samples[i] >= 0)
      positions.push(i - 1 - samples[i - 1] / (samples[i] - samples[i - 1]));
  return ((positions.length - 1) * 48000) / (positions.at(-1)! - positions[0]);
}
test('upstream phase vocoder shifts -12,-5,-1,+3,+7,+12 within five cents and reasonable gain', () => {
  for (const tone of [220, 440, 1000])
    for (const shift of [-12, -5, -1, 3, 7, 12]) {
      const samples = render(shift, tone),
        actual = frequency(samples),
        expected = tone * 2 ** (shift / 12);
      expect(
        Math.abs(1200 * Math.log2(actual / expected)),
        `${tone} ${shift}`,
      ).toBeLessThanOrEqual(5);
      const tail = samples.subarray(16384);
      const rms = Math.sqrt(tail.reduce((n, x) => n + x * x, 0) / tail.length);
      expect(rms).toBeGreaterThan(0.06);
      expect(rms).toBeLessThan(0.25);
      expect([...samples].every(Number.isFinite)).toBe(true);
    }
});

test('zero is sample-neutral after documented 1536 sample latency', () => {
  const samples = render(0);
  let error = 0;
  for (let i = 1536; i < samples.length; i++)
    error = Math.max(
      error,
      Math.abs(
        samples[i] - 0.2 * Math.sin((2 * Math.PI * 440 * (i - 1536)) / 48000),
      ),
    );
  expect(error).toBeLessThan(1e-6);
});

test('live changes retain bounded channel state and finite continuous output; disposal stops DSP', () => {
  const dsp = processor();
  let previous = 0,
    maxStep = 0,
    finite = true;
  for (let block = 0; block < 750; block++) {
    const semitones = block < 100 ? 0 : block < 300 ? 7 : block < 500 ? -5 : 0;
    const input = Float32Array.from(
      { length: 128 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * (block * 128 + i)) / 48000),
    );
    const output = [new Float32Array(128), new Float32Array(128)];
    expect(
      dsp.process([[input]], [output], {
        semitones: new Float32Array([semitones]),
      }),
    ).toBe(true);
    for (const sample of output[0]) {
      finite &&= Number.isFinite(sample);
      maxStep = Math.max(maxStep, Math.abs(sample - previous));
      previous = sample;
    }
    expect(dsp.channels).toHaveLength(2);
  }
  expect(finite).toBe(true);
  expect(maxStep).toBeLessThan(0.15);
  dsp.port.onmessage({ data: 'dispose' });
  const output = new Float32Array(128).fill(1);
  expect(
    dsp.process([], [[output]], { semitones: new Float32Array([0]) }),
  ).toBe(false);
  expect([...output].every((x) => x === 0)).toBe(true);
});

test('unsupported channel counts and nonfinite samples cannot retain unbounded or nonfinite DSP state', () => {
  const actual = processor(),
    reference = processor();
  for (let block = 0; block < 40; block++) {
    const bad = Float32Array.from(
      { length: 128 },
      (_, i) => [NaN, Infinity, -Infinity, 2000, -2000, 0.5][i % 6],
    );
    const bounded = Float32Array.from(bad, (x) => (Number.isFinite(x) ? x : 0));
    const output = Array.from({ length: 4 }, () =>
        new Float32Array(128).fill(1),
      ),
      expected = Array.from({ length: 4 }, () => new Float32Array(128));
    actual.process([[bad]], [output], { semitones: new Float32Array([NaN]) });
    reference.process([[bounded]], [expected], {
      semitones: new Float32Array([0]),
    });
    expect(output).toEqual(expected);
    expect(actual.channels).toHaveLength(2);
    expect([...output[2], ...output[3]].every((sample) => sample === 0)).toBe(
      true,
    );
  }
});

test('neutral delayed waveform preserves legitimate post-EQ headroom above unity', () => {
  const dsp = processor(),
    input = new Float32Array(8192),
    output = new Float32Array(8192);
  for (let i = 0; i < input.length; i++)
    input[i] = 1.75 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  for (let start = 0; start < input.length; start += 128) {
    const block = new Float32Array(128);
    dsp.process([[input.subarray(start, start + 128)]], [[block]], {
      semitones: new Float32Array([0]),
    });
    output.set(block, start);
  }
  let error = 0;
  for (let i = 1536; i < output.length; i++)
    error = Math.max(error, Math.abs(output[i] - input[i - 1536]));
  expect(error).toBeLessThan(1e-6);
  expect(Math.max(...output)).toBeGreaterThan(1.7);
});
