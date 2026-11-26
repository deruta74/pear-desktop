'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const wrapper = 'https://com.pear-desktop.rust-preview/iframe-player.html';
const controls = 'https://pear-queue.app.local/';
const embed = new URL('https://www.youtube.com/embed/M7lc1UVf-VE');
const requiredQuery = new URLSearchParams({
    enablejsapi: '1',
    origin: new URL(wrapper).origin,
    autoplay: '0',
});
embed.search = requiredQuery;

function frameUrlStatus(value) {
    if (!value) return 'missing';
    if (value === 'about:blank') return 'blank';
    const url = URL.parse(value);
    if (!url) return 'invalid';
    if (url.origin !== embed.origin) return 'origin';
    if (url.username || url.password || value.includes('#')) return 'decorated';
    if (url.pathname !== embed.pathname) return 'path';
    for (const key of url.searchParams.keys()) {
        if (!requiredQuery.has(key) || url.searchParams.getAll(key).length !== 1) return 'extra-query';
    }
    for (const [key, expected] of requiredQuery) {
        if (url.searchParams.get(key) !== expected) return 'required-query';
    }
    return value === embed.href ? 'exact' : 'normalized';
}

const acceptedUrl = (status) => status === 'exact' || status === 'normalized';

function formatFrameEvidence({ owner, source, attachment, document, wrapperReady }) {
    return `PEAR_WINDOWS_IFRAME_FRAME owner=${owner} src=${source} attachment=${attachment} document=${document} wrapper_ready=${wrapperReady}`;
}

async function waitForOfficialFrame(video, milliseconds = 8_000) {
    const owner = video.locator('iframe#player');
    const frame = owner.contentFrame();
    let evidence;
    let reason;
    const found = await until(milliseconds, async () => {
        const wrapperReady = await video.evaluate(
            () => window.pearIframePlayer?.snapshot()?.ready === true,
        ).catch(() => false);
        evidence = { owner: 'unavailable', source: 'unchecked', attachment: 'unchecked', document: 'unchecked', wrapperReady };
        const count = await owner.count().catch(() => null);
        evidence.owner = count === null ? 'unavailable' : count === 0 ? 'missing' : count === 1 ? 'one' : 'ambiguous';
        if (evidence.owner !== 'one') {
            reason = `iframe-owner-${evidence.owner}`;
            return null;
        }
        evidence.source = await owner.getAttribute('src', { timeout: 650 })
            .then(frameUrlStatus, () => 'unavailable');
        evidence.document = await frame.locator('html').evaluate(
            () => location.href, undefined, { timeout: 650 },
        ).then(frameUrlStatus, () => 'unavailable');
        if (evidence.document === 'unavailable') {
            let element;
            try {
                element = await owner.elementHandle({ timeout: 650 });
                evidence.attachment = await element.contentFrame() ? 'attached' : 'unattached';
            } catch {
                evidence.attachment = 'unavailable';
            } finally {
                if (element) await element.dispose().catch(() => {});
            }
        } else {
            evidence.attachment = 'attached';
        }
        if (!acceptedUrl(evidence.source)) reason = 'iframe-src-mismatch';
        else if (evidence.attachment !== 'attached') reason = 'iframe-attachment-unavailable';
        else if (evidence.document === 'unavailable') reason = 'iframe-document-unavailable';
        else if (!acceptedUrl(evidence.document)) reason = 'iframe-document-mismatch';
        else if (!wrapperReady) reason = 'iframe-wrapper-not-ready';
        else return frame;
        return null;
    });
    return { frame: found, evidence, reason: found ? null : reason };
}

async function until(milliseconds, sample) {
    const deadline = performance.now() + milliseconds;
    do {
        const result = await sample();
        if (result) return result;
        if (performance.now() >= deadline) break;
        await delay(250);
    } while (performance.now() < deadline);
    return null;
}

async function officialPlay(frame) {
    const role = frame.getByRole('button', { name: /^Play(?:\s*\([^)]*\))?$/i });
    return until(8_000, async () => {
        for (const selector of ['.ytp-large-play-button', '.ytp-play-button']) {
            const button = frame.locator(`#movie_player button${selector}`).and(role);
            if (await button.count() !== 1) continue;
            try {
                const candidate = await button.elementHandle({ timeout: 500 });
                const { documentUrl, painted } = await candidate.evaluate((element) => ({
                    documentUrl: location.href,
                    painted: element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
                }));
                if (!painted || !acceptedUrl(frameUrlStatus(documentUrl))) continue;
                await candidate.click({ trial: true, timeout: 700 });
                return candidate;
            } catch {
                // A rerender may replace a button during the actionability check.
            }
        }
        return null;
    });
}

function playerState(panel) {
    return panel.evaluate(() => {
        const timeline = document.getElementById('playback-position');
        const toggle = document.getElementById('play-toggle');
        return {
            position: timeline && !timeline.disabled ? timeline.valueAsNumber : null,
            playing: toggle?.hasAttribute('data-playing') === true,
            paused: Boolean(toggle && !toggle.disabled && toggle.getAttribute('aria-label') === 'Play video'),
        };
    });
}

