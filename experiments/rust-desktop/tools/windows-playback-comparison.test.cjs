'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compare, embedMatches, pearPages, pearTargetEvidence, playerError } = require('./windows-playback-comparison.cjs');

const youtube = 'https://www.youtube.com/embed/M7lc1UVf-VE';
const pear = '?enablejsapi=1&origin=https%3A%2F%2Fcom.pear-desktop.rust-preview&autoplay=0';
const demo = '?enablejsapi=1&origin=https%3A%2F%2Fdevelopers-dot-devsite-v2-prod.appspot.com&widgetid=2';
const demoParent = 'https://developers-dot-devsite-v2-prod.appspot.com';

test('requires the exact current Pear embed and accepts equivalent query serialization', () => {
    assert.equal(embedMatches('pear', youtube + pear), true);
    assert.equal(embedMatches('pear',
        youtube + '?autoplay=0&origin=https%3a%2f%2fcom.pear-desktop.rust-preview&enablejsapi=1'), true);
    for (const url of [
        youtube,
        youtube + pear + '&autoplay=0',
        youtube + pear + '&other=1',
        youtube + pear + '#fragment',
        youtube.replace('M7lc1UVf-VE', 'otherVideo1') + pear,
        youtube.replace('www.youtube.com', 'www.youtube.com.example.test') + pear,
    ]) assert.equal(embedMatches('pear', url), false, url);
});

test('allows Google demo widget parameters for the same video with autoplay disabled', () => {
    assert.equal(embedMatches('edge', youtube + demo, demoParent), true);
    assert.equal(embedMatches('edge', youtube + demo + '&autoplay=0', demoParent), true);
    assert.equal(embedMatches('edge', youtube + demo + '&autoplay=1', demoParent), false);
    assert.equal(embedMatches('edge', youtube + demo + '&origin=https%3A%2F%2Fexample.test', demoParent), false);
    assert.equal(embedMatches('edge', youtube + demo, 'https://example.test'), false);
    assert.equal(embedMatches('edge', youtube + demo, 'https://developers.google.com'), false);
});

test('emits known player-error values without relaying service strings', () => {
    assert.equal(playerError(153), '153');
    assert.equal(playerError('-1'), 'wrapper-error');
    assert.equal(playerError('Error: 153'), '153');
    assert.equal(playerError('Error: 153 extra text'), 'unknown');
    assert.equal(playerError('https://example.test/private'), 'unknown');
    assert.equal(playerError(undefined), 'none');
});

test('only calls a failure Pear-specific after the Edge control plays', () => {
    const ready = { probe: 'observed', timeline: false, error: 'none', screen: 'none' };
    const played = { ...ready, timeline: true };
    assert.equal(compare(ready, played), 'pear-path-did-not-play');
    assert.equal(compare(played, ready), 'edge-control-did-not-play');
    assert.equal(compare(played, played), 'both-played');
    assert.equal(compare(ready, ready), 'neither-played-cause-unresolved');
    assert.equal(compare({ ...ready, probe: 'unavailable' }, played), 'probe-incomplete');
    assert.equal(compare({ ...ready, probe: 'unavailable', error: '153' }, { ...ready, error: '153' }),
        'probe-incomplete');
});

test('keeps corroborating service refusals separate from generic or differing errors', () => {
    const ready = { probe: 'observed', timeline: false, error: 'none', screen: 'none', http: null };
    assert.equal(compare({ ...ready, error: '153' }, { ...ready, error: '153' }), 'same-player-error');
    assert.equal(compare({ ...ready, error: '153' }, { ...ready, error: '150' }), 'neither-played-cause-unresolved');
    assert.equal(compare({ ...ready, screen: 'sign-in-required' }, { ...ready, screen: 'sign-in-required' }),
        'both-requested-sign-in');
    assert.equal(compare({ ...ready, screen: 'other' }, { ...ready, screen: 'other' }),
        'neither-played-cause-unresolved');
    assert.equal(compare({ ...ready, http: 429 }, { ...ready, http: 429 }), 'same-embed-http-error');
});

test('finds the exact Pear panes across browser contexts without choosing ambiguous panes', () => {
    const unrelated = { url: () => 'https://example.test/' };
    const wrapper = { url: () => 'https://com.pear-desktop.rust-preview/iframe-player.html' };
    const controls = { url: () => 'https://pear-queue.app.local/' };
    const contexts = [{ pages: () => [unrelated] }, { pages: () => [wrapper] }, { pages: () => [controls] }];
    assert.deepEqual(pearPages(contexts), { wrapper, controls });
    assert.deepEqual(pearPages([...contexts, { pages: () => [wrapper] }]), { wrapper: null, controls });
});

test('distinguishes missing Pear targets from unattached private targets without returning raw metadata', () => {
    const wrapper = 'https://com.pear-desktop.rust-preview/iframe-player.html';
    const controls = 'https://pear-queue.app.local/';
    assert.deepEqual(pearTargetEvidence([]), { wrapper: 'missing', controls: 'missing' });
    assert.deepEqual(pearTargetEvidence([
        { url: wrapper, type: 'other', browserContextId: 'private-profile', title: 'private-title' },
        { url: controls, type: 'page' },
        { url: wrapper + '?wrong=1', type: 'page' },
    ]), { wrapper: 'other', controls: 'page' });
    assert.deepEqual(pearTargetEvidence([{ url: wrapper, type: 'page' }, { url: wrapper, type: 'page' }]),
        { wrapper: 'ambiguous', controls: 'missing' });
});
