// Night mode toggle: flips data-theme on <html> and remembers the choice. A tiny inline
// script in each page's <head> applies the saved theme before first paint, so there's no flash.
// The switch spreads out from the button as a wave (a view transition masked to a growing
// circle, see style.css); js/ascii.js hears 'themewave' and draws the wavefront in ASCII.
(function () {
  const btn = document.querySelector('.theme');
  if (!btn) return;
  const root = document.documentElement;
  const SOFT = 90;     // CSS px over which the old theme fades into the new one
  const SPEED = 1000;  // ms for the wave to cross the screen
  const sync = () => btn.setAttribute('aria-pressed', root.dataset.theme === 'dark');
  const bg = () => getComputedStyle(root).getPropertyValue('--bg').trim();
  sync();
  btn.addEventListener('click', () => {
    const dark = root.dataset.theme !== 'dark';
    const apply = () => {
      if (dark) root.dataset.theme = 'dark'; else delete root.dataset.theme;
      try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
      sync();
      dispatchEvent(new Event('themechange'));   // js/ascii.js re-reads its colour
    };
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }

    const b = btn.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
    // far enough that the soft edge, and the ragged ASCII band on it, have left the farthest corner when it ends
    const R = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + SOFT * 2.5;
    root.style.setProperty('--wave-x', x + 'px');
    root.style.setProperty('--wave-y', y + 'px');
    root.style.setProperty('--wave-soft', SOFT + 'px');
    const from = bg();
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      const anim = root.animate({ '--wave': ['0px', R + 'px'] },
        // fill: the transition lasts a frame past the animation, and --wave falling back to 0px
        // there would flash the old theme
        { duration: SPEED, easing: 'cubic-bezier(.3, 0, .7, 1)', fill: 'forwards', pseudoElement: '::view-transition-new(root)' });
      dispatchEvent(new CustomEvent('themewave', { detail: { x, y, R, soft: SOFT, anim, from, to: bg() } }));
    }, () => {});
  });
})();
