/* =========================================================================
   ReviewScout — service worker (background)
   - L'IA passe par TON serveur (pool multi-fournisseurs Mistral/Gemini).
   - Le serveur gère : clés IA, licence, quota, essai gratuit.
   - Le scraping des avis de l'onglet actif reste local.
   ========================================================================= */
const DEFAULT_SERVER = "https://kdp-serveur.onrender.com";

function getServerConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { serverUrl: DEFAULT_SERVER, licenseKey: "", deviceId: "" },
      (cfg) => {
        if (!cfg.deviceId) {
          // Préfixe "rs-" : compteur d'essai distinct des autres extensions.
          cfg.deviceId =
            "rs-" +
            ((self.crypto && crypto.randomUUID)
              ? crypto.randomUUID()
              : Date.now() + "-" + Math.random().toString(36).slice(2));
          chrome.storage.sync.set({ deviceId: cfg.deviceId });
        }
        if (!cfg.serverUrl) cfg.serverUrl = DEFAULT_SERVER;
        resolve(cfg);
      }
    );
  });
}
function baseUrl(cfg) {
  return (cfg.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

async function callServerAnalyse(prompt) {
  const cfg = await getServerConfig();
  let res, data;
  try {
    res = await fetch(baseUrl(cfg) + "/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license: cfg.licenseKey || "", deviceId: cfg.deviceId, prompt }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: 0, error: "serveur_injoignable", message: e.message };
  }
  if (res.ok && data && data.ok) {
    return { ok: true, text: data.text, used: data.used, limit: data.limit, credits: data.credits, restant: data.restant };
  }
  return {
    ok: false,
    status: res.status,
    error: (data && data.error) || "HTTP " + res.status,
    message: (data && data.message) || "",
    used: data && data.used,
    limit: data && data.limit,
  };
}

async function callServerLicense() {
  const cfg = await getServerConfig();
  try {
    const res = await fetch(baseUrl(cfg) + "/verifier-licence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license: cfg.licenseKey || "", deviceId: cfg.deviceId }),
    });
    return await res.json();
  } catch (e) {
    return { active: false, error: "serveur_injoignable", message: e.message };
  }
}

function sendMessageToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ __noReceiver: true, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

async function scrapeReviewsActiveTab(limit) {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs.length) tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) return { ok: false, error: "Aucun onglet actif détecté." };
  if (!/https?:\/\/[^/]*amazon\./.test(tab.url || "")) {
    return {
      ok: false,
      error:
        "Ouvre d'abord une <b>fiche produit Amazon</b> (avec des avis), puis relance l'analyse.",
    };
  }
  let resp = await sendMessageToTab(tab.id, { action: "scrapeReviews", limit });
  if (resp && resp.__noReceiver) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await new Promise((r) => setTimeout(r, 250));
      resp = await sendMessageToTab(tab.id, { action: "scrapeReviews", limit });
    } catch (e) {
      return { ok: false, error: "Impossible d'accéder à la page (" + e.message + "). Recharge la page Amazon (F5) puis réessaie." };
    }
  }
  if (!resp || resp.__noReceiver) {
    return { ok: false, error: "La page n'a pas répondu. Recharge la page Amazon (F5) puis relance l'analyse." };
  }
  return resp;
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === "ai") {
    (async () => {
      try { sendResponse(await callServerAnalyse(req.prompt)); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (req.action === "licenseStatus") {
    (async () => {
      try { sendResponse(await callServerLicense()); }
      catch (e) { sendResponse({ active: false, error: e.message }); }
    })();
    return true;
  }
  if (req.action === "scrapeReviewsActiveTab") {
    (async () => {
      try { sendResponse(await scrapeReviewsActiveTab(req.limit || 60)); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
});
