import process from 'node:process';

import { test, expect } from '@playwright/test';

import * as startup from './helpers/electron-startup.js';

test('quiet native query timeout retains killed, signal and deadline metadata in its message', async () => {
  expect(typeof startup.runNativePidQuery).toBe('function');
  await expect(
    startup.runNativePidQuery(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      100,
    ),
  ).rejects.toThrow(
    /code=null.*killed=true.*signal=SIGTERM.*elapsedMs=\d+.*timeoutMs=100/,
  );
});

test('quiet native query nonzero exit remains distinct from a timeout', async () => {
  expect(typeof startup.runNativePidQuery).toBe('function');
  await expect(
    startup.runNativePidQuery(
      process.execPath,
      ['-e', 'process.exit(7)'],
      1000,
    ),
  ).rejects.toThrow(/code=7.*killed=false.*signal=null.*timeoutMs=1000/);
});

test('successful native query preserves its exact output', async () => {
  expect(typeof startup.runNativePidQuery).toBe('function');
  const result = await startup.runNativePidQuery(
    process.execPath,
    ['-e', "process.stdout.write('[]')"],
    1000,
  );
  expect(result.stdout).toBe('[]');
});

test('native identity selects the actual executable from independently queried launcher children', async () => {
  expect(typeof startup.selectNativeStartupPid).toBe('function');
  expect(
    await startup.selectNativeStartupPid(
      [{ ProcessId: 123, ExecutablePath: process.execPath }],
      process.execPath,
    ),
  ).toBe(123);
});

/** @type {[string, { ProcessId: number, ExecutablePath: string | null }[]][]} */
const invalidProcesses = [
  ['missing child', []],
  ['nonpositive PID', [{ ProcessId: -1, ExecutablePath: process.execPath }]],
  ['fractional PID', [{ ProcessId: 1.5, ExecutablePath: process.execPath }]],
  ['missing executable', [{ ProcessId: 123, ExecutablePath: null }]],
  [
    'foreign executable',
    [{ ProcessId: 123, ExecutablePath: import.meta.filename }],
  ],
  [
    'ambiguous children',
    [
      { ProcessId: 123, ExecutablePath: process.execPath },
      { ProcessId: 124, ExecutablePath: process.execPath },
    ],
  ],
];
for (const [name, records] of invalidProcesses) {
  test(`native identity rejects ${name} instead of trusting startup facts`, async () => {
    expect(typeof startup.selectNativeStartupPid).toBe('function');
    await expect(
      startup.selectNativeStartupPid(records, process.execPath),
    ).rejects.toThrow(/native Electron process/);
  });
}
