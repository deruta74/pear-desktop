'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { frameUrlStatus, waitForOfficialFrame, formatFrameEvidence } = require('./windows-iframe-playback-qa.cjs');

const site = 'https://www.youtube.com/embed/M7lc1UVf-VE';
const origin = 'https%3A%2F%2Fcom.pear-desktop.rust-preview';
const exact = `${site}?enablejsapi=1&origin=${origin}&autoplay=0`;
const normalized = `${site.replace('.com/', '.com:443/')}?autoplay=0&origin=${origin.toLowerCase()}&enablejsapi=%31`;

test('validates the fixture origin, path, and complete query, allowing URL serialization differences', () => {
    for (const [value, expected] of [
        [exact, 'exact'],
        [normalized, 'normalized'],
        [null, 'missing'],
        ['about:blank', 'blank'],
        ['not a URL', 'invalid'],
        [exact.replace('www.youtube.com', 'other.test'), 'origin'],
        [exact.replace('https://', 'http://'), 'origin'],
        [exact.replace('.com/', '.com:444/'), 'origin'],
        [exact.replace('www.youtube.com', 'user@www.youtube.com'), 'decorated'],
        [`${exact}#`, 'decorated'],
        [exact.replace('M7lc1UVf-VE', 'dQw4w9WgXcQ'), 'path'],
        [exact.replace('autoplay=0', 'autoplay=1'), 'required-query'],
        [exact.replace('&autoplay=0', ''), 'required-query'],
        [`${exact}&autoplay=0`, 'extra-query'],
        [`${exact}&private=DO_NOT_PRINT`, 'extra-query'],
    ]) {
        assert.equal(frameUrlStatus(value), expected);
    }
});

function mockVideo({ count = 1, source = exact, document = normalized, attached = true, ready = true } = {}) {
    const frame = { locator: () => ({
        evaluate: async () => {
            if (document instanceof Error) throw document;
            return document;
        },
    }) };
    const owner = {
        count: async () => count,
        getAttribute: async () => source,
        contentFrame: () => frame,
        elementHandle: async () => ({
            contentFrame: async () => {
                if (attached instanceof Error) throw attached;
                return attached ? frame : null;
            },
            dispose: async () => {},
        }),
    };
    return { frame, video: { evaluate: async () => ready, locator: () => owner } };
}

test('uses the selected iframe owner and probes the actual document without relying on page.frames()', async () => {
    const { video, frame } = mockVideo();
    const result = await waitForOfficialFrame(video, 0);
    assert.equal(result.frame, frame);
    assert.equal(
        formatFrameEvidence(result.evidence),
        'PEAR_WINDOWS_IFRAME_FRAME owner=one src=exact attachment=attached document=normalized wrapper_ready=true',
    );
});

test('distinguishes rejected src, unavailable CDP attachment, unrelated documents, and wrapper readiness', async () => {
    for (const [options, reason, evidence] of [
        [{ count: 2 }, 'iframe-owner-ambiguous', 'owner=ambiguous src=unchecked attachment=unchecked document=unchecked wrapper_ready=true'],
        [{ source: `${exact}&private=DO_NOT_PRINT` }, 'iframe-src-mismatch', 'owner=one src=extra-query attachment=attached document=normalized wrapper_ready=true'],
        [{ document: new Error('DO_NOT_PRINT'), attached: false }, 'iframe-attachment-unavailable', 'owner=one src=exact attachment=unattached document=unavailable wrapper_ready=true'],
        [{ document: new Error('DO_NOT_PRINT'), attached: new Error('DO_NOT_PRINT') }, 'iframe-attachment-unavailable', 'owner=one src=exact attachment=unavailable document=unavailable wrapper_ready=true'],
        [{ document: new Error('DO_NOT_PRINT') }, 'iframe-document-unavailable', 'owner=one src=exact attachment=attached document=unavailable wrapper_ready=true'],
        [{ document: 'about:blank' }, 'iframe-document-mismatch', 'owner=one src=exact attachment=attached document=blank wrapper_ready=true'],
        [{ document: exact.replace('www.youtube.com', 'evil.test') }, 'iframe-document-mismatch', 'owner=one src=exact attachment=attached document=origin wrapper_ready=true'],
        [{ ready: false }, 'iframe-wrapper-not-ready', 'owner=one src=exact attachment=attached document=normalized wrapper_ready=false'],
    ]) {
        const result = await waitForOfficialFrame(mockVideo(options).video, 0);
        assert.equal(result.frame, null);
        assert.equal(result.reason, reason);
        assert.equal(formatFrameEvidence(result.evidence), `PEAR_WINDOWS_IFRAME_FRAME ${evidence}`);
    }
});

test('waits for an unattached matching iframe to become evaluable', async () => {
    const { video, frame } = mockVideo();
    const original = frame.locator;
    let attempts = 0;
    frame.locator = (...args) => {
        if (++attempts === 1) return { evaluate: async () => { throw Error('frame is attaching'); } };
        return original(...args);
    };
    const result = await waitForOfficialFrame(video, 1_000);
    assert.equal(result.frame, frame);
    assert.equal(attempts, 2);
});
