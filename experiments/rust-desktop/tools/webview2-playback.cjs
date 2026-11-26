'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const fixture = 'https://www.youtube.com/embed/M7lc1UVf-VE';
const budget = { connect: 10_000, target: 10_000, click: 8_000, media: 28_000 };
const playButtons = [
    '#movie_player button.ytp-large-play-button',
    '#movie_player button.ytp-play-button',
];

const inconclusive = (reason) => ({ status: 'inconclusive', reason });
const failed = (reason) => ({ status: 'fail', reason });

async function sample(page) {
    return page.evaluate(() => {
        const player = document.getElementById('movie_player');
        const video = player?.querySelector('video.html5-main-video');
        const error = player?.querySelector('.ytp-error-content-wrap, .ytp-error-content');
        const bounds = error?.getBoundingClientRect();
        const playerError = Boolean(bounds?.width && bounds?.height && getComputedStyle(error).visibility === 'visible');
        return {
            present: Boolean(video),
            currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
            paused: video?.paused ?? null,
            readyState: video?.readyState ?? 0,
            mediaError: Boolean(video?.error),
            playerError,
            adActive: Boolean(player?.matches('.ad-showing, .ad-interrupting')),
        };
    });
}

async function playbackSurface(page) {
    return page.evaluate((selectors) => {
        const viewport = innerWidth > 0 && innerHeight > 0;
        const player = Boolean(document.getElementById('movie_player'));
        return {
            visible: document.visibilityState === 'visible',
            viewport,
            player,
            center: Boolean(document.querySelector(selectors[0])),
            toolbar: Boolean(document.querySelector(selectors[1])),
        };
    }, playButtons);
}

function isPaintedInViewport(locator) {
    return locator.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        return document.visibilityState === 'visible' && bounds.width > 0 && bounds.height > 0 &&
            x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
            button.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }, undefined, { timeout: 500 });
}

async function choosePlayButton(page) {
    const name = page.getByRole('button', { name: /^Play(?:\s*\([^)]*\))?$/i });
    const candidates = playButtons.map((selector) => page.locator(selector).and(name));
    const deadline = performance.now() + budget.click;
    let reason = 'play-control-missing';
    let hovered = false;
    while (performance.now() < deadline) {
        if (page.url() !== fixture) return { reason: 'target-changed' };
        for (const candidate of candidates) {
            if (await candidate.count() !== 1) continue;
            if (reason !== 'play-trial-rejected') reason = 'play-control-hidden';
            try {
                if (!await isPaintedInViewport(candidate)) continue;
                reason = 'play-trial-rejected';
                await candidate.click({ trial: true, timeout: 700 });
                return { button: candidate };
            } catch {
                // The probe can try another candidate before issuing any real click.
            }
        }
        if (!hovered) {
            const player = page.locator('#movie_player');
            if (await player.isVisible()) {
                hovered = true;
                // A normal hover can reveal the official player toolbar.
                await player.hover({ timeout: 700 }).catch(() => {});
            }
        }
        await delay(200);
    }
    return { reason };
}

async function fixturePage(browser) {
    const deadline = performance.now() + budget.target;
    while (performance.now() < deadline) {
        const targets = browser.contexts().flatMap((context) => context.pages());
        const matches = targets.filter((page) => page.url() === fixture);
        if (matches.length > 1) return null;
        if (matches.length === 1) return matches[0];
        await delay(200);
    }
    return null;
}

async function observePlayback(page) {
    const deadline = performance.now() + budget.media;
    let firstTime = null;
    let lastTime = null;
    let lastAd = false;
    while (performance.now() < deadline) {
        if (page.url() !== fixture) return inconclusive('target-changed');
        const state = await sample(page);
        if (state.mediaError || state.playerError) return failed('player-error');
        lastAd = state.adActive;
        if (lastAd || state.paused || state.readyState < 2 || !Number.isFinite(state.currentTime)) {
            firstTime = null;
            lastTime = null;
        } else {
            if (lastTime === null || state.currentTime < lastTime) firstTime = state.currentTime;
            const advanced = state.currentTime - firstTime;
            if (state.currentTime > lastTime && advanced >= 0.75) {
                return { status: 'pass', reason: 'media-advanced' };
            }
            lastTime = state.currentTime;
        }
        await delay(250);
    }
    return inconclusive(lastAd ? 'ad-still-playing' : 'media-did-not-advance');
}

async function probe(chromium, port, windowOnscreen, reportSurface = () => {}) {
    let browser;
    let stage = 'cdp-unavailable';
    try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
            timeout: budget.connect,
            noDefaults: true,
            isLocal: true,
        });
        stage = 'target-unavailable';
        const page = await fixturePage(browser);
        if (!page) return inconclusive(stage);
        page.setDefaultTimeout(budget.click);

        stage = 'surface-unavailable';
        let surface = await playbackSurface(page);
        const visibleDeadline = performance.now() + 2_000;
        while (windowOnscreen && (!surface.visible || !surface.viewport) && performance.now() < visibleDeadline) {
            await delay(200);
            if (page.url() !== fixture) return inconclusive('target-changed');
            surface = await playbackSurface(page);
        }
        if (!windowOnscreen || !surface.visible || !surface.viewport) {
            reportSurface(surface);
            return inconclusive(windowOnscreen ? 'page-not-visible' : 'native-window-unavailable');
        }

        stage = 'play-controls-unavailable';
        const { button, reason } = await choosePlayButton(page);
        if (page.url() !== fixture) return inconclusive('target-changed');
        reportSurface(await playbackSurface(page));
        const before = await sample(page);
        if (before.mediaError || before.playerError) return failed('player-error');
        if (!button) return inconclusive(reason);
        if (!before.present) return inconclusive('media-element-unavailable');
        if (before.paused !== true || before.adActive) return inconclusive('player-not-idle');

        stage = 'play-control-hidden';
        if (!await isPaintedInViewport(button)) return inconclusive(stage);

        // Issue one real click. A timeout after dispatch can be ambiguous.
        stage = 'play-click-rejected';
        await button.click({ timeout: budget.click });

        stage = 'sample-unavailable';
        return await observePlayback(page);
    } catch {
        return inconclusive(stage);
    } finally {
        // Close the CDP connection. The native runner wrapper owns the app process.
        if (browser) await browser.close().catch(() => {});
    }
}

async function main() {
    const watchdog = setTimeout(() => {
        console.log('PEAR_WINDOWS_PLAYBACK status=inconclusive reason=probe-deadline');
        process.exit(2);
    }, 70_000);
    try {
        const port = Number(process.argv[2]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            console.log('PEAR_WINDOWS_PLAYBACK status=fail reason=invalid-port');
            process.exitCode = 1;
            return;
        }
        const { chromium } = require('playwright-core');
        const { status, reason } = await probe(chromium, port, process.argv[3] === 'onscreen', (surface) => {
            const flag = (key) => surface[key] === true;
            console.log(`PEAR_WINDOWS_PLAYBACK_DOM visible=${flag('visible')} viewport=${flag('viewport')} player=${flag('player')} center=${flag('center')} toolbar=${flag('toolbar')}`);
        });
        console.log(`PEAR_WINDOWS_PLAYBACK status=${status} reason=${reason}`);
        process.exitCode = status === 'pass' ? 0 : status === 'inconclusive' ? 2 : 1;
    } catch {
        console.log('PEAR_WINDOWS_PLAYBACK status=fail reason=probe-bootstrap');
        process.exitCode = 1;
    } finally {
        clearTimeout(watchdog);
    }
}

if (require.main === module) void main();
module.exports = { probe };
