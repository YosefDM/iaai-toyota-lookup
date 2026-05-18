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
      <div class="itl-head">
        <span>Toyota Specs Lookup</span>
        <span class="itl-timer">0.000s</span>
        <button class="itl-close">✕</button>
      </div>
      <div class="itl-body">
        <div class="itl-vin-slot"></div>
        <div class="itl-progress">
          <div class="itl-step" data-step="sca"><span class="itl-dot"></span>Search SCA Auction</div>
          <div class="itl-step" data-step="vin"><span class="itl-dot"></span>Get full VIN</div>
          <div class="itl-step" data-step="toyota-open"><span class="itl-dot"></span>Open Toyota spec page</div>
          <div class="itl-step" data-step="toyota-submit"><span class="itl-dot"></span>Submit VIN</div>
          <div class="itl-step" data-step="toyota-wait"><span class="itl-dot"></span>Wait for results</div>
          <div class="itl-step" data-step="toyota-harvest"><span class="itl-dot"></span>Extract specs</div>
        </div>
      </div>`);
    place(p, anchor);
    p.querySelector('.itl-close').onclick = removePanel;
    document.body.appendChild(p);

    // Live elapsed-time counter (updates every ~50ms).
    const start = performance.now();
    const timerEl = p.querySelector('.itl-timer');
    p._timerId = setInterval(() => {
      const ms = performance.now() - start;
      timerEl.textContent = (ms / 1000).toFixed(3) + 's';
    }, 50);
    p._stopTimer = () => {
      if (p._timerId) { clearInterval(p._timerId); p._timerId = null; }
      const ms = performance.now() - start;
      timerEl.textContent = (ms / 1000).toFixed(3) + 's';
      return ms;
    };

    return p;
  }

  // Step state machine: prior steps are "done", current is "active", later are "pending"
  const STEP_ORDER = ['sca', 'vin', 'toyota-open', 'toyota-submit', 'toyota-wait', 'toyota-harvest'];

  function updateProgress(panel, step, extra) {
    if (!panel) return;
    const idx = STEP_ORDER.indexOf(step);
    if (idx < 0) return;
    panel.querySelectorAll('.itl-step').forEach((el, i) => {
      el.classList.remove('done', 'active', 'pending');
      el.classList.add(i < idx ? 'done' : i === idx ? 'active' : 'pending');
    });
    if (extra?.vin) {
      panel.querySelector('.itl-vin-slot').innerHTML = `
        <div class="itl-vin-row">
          <span class="itl-label">Full VIN</span>
          <span class="itl-vin">${esc(extra.vin)}</span>
          <button class="itl-copy" data-val="${esc(extra.vin)}">Copy</button>
        </div>`;
      panel.querySelector('.itl-copy').addEventListener('click', function () {
        navigator.clipboard.writeText(this.dataset.val);
        this.textContent = 'Copied!';
        setTimeout(() => (this.textContent = 'Copy'), 2000);
      });
    }
  }

  function showResult(resp, anchor, elapsedMs) {
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

    const timerHtml = elapsedMs != null
      ? `<span class="itl-timer">${(elapsedMs / 1000).toFixed(3)}s</span>`
      : '';
    const p = mkPanel(`
      <div class="itl-head">
        <span>Toyota Factory Specs</span>
        ${timerHtml}
        <button class="itl-close">✕</button>
      </div>
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

  // ── Inline tile (detail page) ─────────────────────────────────────────────
  // Uses IAAI's own .tile/.tile--data/.data-list classes so it inherits the
  // native look — we just add .itl-tile for a red accent that signals it's ours.

  function makeInlineTile() {
    const tile = document.createElement('div');
    tile.className = 'tile tile--data itl-tile';
    tile.innerHTML = `
      <div class="tile-header itl-tile-header">
        <h2 class="data-title">Toyota Factory Specs</h2>
        <span class="itl-timer">0.000s</span>
      </div>
      <div class="tile-body itl-tile-body">
        <div class="itl-vin-slot"></div>
        <div class="itl-progress">
          <div class="itl-step" data-step="sca"><span class="itl-dot"></span>Search SCA Auction</div>
          <div class="itl-step" data-step="vin"><span class="itl-dot"></span>Get full VIN</div>
          <div class="itl-step" data-step="toyota-open"><span class="itl-dot"></span>Open Toyota spec page</div>
          <div class="itl-step" data-step="toyota-submit"><span class="itl-dot"></span>Authorize</div>
          <div class="itl-step" data-step="toyota-wait"><span class="itl-dot"></span>Fetch spec data</div>
          <div class="itl-step" data-step="toyota-harvest"><span class="itl-dot"></span>Extract specs</div>
        </div>
      </div>`;

    const start = performance.now();
    const timerEl = tile.querySelector('.itl-timer');
    tile._timerId = setInterval(() => {
      timerEl.textContent = ((performance.now() - start) / 1000).toFixed(3) + 's';
    }, 50);
    tile._stopTimer = () => {
      if (tile._timerId) { clearInterval(tile._timerId); tile._timerId = null; }
      timerEl.textContent = ((performance.now() - start) / 1000).toFixed(3) + 's';
    };
    return tile;
  }

  function renderInlineResult(tile, resp) {
    tile._stopTimer?.();
    const body = tile.querySelector('.itl-tile-body');

    if (!resp.success) {
      body.innerHTML = `<div class="itl-error">${esc(resp.error)}</div>`;
      return;
    }

    const { vin, specs } = resp.data;
    const basics  = specs?.basics  || [];
    const options = specs?.options || [];

    const basicsRows = [
      { label: 'VIN', value: vin, mono: true },
      ...basics.map(s => {
        const i = s.indexOf(':');
        return { label: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
      })
    ];

    const rowsHtml = basicsRows.map(r => `
      <li class="data-list__item">
        <span class="data-list__label">${esc(r.label)}:</span>
        <span class="data-list__value text-bold${r.mono ? ' itl-mono' : ''}">${esc(r.value)}</span>
      </li>`).join('');

    // Surface a Toyota-side error (the SCA part already gave us the VIN above)
    const errorHtml = specs?.error
      ? `<div class="itl-section-divider"></div><div class="itl-error">${esc(specs.error)}</div>`
      : '';

    let optionsHtml = '';
    if (options.length) {
      const items = options.map(o => {
        const m = o.match(/^([A-Z0-9]{2,3})\s+(.+)$/);
        const code = m ? m[1] : '';
        // Add space after commas that have no space (e.g. "Touchscreen,Dynamic" → "Touchscreen, Dynamic")
        const text = (m ? m[2] : o).replace(/,(\S)/g, ', $1');
        return code
          ? `<li class="itl-option"><span class="itl-option-code">${esc(code)}</span><span class="itl-option-text">${esc(text)}</span></li>`
          : `<li class="itl-option"><span class="itl-option-text">${esc(text)}</span></li>`;
      }).join('');
      optionsHtml = `
        <div class="itl-section-divider"></div>
        <h3 class="itl-subhead">Factory Options</h3>
        <ul class="itl-options">${items}</ul>`;
    }

    body.innerHTML = `
      <ul class="data-list data-list--details">${rowsHtml}</ul>
      ${errorHtml}
      ${optionsHtml}`;
  }

  function runInlineLookup(stock, tile) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'LOOKUP_SPECS' });
    } catch (err) {
      renderInlineResult(tile, { success: false, error: 'Extension was reloaded — please refresh this page and try again.' });
      return;
    }

    port.onMessage.addListener(msg => {
      if (msg.type === 'progress') {
        updateProgress(tile, msg.step, { vin: msg.vin });
      } else if (msg.type === 'result') {
        renderInlineResult(tile, msg);
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError && tile.isConnected && tile._timerId) {
        renderInlineResult(tile, { success: false, error: 'Extension was reloaded — please refresh this page and try again.' });
      }
    });

    port.postMessage({ type: 'start', stockNumber: stock });
  }

  // ── Lookup (listing-page popup) ───────────────────────────────────────────

  function doLookup(stock, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const panel = showLoading(btn);
    let port;
    try {
      port = chrome.runtime.connect({ name: 'LOOKUP_SPECS' });
    } catch (err) {
      showResult({ success: false, error: 'Extension was reloaded — please refresh this IAAI page and try again.' }, btn);
      btn.disabled = false;
      return;
    }

    port.onMessage.addListener(msg => {
      if (msg.type === 'progress') {
        updateProgress(panel, msg.step, { vin: msg.vin });
      } else if (msg.type === 'result') {
        const elapsed = panel._stopTimer?.();
        showResult(msg, btn, elapsed);
        btn.disabled = false;
      }
    });

    port.onDisconnect.addListener(() => {
      btn.disabled = false;
      if (chrome.runtime.lastError && document.body.contains(panel)) {
        const elapsed = panel._stopTimer?.();
        showResult({ success: false, error: 'Extension was reloaded — please refresh this IAAI page and try again.' }, btn, elapsed);
      }
    });

    port.postMessage({ type: 'start', stockNumber: stock });
  }

  // ── IAAI page handlers ────────────────────────────────────────────────────

  function handleDetailPage() {
    if (!isToyota()) return;

    const stock = getStockNumber();
    if (!stock || processed.has('detail-' + stock)) return;

    // Mount our inline tile next to IAAI's native tiles. The sidebar is populated
    // by the page's own JS, so retry briefly if it isn't ready yet.
    const firstTile = document.querySelector('.tile.tile--data');
    if (!firstTile) {
      setTimeout(handleDetailPage, 300);
      return;
    }
    processed.add('detail-' + stock);

    const tile = makeInlineTile();
    firstTile.parentElement.insertBefore(tile, firstTile.nextSibling);
    runInlineLookup(stock, tile);
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
