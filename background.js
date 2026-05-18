// background.js — service worker

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'LOOKUP_SPECS') return;
  port.onMessage.addListener(msg => {
    if (msg.type !== 'start') return;
    performLookup(msg.stockNumber, step => safePost(port, { type: 'progress', ...step }))
      .then(data => safePost(port, { type: 'result', success: true, data }))
      .catch(err => safePost(port, { type: 'result', success: false, error: err.message }))
      .finally(() => { try { port.disconnect(); } catch (_) {} });
  });
});

function safePost(port, msg) {
  try { port.postMessage(msg); } catch (_) {}
}

async function performLookup(stockNumber, onProgress) {
  onProgress({ step: 'sca', message: 'Searching SCA Auction…' });
  const vin = await getVINFromSCA(stockNumber);
  if (!vin) {
    throw new Error(
      'Could not get the full VIN from SCA Auction.\n\n' +
      'Make sure you are logged in to sca.auction in Chrome, then try again.'
    );
  }
  onProgress({ step: 'vin', vin, message: `Got VIN: ${vin}` });

  onProgress({ step: 'toyota', message: 'Looking up Toyota factory specs…' });
  const specs = await getToyotaSpecs(vin, onProgress).catch(err => ({ error: err.message }));
  return { vin, specs };
}

// ── Tab helpers ──────────────────────────────────────────────────────────────

function openTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, tab => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(tab);
    });
  });
}

function navigateTab(tabId, url) {
  return new Promise(resolve => chrome.tabs.update(tabId, { url }, resolve));
}

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function runScript(tabId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId }, func, args })
    .then(res => res[0]?.result ?? null);
}

// ── SCA Auction — get full VIN ───────────────────────────────────────────────
// SCA does server-side rendering, so we can fetch() both pages directly from
// the service worker. credentials: 'include' sends the user's session cookies,
// which is what makes the full VIN visible (logged-out users see a masked VIN).

async function getVINFromSCA(stockNumber) {
  // Phase 1: fetch search results and find the detail page URL
  const searchHtml = await scaFetch(
    `https://sca.auction/en/search?search_query=${encodeURIComponent(stockNumber)}`
  );
  const detailPath = findDetailPath(searchHtml);
  if (!detailPath) return null;

  // Phase 2: fetch detail page and extract VIN
  const detailHtml = await scaFetch(`https://sca.auction${detailPath}`);
  const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
  return detailHtml.match(VIN_RE)?.[0] ?? null;
}

async function scaFetch(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept': 'text/html' }
  });
  if (!res.ok) throw new Error(`SCA returned ${res.status} for ${url}`);
  return res.text();
}

// Find the vehicle detail path (e.g. /en/1059458574-2025-toyota-camry) from search HTML.
// Detail URLs are 9+ digit SCA IDs, not the IAAI stock number.
function findDetailPath(html) {
  const matches = [...new Set(
    [...html.matchAll(/href="(\/en\/\d{9,}[^"]*)"/g)].map(m => m[1])
  )];
  return matches[0] ?? null;
}

// ── Toyota Owners Spec Page ──────────────────────────────────────────────────

async function getToyotaSpecs(vin, onProgress = () => {}) {
  onProgress({ step: 'toyota-open', message: 'Opening Toyota spec page…' });
  const tab = await openTab('https://www.toyota.com/owners/vehicle-specification/');
  try {
    await waitForTabLoad(tab.id);
    await sleep(4000);

    const currentUrl = await runScript(tab.id, () => location.href);
    if (currentUrl && currentUrl.includes('account.toyota.com')) {
      throw new Error(
        'Toyota owners portal requires login.\n\n' +
        'Please log in at toyota.com/owners, then try again.'
      );
    }

    onProgress({ step: 'toyota-submit', message: 'Submitting VIN to Toyota…' });
    const fillResult = await runScript(tab.id, toyotaFillAndSubmit, [vin]);
    if (fillResult === 'NOT_FOUND') {
      throw new Error('Could not find the VIN input or Submit button on the Toyota spec page.');
    }

    onProgress({ step: 'toyota-wait', message: 'Waiting for spec data…' });
    // Page has 4 empty container shells before submit — poll for .trow content instead.
    const DEADLINE = Date.now() + 60000;
    while (Date.now() < DEADLINE) {
      await sleep(500);
      try {
        const trows = await runScript(tab.id, () =>
          document.querySelectorAll('.to-vehicle-specs__table-container .trow').length
        );
        if (trows >= 5) break;
      } catch (_) {
        // tab briefly unavailable — keep waiting
      }
    }

    onProgress({ step: 'toyota-harvest', message: 'Extracting results…' });
    return await runScript(tab.id, toyotaHarvest);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Injected into Toyota spec page — finds input, fills VIN, clicks Submit, returns immediately.
// Returns 'OK' on success or 'NOT_FOUND' if elements are missing after waiting.
function toyotaFillAndSubmit(vin) {
  const TIMEOUT = 20000;
  const start = Date.now();

  function setVal(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
    ['input', 'change'].forEach(t => input.dispatchEvent(new Event(t, { bubbles: true })));
  }

  function findInput() {
    for (const s of ['input[placeholder*="VIN" i]', 'input[placeholder*="17" i]',
      'input[name="vin" i]', 'input[id*="vin" i]', 'input[type="text"]']) {
      const el = document.querySelector(s);
      if (el?.offsetParent !== null) return el;
    }
    return null;
  }

  function findButton() {
    for (const el of document.querySelectorAll('a, button')) {
      if (el.offsetParent !== null && /^submit/i.test(el.textContent.trim())) return el;
    }
    return null;
  }

  return new Promise(resolve => {
    function tryFill() {
      if (Date.now() - start > TIMEOUT) return resolve('NOT_FOUND');
      const input = findInput();
      const btn   = findButton();
      if (input && btn) {
        setVal(input, vin);
        setTimeout(() => { btn.click(); resolve('OK'); }, 700);
      } else {
        setTimeout(tryFill, 500);
      }
    }
    tryFill();
  });
}

// Injected into Toyota spec page after results have loaded — extracts options.
// Page uses .to-vehicle-specs__table-container sections with .trow/.tcol structure.
function toyotaHarvest() {
  const containers = Array.from(document.querySelectorAll('.to-vehicle-specs__table-container'));
  if (!containers.length) {
    return { basics: [], options: [], pageTitle: document.title, url: location.href };
  }

  const basics  = [];
  const options  = [];

  for (const c of containers) {
    const text = c.innerText || '';
    const rows = Array.from(c.querySelectorAll('.trow'));

    if (/port or factory/i.test(text)) {
      // Single-column rows: item names, then their source labels (Factory/Port) — skip source labels
      for (const row of rows) {
        const cols = Array.from(row.querySelectorAll('.tcol')).map(el => el.textContent.trim());
        const val = cols[0];
        if (val && !/^(factory|port)$/i.test(val)) options.push(val);
      }

    } else if (/basic vehicle/i.test(text)) {
      for (const row of rows) {
        const cols = Array.from(row.querySelectorAll('.tcol')).map(el => el.textContent.trim());
        if (cols.length >= 2 && /^(grade|drive.?train)$/i.test(cols[0])) {
          basics.push(`${cols[0]}: ${cols[1]}`);
        }
      }
    }
  }

  return { basics, options, pageTitle: document.title, url: location.href };
}
