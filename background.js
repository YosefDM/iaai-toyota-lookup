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

// MAIN world: runs in the page's JS context — needed to access page globals
// like grecaptcha that aren't exposed to the isolated content-script world.
function runInPage(tabId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId }, func, args, world: 'MAIN' })
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
// The /v1/vehicle/detailed-specs API requires a freshly-generated reCAPTCHA
// Enterprise token, which can only be produced in the page context where
// grecaptcha.enterprise is loaded. So we still open a Toyota tab — but we
// skip the form-fill/click/SPA-render dance and call the API directly.

async function getToyotaSpecs(vin, onProgress = () => {}) {
  onProgress({ step: 'toyota-open', message: 'Opening Toyota spec page…' });
  const tab = await openTab('https://www.toyota.com/owners/vehicle-specification/');
  try {
    await waitForTabLoad(tab.id);
    // The Toyota spec page may bounce through account.toyota.com to refresh the
    // session before settling back on www.toyota.com. We don't have host
    // permission for account.toyota.com, so wait for the redirect to settle.
    await sleep(4000);

    let currentUrl;
    try {
      currentUrl = await runScript(tab.id, () => location.href);
    } catch (e) {
      throw new Error(
        'Toyota owners portal requires login.\n\n' +
        'Please log in at toyota.com/owners, then try again.'
      );
    }
    if (!currentUrl || currentUrl.includes('account.toyota.com')) {
      throw new Error(
        'Toyota owners portal requires login.\n\n' +
        'Please log in at toyota.com/owners, then try again.'
      );
    }

    onProgress({ step: 'toyota-submit', message: 'Authorizing with Toyota…' });
    await waitForToyotaReady(tab.id);

    onProgress({ step: 'toyota-wait', message: 'Fetching spec data…' });
    const result = await runInPage(tab.id, toyotaApiCall, [vin]);
    if (!result) throw new Error('Toyota API call returned no result (script may have been blocked).');
    if (result.error === 'NO_TOKEN') {
      throw new Error(
        'Toyota owners portal requires login.\n\n' +
        'Please log in at toyota.com/owners, then try again.'
      );
    }
    if (result.error) throw new Error(result.error);
    if (!result.data) throw new Error('Toyota API returned no spec data for this VIN.');

    onProgress({ step: 'toyota-harvest', message: 'Extracting results…' });
    return toyotaTransform(result.data);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Wait for both grecaptcha.enterprise and the id_token cookie to be available.
// Must use MAIN world — grecaptcha is on the page's window, not in the
// isolated content-script world.
async function waitForToyotaReady(tabId, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ready = await runInPage(tabId, () =>
        typeof window.grecaptcha?.enterprise?.execute === 'function' &&
        document.cookie.includes('id_token=')
      );
      if (ready) return;
    } catch (e) {
      // Tab may be mid-redirect through account.toyota.com — keep waiting.
      lastErr = e;
    }
    await sleep(250);
  }
  if (lastErr && /Cannot access/i.test(lastErr.message)) {
    throw new Error(
      'Toyota owners portal requires login.\n\n' +
      'Please log in at toyota.com/owners, then try again.'
    );
  }
  throw new Error('Toyota page never finished loading reCAPTCHA — try again.');
}

// Injected into the Toyota tab — generates a captcha token and calls the API.
// Returns { data: VehicleSpecDetailResponse } or { error: string }.
function toyotaApiCall(vin) {
  return (async () => {
    try {
      const submitLink = document.querySelector('a[data-site-key]');
      const siteKey = submitLink?.getAttribute('data-site-key');
      const action  = submitLink?.getAttribute('data-action') || 'login';
      if (!siteKey) return { error: 'Could not find reCAPTCHA site key on the Toyota page.' };

      const idToken = document.cookie.split('; ').find(c => c.startsWith('id_token='))?.slice(9);
      if (!idToken) return { error: 'NO_TOKEN' };

      const captchaToken = await window.grecaptcha.enterprise.execute(siteKey, { action });

      const res = await fetch('https://prod.webservices.toyota.com/v1/vehicle/detailed-specs', {
        method: 'POST',
        headers: {
          'authorization': idToken,
          'x-brand': 'T',
          'x-client': 'TCOM',
          'x-domain-token': captchaToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ vin })
      });

      if (!res.ok) {
        const text = await res.text();
        return { error: `Toyota API ${res.status}: ${text.substring(0, 300)}` };
      }

      const json = await res.json();
      return { data: json?.data?.VehicleSpecDetailResponse ?? null };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  })();
}

// Map the API JSON into the existing { basics, options } shape the panel renders.
function toyotaTransform(d) {
  if (!d) return { basics: [], options: [] };
  const basics = [];
  if (d.vehicleGrade)     basics.push(`Grade: ${d.vehicleGrade}`);
  if (d.vehicleDriveType) basics.push(`Drive Train: ${d.vehicleDriveType}`);
  const options = Array.isArray(d.installationSource) ? d.installationSource.slice() : [];
  return { basics, options };
}
