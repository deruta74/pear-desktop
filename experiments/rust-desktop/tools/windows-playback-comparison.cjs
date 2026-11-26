'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const pearOrigin = 'https://com.pear-desktop.rust-preview';
const wrapperUrl = pearOrigin + '/iframe-player.html';
const controlsUrl = 'https://pear-queue.app.local/';
const demoUrl = 'https://developers.google.com/youtube/youtube_player_demo?hl=en';
const demoPath = '/youtube/youtube_player_demo';
const demoOrigins = ['https://developers.google.com', 'https://developers-dot-devsite-v2-prod.appspot.com'];
const youtubeOrigin = 'https://www.youtube.com';
const embedPath = '/embed/M7lc1UVf-VE';
const playLabel = /^Play(?: video)?(?:\s*\([^)]*\))?$/i;

function embedMatches(side, value, parentOrigin) {
    const url = URL.parse(value);
    if (!url || url.origin !== youtubeOrigin || url.pathname !== embedPath ||
        url.username || url.password || value.includes('#')) return false;
    const query = url.searchParams;
    if (query.getAll('enablejsapi').join() !== '1') return false;
    if (side === 'pear') {
        return query.size === 3 && query.getAll('origin').join() === pearOrigin &&
            query.getAll('autoplay').join() === '0';
    }
    return side === 'edge' && demoOrigins.includes(parentOrigin) &&
        query.getAll('origin').join() === parentOrigin &&
        (!query.has('autoplay') || query.getAll('autoplay').join() === '0');
}

function playerError(value) {
    if (value == null) return 'none';
    if (value === -1 || value === '-1') return 'wrapper-error';
    return /^(?:Error: )?(2|5|100|101|150|153)$/.exec(String(value))?.[1] ?? 'unknown';
}

function compare(pear, edge) {
    if (pear.probe !== 'observed' || edge.probe !== 'observed') return 'probe-incomplete';
    if (pear.timeline && edge.timeline) return 'both-played';
    if (edge.timeline) return 'pear-path-did-not-play';
    if (pear.timeline) return 'edge-control-did-not-play';
    if (pear.screen === 'sign-in-required' && edge.screen === pear.screen) return 'both-requested-sign-in';
    if (/^(2|5|100|101|150|153)$/.test(pear.error) && edge.error === pear.error) return 'same-player-error';
    if (pear.http >= 400 && edge.http === pear.http) return 'same-embed-http-error';
    return 'neither-played-cause-unresolved';
}

async function until(ms, sample) {
    const end = performance.now() + ms;
    do {
        const value = await sample();
        if (value) return value;
        await delay(250);
    } while (performance.now() < end);
    return null;
}

function isDemoFrame(frame) {
    const url = URL.parse(frame.url());
    return demoOrigins.includes(url?.origin) &&
        /^(?:\/frame)?\/youtube\/youtube_player_demo_[a-f0-9]{64}\.frame$/.test(url.pathname);
}

async function officialFrame(parent, side) {
    const parentOrigin = URL.parse(parent.url())?.origin;
    const matches = parent.childFrames().filter((frame) => embedMatches(side, frame.url(), parentOrigin));
    const id = side === 'pear' ? 'player' : 'myythtml5player';
    if (matches.length !== 1) return { frame: null, identity: matches.length ? 'ambiguous' : 'missing' };
    const frame = matches[0];
    const owner = await frame.frameElement().catch(() => null);
    if (!owner) return { frame: null, identity: 'missing' };
    try {
        const isOwner = await owner.evaluate((element, expectedId) =>
            element.localName === 'iframe' && element.id === expectedId, id).catch(() => false);
        return isOwner ? { frame, identity: 'exact' } : { frame: null, identity: 'owner-mismatch' };
    } finally {
        await owner.dispose();
    }
}

async function snapshot(parent, side) {
    return parent.locator('html').evaluate((_, input) => {
        if (input === 'pear') {
            const state = window.pearIframePlayer?.snapshot();
            return { ready: state?.ready === true, error: state?.error ?? null, blocked: state?.blocked === true };
        }
        const error = Array.isArray(window.errors) ? window.errors.at(-1) : undefined;
        return {
            ready: typeof window.player?.getPlayerState === 'function',
            error: typeof error === 'string' && /^Error: (2|5|100|101|150|153)$/.test(error)
                ? error : error == null ? null : 'unknown',
            blocked: false,
        };
    }, side, { timeout: 750 }).catch(() => null);
}

