import { createRenderer } from '@/utils';

export const renderer = createRenderer<{ release?: () => void }>({
  onPlayerApiReady(api, { ipc }) {
    this.release?.();
    let stopped = false;
    let lastState: boolean | undefined;
    let token: string | null = null;
    let observedPlayer: (Element & Partial<typeof api>) | null = null;
    const report = () => {
      if (stopped) return;
      const player = document.querySelector<Element & Partial<typeof api>>(
        '#movie_player',
      );
      if (player !== observedPlayer) {
        observedPlayer?.removeEventListener?.('onStateChange', report);
        observer.disconnect();
        observedPlayer = player;
        if (player) observer.observe(player, { attributeFilter: ['class'] });
        player?.addEventListener?.('onStateChange', report);
        if (player) {
          replacements.disconnect();
          for (
            let parent = player.parentNode;
            parent;
            parent = parent.parentNode
          )
            replacements.observe(parent, { childList: true });
        }
      }
      let isAd = player?.classList.contains('ad-showing') ?? false;
      if (!isAd && player) {
        try {
          isAd = player.getAdState?.() === 1;
        } catch {
          // The native player may be between media elements.
        }
      }
      if (stopped || !token || isAd === lastState) return;
      lastState = isAd;
      ipc.send('peard:amuse-ad-state', token, isAd);
    };
    const observer = new MutationObserver(report);
    const replacements = new MutationObserver(report);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      replacements.disconnect();
      observedPlayer?.removeEventListener?.('onStateChange', report);
      window.removeEventListener('pagehide', stop);
    };
    this.release = stop;
    window.addEventListener('pagehide', stop);
    report();
    ipc
      .invoke('peard:amuse-player-ready')
      .then((value: unknown) => {
        if (!stopped && typeof value === 'string') {
          token = value;
          report();
        }
      })
      .catch(() => {
        // The backend can stop while the player is initializing.
      });
  },
  stop() {
    this.release?.();
    this.release = undefined;
  },
});
