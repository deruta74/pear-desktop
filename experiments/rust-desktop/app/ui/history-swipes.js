'use strict';

// Adapted from src/plugins/navigation/gestures.ts (4748a281, d6fec654).
const panelSwipeQuietPeriod = 600;
const panelSwipeReversalQuietPeriod = 40;
const panelSwipeDistance = 180;
const panelSwipeAxisRatio = 1.8;
const panelSwipeProtected = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="slider"]',
  '[role="textbox"]',
  '[role="spinbutton"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[data-no-history-swipe]',
  '.selection',
  '.queue-items',
].join(',');

function attachPanelHistorySwipes(panel, panelVisible, traverse) {
  const available = () =>
    panelVisible() &&
    document.hasFocus() &&
    !document.activeElement?.closest(panelSwipeProtected);

  const allowedTarget = (event) => {
    const path = event.composedPath();
    if (!path.includes(panel)) return false;
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.matches(panelSwipeProtected)) return false;
      const style = getComputedStyle(node);
      if (['contain', 'none'].includes(style.overscrollBehaviorX)) return false;
      if (
        (node.scrollWidth > node.clientWidth + 1 &&
          ['auto', 'scroll', 'hidden'].includes(style.overflowX)) ||
        (node !== document.scrollingElement &&
          node.scrollHeight > node.clientHeight + 1 &&
          ['auto', 'scroll'].includes(style.overflowY))
      )
        return false;
    }
    return true;
  };

  let last = -Infinity;
  let x = 0;
  let y = 0;
  let samples = 0;
  let opposite = 0;
  let sign = 0;
  let locked = false;
  let committed = null;
  let reversal = null;
  let reversalSamples = 0;
  let lockedVertical = 0;
  let pending;
  let queue = [];

  function lock() {
    locked = true;
    committed = reversal = null;
    reversalSamples = lockedVertical = 0;
  }

  function reset() {
    x = y = samples = opposite = sign = 0;
    lock();
    locked = false;
  }

  function interrupt() {
    clearTimeout(pending);
    pending = undefined;
    queue = [];
    lock();
    last = performance.now();
  }

  function consume({ event, time, allowed }) {
    const gap = time - last;
    if (gap > panelSwipeQuietPeriod) reset();
    last = time;
    if (!allowed || event.defaultPrevented || !available()) {
      lock();
      return;
    }
    const { deltaX, deltaY } = event;
    const direction = Math.sign(deltaX);
    if (locked) {
      if (
        Math.abs(deltaX) >= 2 &&
        Math.abs(deltaX) >= Math.abs(deltaY) * panelSwipeAxisRatio
      )
        lockedVertical = 0;
      else lockedVertical += Math.abs(deltaY);
      if (lockedVertical >= 12) committed = null;
      if (
        !committed ||
        gap <= panelSwipeReversalQuietPeriod ||
        !direction ||
        direction === committed.direction
      )
        return;
      if (!committed.canReverse()) {
        lock();
        return;
      }
      const previous = committed;
      reset();
      reversal = previous;
    }
    if (reversal && !reversal.canReverse()) {
      lock();
      return;
    }
    x += deltaX;
    y += Math.abs(deltaY);
    if (reversal && direction !== reversal.direction && Math.abs(deltaX) >= 12)
      reversalSamples++;
    if (Math.abs(deltaX) >= 2) {
      samples++;
      sign ||= direction;
      if (direction !== sign) opposite += Math.abs(deltaX);
    }
    if ((y >= 12 && Math.abs(x) < y * panelSwipeAxisRatio) || opposite > 32) {
      lock();
      return;
    }
    if (
      samples >= 2 &&
      Math.abs(x) >= panelSwipeDistance &&
      Math.abs(x) > y * panelSwipeAxisRatio
    ) {
      const step = Math.sign(x);
      if (reversal && (reversalSamples < 2 || step === reversal.direction))
        return;
      lock();
      const canReverse = traverse(step);
      if (canReverse) committed = { direction: step, canReverse };
    }
  }

  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.isTrusted) return;
      if (queue.length >= 32) {
        interrupt();
        return;
      }
      queue.push({
        event,
        time: performance.now(),
        allowed:
          event.deltaMode === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.altKey &&
          Number.isFinite(event.deltaX) &&
          Number.isFinite(event.deltaY) &&
          available() &&
          allowedTarget(event),
      });
      // Give the control under the pointer the rest of the event dispatch.
      if (pending === undefined) {
        pending = setTimeout(() => {
          pending = undefined;
          const batch = queue;
          queue = [];
          for (const sample of batch) consume(sample);
        }, 0);
      }
    },
    { passive: true },
  );
  for (const event of ['blur', 'pagehide', 'pointerdown'])
    window.addEventListener(event, interrupt);
  document.addEventListener('visibilitychange', interrupt);
  document.addEventListener('focusin', () => {
    if (!available()) interrupt();
  });
  return interrupt;
}
