(function () {
  'use strict';

  const processed = new Set();
  let lastUrl = location.href;

  // ── Read IAAI page data ────────────────────────────────────────────────────

  function isToyota() {
    return /toyota/i.test(document.querySelector('h1')?.textContent || document.title);
  }

  // IAAI uses .data-list__label / .data-list__value pairs
  function getLabelValue(labelText) {
    for (const label of document.querySelectorAll('.data-list__label')) {
      if (new RegExp(labelText, 'i').test(label.textContent)) {
        const sib = label.nextElementSibling;
        if (sib) return sib.textContent.trim();
      }
    }
    return null;
  }

  function getStockNumber() {
    const val = getLabelValue('Stock\\s*#');
    return val?.match(/\d{7,9}/)?.[0] || null;
  }

  function getPartialVIN() {
    // IAAI exposes partial VIN in #VIN_WalkThruVideoModal
    const el = document.getElementById('VIN_WalkThruVideoModal');
    if (el) return el.textContent.trim().replace(/[^A-HJ-NPR-Z0-9*]/gi, '').substring(0, 11);
    const val = getLabelValue('VIN');
    return val?.replace(/[^A-HJ-NPR-Z0-9*]/gi, '').substring(0, 11) || null;
  }

  function isDetailPage() {
    return /vehicledetail/i.test(location.pathname);
  }

  // ── Button ─────────────────────────────────────────────────────────────────

  function makeButton(stock) {
    const btn = document.createElement('button');
    btn.className = 'itl-btn';
    btn.textContent = '🔍 Toyota Specs';
    btn.dataset.stock = stock;
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      doLookup(stock, btn);
    });
    return btn;
  }

  // ── Panel ──────────────────────────────────────────────────────────────────

  function removePanel() { document.querySelector('.itl-panel')?.remove(); }

  function showLoading(anchor) {
    removePanel();
    const p = mkPanel(`
      <div class="itl-head">Toyota Specs Lookup <button class="itl-close">✕</button></div>
      <div class="itl-body itl-center">
        <div class="itl-spinner"></div>
        <div class="itl-status">Fetching VIN from SCA Auction + Toyota specs…<br>
          <small style="opacity:.7">(Both sites require you to be logged in)</small></div>
      </div>`);
    place(p, anchor);
    p.querySelector('.itl-close').onclick = removePanel;
    document.body.appendChild(p);
    return p;
  }

  function showResult(resp, anchor) {
    removePanel();
    let body = '';

    if (!resp.success) {
      body = `<div class="itl-error">${esc(resp.error)}</div>`;
    } else {
      const { vin, specs } = resp.data;
      body += `
        <div class="itl-vin-row">
          <span class="itl-label">Full VIN</span>
          <span class="itl-vin">${esc(vin)}</span>
          <button class="itl-copy" data-val="${esc(vin)}">Copy</button>
        </div>`;
      body += specs?.error
        ? `<div class="itl-error">${esc(specs.error)}</div>`
        : renderSpecs(specs);
    }

    const p = mkPanel(`
      <div class="itl-head">Toyota Factory Specs <button class="itl-close">✕</button></div>
      <div class="itl-body">${body}</div>`);

    p.querySelector('.itl-close').onclick = removePanel;
    p.querySelector('.itl-copy')?.addEventListener('click', function () {
      navigator.clipboard.writeText(this.dataset.val);
      this.textContent = 'Copied!';
      setTimeout(() => (this.textContent = 'Copy'), 2000);
    });

    place(p, anchor);
    document.body.appendChild(p);

    setTimeout(() => {
      document.addEventListener('click', function outside(e) {
        if (!p.contains(e.target)) { p.remove(); document.removeEventListener('click', outside); }
      });
    }, 50);
  }

  function renderSpecs(specs) {
    if (!specs) return '<div class="itl-note">Toyota spec lookup returned no data.</div>';
    let html = '';
    if (specs.basics?.length)  html += section('Grade & Drive Train', specs.basics);
    if (specs.options?.length) html += section('Factory Options', specs.options);
    if (!html) html = `<div class="itl-note">No spec data found.<br>
      Try visiting <a href="https://www.toyota.com/owners/vehicle-specification/" target="_blank">toyota.com/owners/vehicle-specification</a> with the VIN above.</div>`;
    return html;
  }

  function section(title, items) {
    return `<div class="itl-section">
      <div class="itl-sec-title">${esc(title)}</div>
      <ul class="itl-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
    </div>`;
  }

  function mkPanel(html) {
    const p = document.createElement('div');
    p.className = 'itl-panel';
    p.innerHTML = html;
    return p;
  }

  function place(panel, anchor) {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    panel.style.top  = (window.scrollY + r.bottom + 6) + 'px';
    panel.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 430)) + 'px';
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  async function doLookup(stock, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const panel = showLoading(btn);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'LOOKUP_SPECS', stockNumber: stock });
      showResult(resp, btn);
    } catch (err) {
      const msg = /context invalidated/i.test(err.message)
        ? 'Extension was reloaded — please refresh this IAAI page and try again.'
        : err.message;
      showResult({ success: false, error: msg }, btn);
    } finally {
      btn.disabled = false;
    }
  }

  // ── IAAI page handlers ────────────────────────────────────────────────────

  function handleDetailPage() {
    if (!isToyota()) return;

    const stock = getStockNumber();
    if (!stock || processed.has('detail-' + stock)) return;
    processed.add('detail-' + stock);

    // Find the h1 heading to attach the button
    const anchor = document.querySelector('h1') || document.body;
    if (anchor.querySelector('.itl-btn')) return;
    anchor.appendChild(makeButton(stock));
  }

  function handleListingPage() {
    const links = Array.from(
      document.querySelectorAll('a[href*="VehicleDetail"], a[href*="vehicledetail"]')
    );

    for (const link of links) {
      const card = link.closest('article, li, [class*="vehicle"], [class*="result"], [class*="card"]')
                || link.parentElement;
      if (!card) continue;
      if (!/toyota/i.test(card.textContent)) continue;
      if (card.querySelector('.itl-btn')) continue;

      // Stock number is the first 7-9 digit class on the .btn-watch element.
      // The URL contains the vehicle ID (different from stock number).
      const watchBtn = card.querySelector('[class*="btn-watch"]');
      const stock = watchBtn?.className.split(/\s+/).find(c => /^\d{7,9}$/.test(c));
      if (!stock || processed.has(stock)) continue;

      card.appendChild(makeButton(stock));
      processed.add(stock);
    }
  }

  function run() {
    if (isDetailPage()) handleDetailPage();
    else handleListingPage();
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  run();

  // SPA navigation
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(run, 800); }
  }, 500);

  // Infinite scroll / dynamic cards
  new MutationObserver(() => { if (!isDetailPage()) handleListingPage(); })
    .observe(document.body, { childList: true, subtree: true });

})();
