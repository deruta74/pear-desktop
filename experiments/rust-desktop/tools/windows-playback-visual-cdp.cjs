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
// Match the preflight screenshot dimensions/glyph and the pinned app's left video pane layout.
const nativeClient = { width: 1028, height: 680, glyphX: 321, glyphY: 340, queueWidth: 384 };

function exactDebuggerUrl(value, port) {
    if (typeof value !== 'string') return null;
    const prefix = 'ws://127.0.0.1:' + port + '/devtools/browser/';
    if (!value.startsWith(prefix) || value.length !== prefix.length + 36) return null;
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.slice(prefix.length)) ? value : null;
}

function glyphAlignedCenter(rect, viewport) {
    const { left, top, width, height } = rect;
    const { dpr, scale, offsetLeft, offsetTop, visualWidth, visualHeight } = viewport;
    if (![left, top, width, height, dpr, viewport.width, viewport.height,
        visualWidth, visualHeight].every(Number.isFinite) || width <= 0 || height <= 0 || dpr <= 0 ||
        scale !== 1 || offsetLeft !== 0 || offsetTop !== 0 || left !== 0 || top !== 0 ||
        Math.abs(width - viewport.width) > 1 || Math.abs(height - viewport.height) > 1 ||
        Math.abs(width - visualWidth) > 1 || Math.abs(height - visualHeight) > 1) return null;

    const x = left + width / 2;
    const y = top + height / 2;
    if (x <= 0 || y <= 0 || x >= visualWidth || y >= visualHeight ||
        Math.abs((width + nativeClient.queueWidth) * dpr - nativeClient.width) > 2 ||
        Math.abs(height * dpr - nativeClient.height) > 2 ||
        Math.abs(x * dpr - nativeClient.glyphX) > 2 || Math.abs(y * dpr - nativeClient.glyphY) > 2) return null;
    return { x, y };
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
        const error = video?.error;
        const errorCode = error?.code;
        const readyState = video?.readyState;
        const networkState = video?.networkState;
        const playing = Boolean(video && !video.paused && !video.seeking && !video.ended &&
            readyState >= 2 && !error &&
            !movie.matches('.ad-showing, .ad-interrupting') && Number.isFinite(video.currentTime));
        return {
            present: Boolean(video), playing, time: playing ? video.currentTime : null,
            mediaErrorCode: error === null ? 0 : [1, 2, 3, 4].includes(errorCode) ? errorCode : null,
            mediaReadyState: [0, 1, 2, 3, 4].includes(readyState) ? readyState : null,
            mediaNetworkState: [0, 1, 2, 3].includes(networkState) ? networkState : null,
        };
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

        result.stage = 'iframe-geometry-mismatch';
        const geometry = await owner.evaluate((iframe, expected) => {
            const visual = window.visualViewport;
            if (window.self !== window.top || location.href !== expected.wrapper || document.visibilityState !== 'visible' ||
                !iframe.isConnected || iframe.getAttribute('src') !== expected.embed || !visual ||
                !iframe.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;

            const { left, top, width, height } = iframe.getBoundingClientRect();
            if (document.elementFromPoint(left + width / 2, top + height / 2) !== iframe) return null;
            return {
                rect: { left, top, width, height },
                viewport: {
                    width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visual.scale,
                    visualWidth: visual.width, visualHeight: visual.height,
                    offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop,
                },
            };
        }, { wrapper, embed });
        if (!geometry) return;
        const center = glyphAlignedCenter(geometry.rect, geometry.viewport);
        if (!center) return;

        result.stage = 'iframe-target-mismatch';
        const targetVisible = await frame.locator('html').evaluate(
            (_, expected) => location.href === expected.embed && document.visibilityState === 'visible' &&
                Math.abs(innerWidth - expected.width) <= 1 && Math.abs(innerHeight - expected.height) <= 1 &&
                document.elementFromPoint(innerWidth / 2, innerHeight / 2) !== null,
            { embed, width: geometry.rect.width, height: geometry.rect.height }, { timeout: 600 },
        );
        if (!targetVisible || video.url() !== wrapper) return;

        result.stage = 'iframe-center-click';
        await video.mouse.click(center.x, center.y);

        result.stage = 'clock-signal';
        await writeFile(join(__dirname, 'profile', 'visual-play-clicked'), '', { flag: 'wx' });
        result.stage = 'clicked';
        let firstTime = null;
        let lastTime = null;
        await until(7_000, async () => {
            const sample = await mediaState(frame);
            result.mediaPresent ||= sample?.present ?? false;
            result.mediaPlaying ||= sample?.playing ?? false;
            if (sample?.present) {
                result.mediaErrorCode = sample.mediaErrorCode;
                result.mediaReadyState = sample.mediaReadyState;
                result.mediaNetworkState = sample.mediaNetworkState;
            }
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
    const result = {
        stage: 'invalid-port', mediaPresent: false, mediaPlaying: false, mediaAdvanced: false,
        mediaErrorCode: null, mediaReadyState: null, mediaNetworkState: null,
    };
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
module.exports = { exactDebuggerUrl, glyphAlignedCenter, embed };
