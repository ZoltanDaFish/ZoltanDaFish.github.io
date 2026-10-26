// Night mode toggle: flips data-theme on <html> and remembers the choice. A tiny inline
// script in each page's <head> applies the saved theme before first paint, so there's no flash.
(function () {
  const btn = document.querySelector('.theme');
  if (!btn) return;
  const root = document.documentElement;
  const sync = () => btn.setAttribute('aria-pressed', root.dataset.theme === 'dark');
  sync();
  btn.addEventListener('click', () => {
    const dark = root.dataset.theme !== 'dark';
    if (dark) root.dataset.theme = 'dark'; else delete root.dataset.theme;
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
    sync();
    dispatchEvent(new Event('themechange'));   // js/ascii.js re-reads its colour
  });
})();
