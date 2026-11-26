'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const fixture = 'https://www.youtube.com/embed/M7lc1UVf-VE';
const budget = { connect: 10_000, target: 10_000, click: 8_000, media: 28_000 };
const playButton = '#movie_player button.ytp-large-play-button';

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

async function probe(chromium, port) {
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

        // Use the official visible button from the embedded player.
        const play = page.locator(playButton)
            .and(page.getByRole('button', { name: /^Play(?:\s*\([^)]*\))?$/i }))
            .filter({ visible: true })
            .first();
        stage = 'play-not-actionable';
        await play.waitFor({ state: 'visible', timeout: budget.click });
        const visible = await play.evaluate((button) => button.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
        }));
        if (!visible) return inconclusive('play-not-actionable');
        if (page.url() !== fixture) return inconclusive('target-changed');
        const before = await sample(page);
        if (before.mediaError || before.playerError) return failed('player-error');
        if (!before.present) return inconclusive('media-element-unavailable');
        if (before.paused !== true || before.adActive) {
            return inconclusive('player-not-idle');
        }
        await play.click({ timeout: budget.click });

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
    }, 60_000);
    try {
        const port = Number(process.argv[2]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            console.log('PEAR_WINDOWS_PLAYBACK status=fail reason=invalid-port');
            process.exitCode = 1;
            return;
        }
        const { chromium } = require('playwright-core');
        const { status, reason } = await probe(chromium, port);
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