async function mediaState(media) {
    const { documentUrl, ...sample } = await media.evaluate((element) => ({
        documentUrl: location.href,
        available: element.isConnected &&
            !element.closest('#movie_player.ad-showing, #movie_player.ad-interrupting') &&
            element.readyState >= 2 && !element.seeking && !element.error,
        time: element.currentTime,
        duration: element.duration,
        source: element.currentSrc,
        paused: element.paused,
        ended: element.ended,
    }));
    return { ...sample, available: sample.available && acceptedUrl(frameUrlStatus(documentUrl)) };
}

function healthyMedia(sample) {
    return sample.available && !sample.ended && sample.source &&
        Number.isFinite(sample.time) && Number.isFinite(sample.duration) &&
        sample.time >= 0 && sample.duration - sample.time > 2;
}

async function confirmPause(panel, frame) {
    const media = await frame.locator('#movie_player video.html5-main-video').elementHandle();
    const before = await mediaState(media);
    if (!healthyMedia(before) || before.paused) return ['inconclusive', 'pear-pause-media-unavailable'];

    const pause = panel.getByRole('button', { name: 'Pause video', exact: true });
    await pause.click({ timeout: 2_500 });
    let lastTime = before.time;
    let movingFrom = null;
    let keptAdvancing = false;
    let stationary = null;
    const outcome = await until(6_000, async () => {
        const sample = await mediaState(media);
        if (!healthyMedia(sample) || sample.source !== before.source ||
            sample.duration !== before.duration || sample.time < lastTime - 0.1) {
            return ['inconclusive', 'pear-pause-media-unavailable'];
        }
        lastTime = sample.time;
        if (panel.url() !== controls) return ['inconclusive', 'pear-pause-observation-lost'];
        const ui = await playerState(panel);
        if (!Number.isFinite(ui.position)) {
            stationary = null;
            movingFrom = null;
            keptAdvancing = false;
            return null;
        }
        if (!sample.paused) {
            stationary = null;
            movingFrom ??= sample.time;
            keptAdvancing = sample.time - movingFrom >= 0.75;
            return null;
        }
        movingFrom = null;
        keptAdvancing = false;
        if (!ui.paused) {
            stationary = null;
            return null;
        }
        stationary ??= { time: sample.time, position: ui.position, since: performance.now() };
        if (Math.abs(sample.time - stationary.time) > 0.075 || ui.position !== stationary.position) {
            stationary = null;
            return null;
        }
        return performance.now() - stationary.since >= 1_250
            ? ['pass', 'visible-play-timeline-and-pause']
            : null;
    });
    return outcome ?? (keptAdvancing
        ? ['fail', 'pear-pause-media-kept-advancing']
        : ['inconclusive', 'pear-pause-not-confirmed']);
}

async function run(port) {
    const { chromium } = require('playwright-core');
    let browser;
    let stage = 'connect';
    try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
            timeout: 8_000, noDefaults: true, isLocal: true,
        });
        stage = 'find-panes';
        const panes = await until(8_000, () => {
            const pages = browser.contexts().flatMap((context) => context.pages());
            const video = pages.filter((page) => page.url() === wrapper);
            const panel = pages.filter((page) => page.url() === controls);
            return video.length === 1 && panel.length === 1 && { video: video[0], panel: panel[0] };
        });
        if (!panes) return ['inconclusive', stage];
        const { video, panel } = panes;
        video.setDefaultTimeout(2_500);
        panel.setDefaultTimeout(2_500);
        stage = 'iframe-discovery';
        const { frame, evidence, reason } = await waitForOfficialFrame(video);
        console.log(formatFrameEvidence(evidence));
        if (!frame) return ['inconclusive', reason];
        stage = 'official-play-not-actionable';
        if (!await video.evaluate(() => document.visibilityState === 'visible')) return ['inconclusive', 'video-not-visible'];
        const play = await officialPlay(frame);
        if (!play) return ['inconclusive', stage];
        stage = 'official-play-click';
        const playDocument = await play.evaluate(() => location.href);
        if (!acceptedUrl(frameUrlStatus(playDocument))) return ['inconclusive', 'iframe-document-changed'];
        await play.click({ timeout: 2_500 });

        stage = 'timeline-did-not-advance';
        let first = null;
        const advancing = await until(24_000, async () => {
            const sample = await playerState(panel);
            const ad = await frame.locator('#movie_player.ad-showing, #movie_player.ad-interrupting').count();
            if (ad || !sample.playing || !Number.isFinite(sample.position)) {
                first = null;
                return false;
            }
            if (first === null || sample.position < first) first = sample.position;
            return sample.position >= first + 2;
        });
        if (!advancing) return ['inconclusive', stage];
        stage = 'pear-pause-observation-lost';
        return await confirmPause(panel, frame);
    } catch {
        return ['inconclusive', stage];
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

function report(status, reason) {
    console.log(`PEAR_WINDOWS_IFRAME_PLAYBACK status=${status} reason=${reason}`);
    process.exitCode = status === 'pass' ? 0 : status === 'inconclusive' ? 2 : 1;
}

async function main() {
    const port = Number(process.argv[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return report('fail', 'invalid-port');
    const watchdog = setTimeout(() => {
        report('inconclusive', 'probe-deadline');
        process.exit(2);
    }, 75_000);
    try {
        report(...await run(port));
    } catch {
        report('fail', 'probe-bootstrap');
    } finally {
        clearTimeout(watchdog);
    }
}

if (require.main === module) void main();
module.exports = { frameUrlStatus, waitForOfficialFrame, formatFrameEvidence };
