// background.js — service worker

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LOOKUP_SPECS') {
    performLookup(message.stockNumber)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

async function performLookup(stockNumber) {
  const vin = await getVINFromSCA(stockNumber);
  if (!vin) {
    throw new Error(
      'Could not get the full VIN from SCA Auction.\n\n' +
      'Make sure you are logged in to sca.auction in Chrome, then try again.'
    );
  }
  const specs = await getToyotaSpecs(vin).catch(err => ({ error: err.message }));
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

async function getVINFromSCA(stockNumber) {
  const tab = await openTab(`https://sca.auction/en/search?search_query=${encodeURIComponent(stockNumber)}`);
  try {
    await waitForTabLoad(tab.id);
    await sleep(4000); // wait for React to render

    // Phase 1: find the vehicle detail URL for this stock number
    const vehicleUrl = await runScript(tab.id, scaFindVehicleLink, [stockNumber]);
    if (!vehicleUrl) return null;

    // Phase 2: navigate to the vehicle detail page
    await navigateTab(tab.id, vehicleUrl);
    await waitForTabLoad(tab.id);
    await sleep(3000);

    // Phase 3: extract the full VIN (only visible when logged in)
    return await runScript(tab.id, scaExtractFullVin);

  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Injected into SCA search results — finds detail page URL for the given stock number.
// When logged in, item numbers are NOT masked (shows "45045241" not "45******"),
// so we can find the exact match.
function scaFindVehicleLink(stockNumber) {
  // Collect all article/card elements that are vehicle listings
  const cards = Array.from(document.querySelectorAll('article, li[class*="vehicle"], li[class*="result"]'));

  for (const card of cards) {
    const text = card.innerText || card.textContent || '';
    // Exact item number match (only visible when logged in)
    if (text.includes(stockNumber)) {
      const link = card.querySelector('a[href*="/en/"]');
      if (link) return link.href;
    }
  }

  // Fallback: look at ALL links — if exactly one unique vehicle detail link exists, use it
  const links = [...new Set(
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => /sca\.auction\/en\/\d{9,}/.test(h))
  )];
  if (links.length === 1) return links[0];

  return null;
}

// Injected into SCA vehicle detail page — extracts full 17-char VIN.
// Returns null when not logged in (only partial VIN visible).
function scaExtractFullVin() {
  const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
  return new Promise(resolve => {
    let tries = 0;
    function check() {
      tries++;
      const matches = (document.body.innerText || '').match(VIN_RE);
      if (matches?.length) return resolve(matches[0]);
      if (tries < 40) setTimeout(check, 250);
      else resolve(null);
    }
    check();
  });
}

// ── Toyota Owners Spec Page ──────────────────────────────────────────────────

async function getToyotaSpecs(vin) {
  const tab = await openTab('https://www.toyota.com/owners/vehicle-specification/');
  try {
    await waitForTabLoad(tab.id);
    await sleep(4000);

    // Check if we were redirected to the login page
    const currentUrl = await runScript(tab.id, () => location.href);
    if (currentUrl && currentUrl.includes('account.toyota.com')) {
      throw new Error(
        'Toyota owners portal requires login.\n\n' +
        'Please log in at toyota.com/owners, then try again.'
      );
    }

    // Phase 1: fill VIN and click Submit — short script, returns immediately.
    // Must NOT be a long-running Promise: clicking <a href="#"> destroys the injected context.
    const fillResult = await runScript(tab.id, toyotaFillAndSubmit, [vin]);
    if (fillResult === 'NOT_FOUND') {
      throw new Error('Could not find the VIN input or Submit button on the Toyota spec page.');
    }

    // Phase 2: service worker polls until results appear (avoids context-destruction problem)
    const DEADLINE = Date.now() + 60000;
    while (Date.now() < DEADLINE) {
      await sleep(500);
      const count = await runScript(tab.id, () =>
        document.querySelectorAll('.to-vehicle-specs__table-container').length
      );
      if (count >= 3) break;
    }

    // Phase 3: harvest — short script
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

// Injected into Toyota spec page after results have loaded — extracts packages/options.
// Page uses .to-vehicle-specs__table-container sections with .trow/.tcol structure.
function toyotaHarvest() {
  const containers = Array.from(document.querySelectorAll('.to-vehicle-specs__table-container'));
  if (!containers.length) {
    return { packages: [], options: [], pageTitle: document.title, url: location.href };
  }

  const packages = [];
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

    } else if (/standard installation/i.test(text)) {
      // Two-column rows: [category, description]
      for (const row of rows) {
        const cols = Array.from(row.querySelectorAll('.tcol')).map(el => el.textContent.trim());
        if (cols.length >= 2 && cols[0] && cols[1]) {
          packages.push(`${cols[0]}: ${cols[1]}`);
        } else if (cols.length === 1 && cols[0]) {
          packages.push(cols[0]);
        }
      }

    } else if (/basic vehicle/i.test(text)) {
      // Two-column rows: [label, value] — include Grade, Exterior, Interior, Engine, Drive Train
      for (const row of rows) {
        const cols = Array.from(row.querySelectorAll('.tcol')).map(el => el.textContent.trim());
        if (cols.length >= 2 && /grade|exterior|interior|engine|drive.?train|transmission/i.test(cols[0])) {
          options.push(`${cols[0]}: ${cols[1]}`);
        }
      }
    }
  }

  return { packages, options, pageTitle: document.title, url: location.href };
}
