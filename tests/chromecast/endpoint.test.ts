import { expect, test } from '@playwright/test';
import {
  isSafeCastHost,
  isSafeCastPort,
} from '../../src/plugins/chromecast/endpoint';

test('Cast endpoints stay on discovered private IPv4 LAN addresses', () => {
  for (const host of ['192.168.1.20', '10.0.0.8', '172.16.0.9', '169.254.1.2'])
    expect(isSafeCastHost(host)).toBe(true);
  for (const host of [
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '8.8.8.8',
    'example.com',
    'speaker.local',
    '192.168.001.20',
    'http://192.168.1.20',
    '192.168.1.20\0',
    '999.1.1.1',
  ])
    expect(isSafeCastHost(host)).toBe(false);
  for (const port of [0, 65536, NaN, '8009', 8009.5])
    expect(isSafeCastPort(port)).toBe(false);
  expect(isSafeCastPort(8009)).toBe(true);
});
