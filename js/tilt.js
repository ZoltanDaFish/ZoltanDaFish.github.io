// Tilts each .phone toward the cursor while it is over the phone, and eases back on leave.
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const MAX = 18; // degrees at the phone's edge

  for (const el of document.querySelectorAll('.phone')) {
    el.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.classList.add('tilting');
      el.style.setProperty('--ry', (x * 2 * MAX).toFixed(2) + 'deg');
      el.style.setProperty('--rx', (-y * 2 * MAX).toFixed(2) + 'deg');
    });
    el.addEventListener('pointerleave', () => {
      el.classList.remove('tilting');
      el.style.removeProperty('--ry');
      el.style.removeProperty('--rx');
    });
  }
})();
