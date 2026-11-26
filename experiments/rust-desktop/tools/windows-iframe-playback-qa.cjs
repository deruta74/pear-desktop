'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const wrapper = 'https://com.pear-desktop.rust-preview/iframe-player.html';
const controls = 'https://pear-queue.app.local/';
const embed = new URL('https://www.youtube.com/embed/M7lc1UVf-VE');
embed.search = new URLSearchParams({
    enablejsapi: '1',
    origin: new URL(wrapper).origin,
    autoplay: '0',
});

async function until(milliseconds, sample) {
    const deadline = performance.now() + milliseconds;
    do {
        const result = await sample();
        if (result) return result;
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
                const painted = await button.evaluate(
                    (element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
                    undefined,
                    { timeout: 500 },
                );
                if (!painted) continue;
                await button.click({ trial: true, timeout: 700 });
                return button;
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
        stage = 'exact-official-frame';
        const frame = video.locator('iframe#player').contentFrame();
        const source = await video.locator('iframe#player').getAttribute('src');
        if (source !== embed.href || !video.frames().some((child) => child.url() === embed.href)) {
            return ['inconclusive', stage];
        }
        stage = 'official-play-not-actionable';
        if (!await video.evaluate(() => document.visibilityState === 'visible')) return ['inconclusive', 'video-not-visible'];
        const play = await officialPlay(frame);
        if (!play) return ['inconclusive', stage];
        stage = 'official-play-click';
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
        stage = 'pear-pause-click';
        const pause = panel.getByRole('button', { name: 'Pause video', exact: true });
        await pause.click({ timeout: 2_500 });
        stage = 'pear-pause-not-confirmed';
        const paused = await until(6_000, async () => {
            const sample = await playerState(panel);
            return sample.paused && Number.isFinite(sample.position) && sample;
        });
        if (!paused) return ['fail', stage];
        await delay(1_250);
        const settled = await playerState(panel);
        return settled.paused && settled.position === paused.position
            ? ['pass', 'visible-play-timeline-and-pause']
            : ['fail', stage];
    } catch {
        return [stage.startsWith('pear-pause') ? 'fail' : 'inconclusive', stage];
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
    }, 65_000);
    try {
        report(...await run(port));
    } catch {
        report('fail', 'probe-bootstrap');
    } finally {
        clearTimeout(watchdog);
    }
}

void main();