async function mediaSnapshot(frame) {
    return frame.locator('html').evaluate(() => {
        const movie = document.querySelector('#movie_player');
        const video = movie?.querySelector('video.html5-main-video') ?? movie?.querySelector('video');
        const visibleError = [...document.querySelectorAll('#error-screen, .ytp-error-content')]
            .find((element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
        const signIn = visibleError && /sign in to confirm (?:that )?you(?:['’]re| are) not a bot/i
            .test(visibleError.textContent.slice(0, 400));
        return {
            visible: document.visibilityState === 'visible',
            player: movie !== null,
            video: video != null,
            readyState: [0, 1, 2, 3, 4].includes(video?.readyState) ? video.readyState : null,
            mediaError: [1, 2, 3, 4].includes(video?.error?.code) ? video.error.code : null,
            time: video && !video.paused && !video.seeking && video.readyState >= 2 && !video.error &&
                !movie.matches('.ad-showing, .ad-interrupting') ? video.currentTime : null,
            screen: signIn ? 'sign-in-required' : visibleError ? 'other' : 'none',
        };
    }, undefined, { timeout: 750 }).catch(() => null);
}

async function officialPlay(frame, result) {
    const controls = frame.locator('#movie_player').getByRole('button', { name: playLabel, includeHidden: true });
    const count = await controls.count().catch(() => null);
    result.control = count === null ? 'unchecked' : count > 4 ? 'ambiguous' : count ? 'hidden' : 'missing';
    if (count === null || count > 4) return null;
    for (let index = 0; index < count; index += 1) {
        const button = await controls.nth(index).elementHandle({ timeout: 500 }).catch(() => null);
        if (!button) continue;
        const painted = await button.evaluate((element) =>
            element.checkVisibility({ opacityProperty: true, visibilityProperty: true })).catch(() => false);
        if (painted) {
            result.control = 'not-actionable';
            if (await button.click({ trial: true, timeout: 600 }).then(() => true, () => false)) return button;
        }
        await button.dispose().catch(() => {});
    }
    return null;
}

function observeEmbedRequests(context, result) {
    const matches = (request) => {
        if (!request.isNavigationRequest()) return false;
        const url = URL.parse(request.url());
        return url?.origin === youtubeOrigin && url.pathname === embedPath;
    };
    context.on('response', (response) => {
        const code = response.status();
        if (!matches(response.request()) || code < 100 || code > 599) return;
        result.http = code;
        result.networkFailure ??= false;
    });
    context.on('requestfailed', (request) => {
        if (matches(request)) result.networkFailure = true;
    });
}

function emptyResult() {
    return {
        probe: 'unavailable', ready: null, frame: 'missing', player: null, video: null, readyState: null,
        error: 'none', mediaError: null, screen: 'none', blocked: false, control: 'unchecked',
        timeline: false, panelTimeline: null, http: null, networkFailure: null,
    };
}

async function observePlayer(side, findParent, panel, result) {
    const first = await until(14_000, async () => {
        const parent = findParent();
        if (!parent) return null;
        result.probe = 'observed';
        const api = await snapshot(parent, side);
        if (api) Object.assign(result, { ready: api.ready, error: playerError(api.error), blocked: api.blocked });
        const { frame, identity } = await officialFrame(parent, side);
        result.frame = identity;
        if (!frame) return null;
        const media = await mediaSnapshot(frame);
        if (media) Object.assign(result, {
            player: media.player, video: media.video, readyState: media.readyState,
            mediaError: media.mediaError, screen: media.screen,
        });
        // Observe a service error or even an absent control without firing any page action.
        if (result.error !== 'none' || result.screen !== 'none') return { frame };
        if (media?.visible !== true) {
            result.control = 'not-visible';
            return null;
        }
        const button = await officialPlay(frame, result);
        return button && { button, frame, parent };
    });
    if (!first?.button) return;
    const parentOrigin = URL.parse(first.parent.url())?.origin;
    try {
        if (!embedMatches(side, first.frame.url(), parentOrigin)) return;
        result.control = 'click-unconfirmed';
        if (!await first.button.click({ timeout: 1500 }).then(() => true, () => false)) return;
        result.control = 'clicked';
    } finally {
        await first.button.dispose().catch(() => {});
    }
    let start = null;
    let panelStart = null;
    if (panel) result.panelTimeline = false;
    await until(20_000, async () => {
        const api = await snapshot(first.parent, side);
        if (api) Object.assign(result, { ready: api.ready, error: playerError(api.error), blocked: api.blocked });
        if (!embedMatches(side, first.frame.url(), parentOrigin)) return true;
        const media = await mediaSnapshot(first.frame);
        if (media) {
            Object.assign(result, {
                player: media.player, video: media.video, readyState: media.readyState,
                mediaError: media.mediaError, screen: media.screen,
            });
            if (Number.isFinite(media.time)) {
                if (start === null || media.time < start) start = media.time;
                if (media.time >= start + 1.5) result.timeline = true;
            }
        }
        if (panel) {
            const time = await panel.locator('#playback-position').evaluate((input) =>
                input.disabled ? null : input.valueAsNumber, undefined, { timeout: 750 }).catch(() => null);
            if (Number.isFinite(time)) {
                if (panelStart === null || time < panelStart) panelStart = time;
                if (time >= panelStart + 2) result.panelTimeline = true;
            }
        }
        return (result.timeline && (!panel || result.panelTimeline)) ||
            result.error !== 'none' || result.screen !== 'none';
    });
}

async function inspectPear(chromium, port, result) {
    if (!port) return;
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {
        timeout: 7000, isLocal: true, noDefaults: true,
    });
    try {
        const context = browser.contexts()[0];
        if (!context) return;
        observeEmbedRequests(context, result);
        const pages = () => context.pages();
        const panel = await until(3000, () => pages().find((page) => page.url() === controlsUrl));
        await observePlayer('pear', () =>
            pages().find((page) => page.url() === wrapperUrl)?.mainFrame(), panel, result);
    } finally {
        await browser.close();
    }
}

async function inspectEdge(chromium, profile, result) {
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'msedge', headless: false, viewport: null, timeout: 12_000,
        ignoreDefaultArgs: true,
        args: ['--remote-debugging-pipe', '--user-data-dir=' + profile, '--inprivate', '--no-first-run', 'about:blank'],
    });
    try {
        const page = context.pages()[0] ?? await context.newPage();
        observeEmbedRequests(context, result);
        await page.goto(demoUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => {});
        await observePlayer('edge', () => {
            const url = URL.parse(page.url());
            if (url?.origin !== demoOrigins[0] || url.pathname !== demoPath) return null;
            const demos = page.frames().filter(isDemoFrame);
            return demos.length === 1 ? demos[0] : null;
        }, null, result);
    } finally {
        await context.close();
    }
}

async function main() {
    const port = Number(process.argv[2]);
    if (!Number.isInteger(port) || port < 0 || port > 65_535 || !process.argv[3]) throw new Error();
    const { chromium } = require('playwright-core');
    const pear = emptyResult();
    const edge = emptyResult();
    await inspectPear(chromium, port, pear).catch(() => { pear.probe = 'unavailable'; });
    await inspectEdge(chromium, process.argv[3], edge).catch(() => { edge.probe = 'unavailable'; });
    console.log('PEAR_WINDOWS_PLAYBACK_COMPARISON ' + JSON.stringify({ pear, edge, result: compare(pear, edge) }));
}

if (require.main === module) {
    const deadline = setTimeout(() => {
        console.log('PEAR_WINDOWS_PLAYBACK_COMPARISON probe-deadline');
        process.exit(1);
    }, 115_000);
    main().catch(() => {
        console.log('PEAR_WINDOWS_PLAYBACK_COMPARISON probe-setup-failed');
        process.exitCode = 1;
    }).finally(() => clearTimeout(deadline));
}

module.exports = { compare, embedMatches, playerError };
