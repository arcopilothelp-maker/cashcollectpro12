// Privacy-friendly visit counter. No cookies, no personal data, nothing stored in the browser.
// Sends only event names like "section_view: courses" so the owner can see what people use.
(() => {
  const queue = [];
  let timer;
  function flush() {
    if (!queue.length) return;
    const body = JSON.stringify({ events: queue.splice(0, 20), ref: document.referrer || '' });
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/track', blob))) {
        fetch('/api/track', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
      }
    } catch {}
  }
  function track(m, l) {
    queue.push({ m, l: String(l ?? '') });
    clearTimeout(timer);
    timer = setTimeout(flush, queue.length >= 10 ? 0 : 1500);
  }
  window.ccpTrack = track;

  // respect "Do Not Track" / Global Privacy Control
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) { window.ccpTrack = () => {}; return; }

  track('page_view', location.pathname.toLowerCase().replace(/\.html$/, '') || '/');

  // which sections people actually read (counted once per visit, after 1.5 s on screen)
  window.addEventListener('load', () => {
    const seen = new Set(); const timers = new Map();
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.id;
        if (e.isIntersecting && !seen.has(id)) {
          timers.set(id, setTimeout(() => { seen.add(id); track('section_view', id); io.unobserve(e.target); }, 1500));
        } else clearTimeout(timers.get(id));
      }
    }, { threshold: 0.35 });
    document.querySelectorAll('section[id], main[id]').forEach((s) => { if (s.id !== 'app' && s.id !== 'landing') io.observe(s); });
  });

  // clicks on anything marked data-track="kind:label"
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-track]');
    if (!el) return;
    const [m, l] = el.dataset.track.split(':');
    track(m, l);
    if (el.tagName === 'A' && /^(https?:|mailto:)/.test(el.getAttribute('href') || '')) flush();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
})();
