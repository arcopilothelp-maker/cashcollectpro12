// Pricing page: shows the slabs from the server. Buying happens on the main page after sign-in.
(() => {
  const $ = (id) => document.getElementById(id);
  const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let cfg, cat = 'individual';

  function renderPacks() {
    const box = $('packsLanding'); box.textContent = '';
    const ats = cfg.modes.ats?.credits || 12;
    for (const [key, p] of Object.entries(cfg.packs)) {
      if (p.category !== cat) continue;
      const card = el('div', 'pack' + (p.highlight ? ' hot' : ''));
      if (p.highlight) card.append(el('span', 'ribbon', cat === 'individual' ? 'Most popular' : 'Best for teams'));
      card.append(el('h4', null, p.label));
      const price = el('div', 'price'); price.append(el('b', null, rupees(p.amountPaise))); card.append(price);
      card.append(el('p', 'credits', `${p.credits.toLocaleString('en-IN')} AR Credits`));
      card.append(el('p', 'per', `${rupees(Math.round(p.amountPaise / p.credits))} per credit`));
      const ul = el('ul', 'ticks sm'); ul.append(el('li', null, p.note));
      if (p.credits >= ats * 2) ul.append(el('li', null, `or ${Math.floor(p.credits / ats).toLocaleString('en-IN')} resume ATS reports`));
      else if (p.credits < ats) ul.append(el('li', null, `${p.credits} quick questions`));
      card.append(ul);
      const a = el('a', 'btn ' + (p.highlight ? 'btn-primary' : 'btn-dark'), 'Get started');
      a.href = '/?buy=' + encodeURIComponent(key); a.dataset.track = 'cta:buy_' + key.replace(/[^a-z0-9_]/g, '');
      card.append(a); box.append(card);
    }
  }

  function renderModes() {
    const t = $('modesTable'); t.textContent = '';
    const h = t.createTHead().insertRow(); ['Request', 'Credits', 'Free?'].forEach(x => h.append(el('th', null, x)));
    const b = t.createTBody();
    for (const m of Object.values(cfg.modes)) {
      const r = b.insertRow(); r.insertCell().textContent = m.label; r.insertCell().textContent = m.credits; r.insertCell().textContent = m.freeAllowed ? 'Yes' : '–';
    }
  }

  window.addEventListener('load', async () => {
    try { cfg = await (await fetch('/api/config')).json(); } catch { return; }
    document.querySelectorAll('.seg button').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('active', x === btn));
        cat = btn.dataset.cat; renderPacks();
        if (window.ccpTrack) window.ccpTrack('pricing_tab', cat);
      };
    });
    renderPacks(); renderModes();
  });
})();
