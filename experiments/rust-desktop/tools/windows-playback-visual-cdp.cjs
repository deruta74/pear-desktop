'use strict';

const { writeSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const wrapper = 'https://com.pear-desktop.rust-preview/iframe-player.html';
const controls = 'https://pear-queue.app.local/';
const embedUrl = new URL('https://www.youtube.com/embed/M7lc1UVf-VE');
embedUrl.search = new URLSearchParams({
    enablejsapi: '1',
    origin: new URL(wrapper).origin,
    autoplay: '0',
});
const embed = embedUrl.href;
const officialPlayName = /^Play(?: video)?(?:\s*\([^)]*\))?$/i;
const playSelector = '#movie_player button.ytp-large-play-button';

function exactDebuggerUrl(value, port) {
    if (typeof value !== 'string') return null;
    const prefix = 'ws://127.0.0.1:' + port + '/devtools/browser/';
    if (!value.startsWith(prefix) || value.length !== prefix.length + 36) return null;
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.slice(prefix.length)) ? value : null;
}

async function until(milliseconds, sample) {
    const deadline = performance.now() + milliseconds;
    do {
        const result = await sample();
        if (result) return result;
        if (performance.now() < deadline) await delay(250);
    } while (performance.now() < deadline);
    return null;
}

async function mediaState(frame) {
    return frame.locator('html').evaluate((_, wanted) => {
        if (location.href !== wanted) return null;
        const movie = document.querySelector('#movie_player');
        const video = movie?.querySelector('video.html5-main-video');
        const playing = Boolean(video && !video.paused && !video.seeking && !video.ended &&
            video.readyState >= 2 && !video.error &&
            !movie.matches('.ad-showing, .ad-interrupting') && Number.isFinite(video.currentTime));
        return { present: Boolean(video), playing, time: playing ? video.currentTime : null };
    }, embed, { timeout: 600 }).catch(() => null);
}

async function run(port, result) {
    const { chromium } = require('playwright-core');
    let browser;
    try {
        result.stage = 'endpoint-metadata';
        const response = await fetch('http://127.0.0.1:' + port + '/json/version', {
            redirect: 'error',
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return;
        const endpoint = exactDebuggerUrl((await response.json()).webSocketDebuggerUrl, port);
        if (!endpoint) return;

        result.stage = 'cdp-connect';
        browser = await chromium.connectOverCDP(endpoint, {
            timeout: 8_000, noDefaults: true, isLocal: true, artifactsDir: __dirname,
        });
        result.stage = 'fixture-panes';
        const video = await until(6_000, () => {
            const pages = browser.contexts().flatMap((context) => context.pages());
            const wrappers = pages.filter((page) => page.url() === wrapper);
            const panels = pages.filter((page) => page.url() === controls);
            return wrappers.length === 1 && panels.length === 1 &&
                pages.every((page) => [wrapper, controls, 'about:blank'].includes(page.url())) ? wrappers[0] : null;
        });
        if (!video) return;
        video.setDefaultTimeout(1_000);

        const owner = video.locator('iframe#player');
        const frame = owner.contentFrame();
        result.stage = 'exact-official-frame';
        const exactFrame = await until(7_000, async () => video.url() === wrapper &&
            await owner.count() === 1 && await owner.getAttribute('src') === embed &&
            await frame.locator('html').evaluate(
                () => location.href, undefined, { timeout: 600 },
            ).catch(() => null) === embed);
        if (!exactFrame) return;

        result.stage = 'wrapper-not-visible';
        if (!await video.locator('html').evaluate(() => document.visibilityState === 'visible' &&
            window.pearIframePlayer?.snapshot()?.ready === true)) return;

        const button = frame.locator(playSelector);
        result.stage = 'official-play-button-missing';
        const candidate = await until(6_000, async () => {
            const count = await button.count();
            if (!count) return null;
            result.stage = count === 1 ? 'official-play-button-unavailable' : 'official-play-button-ambiguous';
            return count === 1 ? button.elementHandle({ timeout: 600 }).catch(() => null) : null;
        });
        if (!candidate) return;
        try {
            const validateButton = () => candidate.evaluate((element, expected) => ({
                fixture: location.href === expected.embed && element.isConnected &&
                    element.matches(expected.selector) && document.visibilityState === 'visible' &&
                    !element.closest('#movie_player.ad-showing, #movie_player.ad-interrupting'),
                named: new RegExp(expected.label, 'i').test(element.getAttribute('aria-label') ?? ''),
                painted: element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
            }), { embed, selector: playSelector, label: officialPlayName.source });
            result.stage = 'official-play-label-mismatch';
            let action = await validateButton();
            if (!action.named) return;
            result.stage = 'official-play-not-actionable';
            if (!action.fixture || !action.painted) return;
            await candidate.click({ trial: true, timeout: 900 });
            result.stage = 'official-play-identity-changed';
            action = await validateButton();
            if (!action.fixture || !action.named || !action.painted || video.url() !== wrapper ||
                await owner.count() !== 1 || await owner.getAttribute('src') !== embed) return;
            result.stage = 'official-play-click';
            await candidate.click({ timeout: 1_500 });
        } finally {
            await candidate.dispose().catch(() => {});
        }

        result.stage = 'clock-signal';
        await writeFile(join(__dirname, 'profile', 'visual-play-clicked'), '', { flag: 'wx' });
        result.stage = 'clicked';
        let firstTime = null;
        let lastTime = null;
        await until(7_000, async () => {
            const sample = await mediaState(frame);
            result.mediaPresent ||= sample?.present ?? false;
            result.mediaPlaying ||= sample?.playing ?? false;
            if (!sample?.playing) {
                firstTime = null;
                lastTime = null;
                return false;
            }
            if (lastTime === null || sample.time < lastTime || sample.time - lastTime > 1.5) firstTime = sample.time;
            lastTime = sample.time;
            result.mediaAdvanced = lastTime - firstTime >= 1.5;
            return result.mediaAdvanced;
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function main() {
    const port = Number(process.argv[2]);
    const result = { stage: 'invalid-port', mediaPresent: false, mediaPlaying: false, mediaAdvanced: false };
    const report = () => writeSync(1, JSON.stringify(result) + '\n');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        report();
        process.exitCode = 2;
        return;
    }
    // Force Playwright's WebSocket connection to use the local endpoint directly.
    process.env.NO_PROXY = '127.0.0.1';
    process.env.no_proxy = '127.0.0.1';
    const watchdog = setTimeout(() => {
        result.stage = 'cdp-deadline';
        report();
        process.exit(2);
    }, 42_000);
    try {
        result.stage = 'probe-bootstrap';
        await run(port, result);
    } catch {
        // Keep the allowlisted stage. Never serialize browser exceptions or page data.
    } finally {
        clearTimeout(watchdog);
    }
    report();
    process.exitCode = result.stage === 'clicked' ? 0 : 2;
}

if (require.main === module) void main();
module.exports = { exactDebuggerUrl, officialPlayName, embed };
