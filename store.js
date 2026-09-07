/* =========================================================================
   Stockage des usages — 3 compteurs indépendants :
     1) Quota MENSUEL de l'abonnement      (remis à zéro chaque mois)
     2) Essai gratuit ANNUEL par appareil  (remis à zéro chaque année)
     3) Solde de CRÉDITS non expirants     (packs achetés)

   DEUX modes de stockage, choisis automatiquement :
     - Si UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN sont définis
       -> base Redis Upstash (GRATUITE, PERSISTANTE) : rien ne se réinitialise,
          même si l'hébergeur redémarre ou s'endort. (recommandé en ligne)
     - Sinon -> fichier JSON local (pratique pour tes tests sur ton PC).

   Toutes les fonctions sont "async" (renvoient une promesse) pour fonctionner
   avec Redis. En mode fichier, elles répondent instantanément.
   ========================================================================= */
const fs = require("fs");
const path = require("path");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const useRedis = !!(REDIS_URL && REDIS_TOKEN);

function monthKey(d = new Date()) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
function yearKey(d = new Date()) {
  return String(d.getUTCFullYear());
}
function monthlyResetsAt() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}
function trialResetsAt() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1)).toISOString();
}

/* =======================================================================
   MODE REDIS (Upstash REST) — persistant et gratuit
   ======================================================================= */
async function rc(args) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (data && data.error) throw new Error("Redis: " + data.error);
  return data ? data.result : null;
}

const R = {
  async getMonthly(id) {
    const v = await rc(["GET", "m:" + id + ":" + monthKey()]);
    return parseInt(v || "0", 10) || 0;
  },
  async incrementMonthly(id) {
    const key = "m:" + id + ":" + monthKey();
    const n = await rc(["INCR", key]);
    // Nettoyage auto : la clé du mois expire après 70 jours
    if (n === 1) await rc(["EXPIRE", key, "6048000"]).catch(() => {});
    return n;
  },
  async getTrial(deviceId) {
    const v = await rc(["GET", "t:" + (deviceId || "anon") + ":" + yearKey()]);
    return parseInt(v || "0", 10) || 0;
  },
  async incrementTrial(deviceId) {
    const key = "t:" + (deviceId || "anon") + ":" + yearKey();
    const n = await rc(["INCR", key]);
    if (n === 1) await rc(["EXPIRE", key, "34128000"]).catch(() => {}); // ~13 mois
    return n;
  },
  async getCredits(licenseKey) {
    const v = await rc(["GET", "c:" + licenseKey]);
    return parseInt(v || "0", 10) || 0;
  },
  async grantCreditsOnce(licenseKey, amount) {
    if (!amount || amount <= 0) return R.getCredits(licenseKey);
    // SETNX = pose le drapeau uniquement s'il n'existe pas -> octroi une seule fois
    const first = await rc(["SETNX", "g:" + licenseKey, "1"]);
    if (first === 1) await rc(["INCRBY", "c:" + licenseKey, String(amount)]);
    return R.getCredits(licenseKey);
  },
  async consumeCredit(licenseKey) {
    const v = await rc(["DECR", "c:" + licenseKey]);
    if (v < 0) { await rc(["SET", "c:" + licenseKey, "0"]).catch(() => {}); return 0; }
    return v;
  },
};

/* =======================================================================
   MODE FICHIER (local) — secours pour tes tests
   ======================================================================= */
const FILE = process.env.STORE_FILE || path.join(__dirname, "usage.json");
let data = { monthly: {}, trial: {}, credits: {} };
try {
  if (!useRedis && fs.existsSync(FILE)) {
    const loaded = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
    data.monthly = loaded.monthly || {};
    data.trial = loaded.trial || {};
    data.credits = loaded.credits || {};
  }
} catch (_) { data = { monthly: {}, trial: {}, credits: {} }; }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch (_) {}
  }, 500);
}

const F = {
  async getMonthly(id) {
    const rec = data.monthly[id];
    if (!rec || rec.period !== monthKey()) return 0;
    return rec.count || 0;
  },
  async incrementMonthly(id) {
    const p = monthKey();
    const rec = data.monthly[id];
    if (!rec || rec.period !== p) data.monthly[id] = { period: p, count: 1 };
    else rec.count = (rec.count || 0) + 1;
    persist();
    return data.monthly[id].count;
  },
  async getTrial(deviceId) {
    const key = "trial:" + (deviceId || "anon");
    const rec = data.trial[key];
    if (!rec || rec.period !== yearKey()) return 0;
    return rec.count || 0;
  },
  async incrementTrial(deviceId) {
    const key = "trial:" + (deviceId || "anon");
    const p = yearKey();
    const rec = data.trial[key];
    if (!rec || rec.period !== p) data.trial[key] = { period: p, count: 1 };
    else rec.count = (rec.count || 0) + 1;
    persist();
    return data.trial[key].count;
  },
  async getCredits(licenseKey) {
    const rec = data.credits[licenseKey];
    return (rec && rec.balance) || 0;
  },
  async grantCreditsOnce(licenseKey, amount) {
    if (!amount || amount <= 0) return F.getCredits(licenseKey);
    let rec = data.credits[licenseKey];
    if (!rec) rec = data.credits[licenseKey] = { balance: 0, granted: {} };
    if (!rec.granted) rec.granted = {};
    if (!rec.granted[licenseKey]) {
      rec.balance = (rec.balance || 0) + amount;
      rec.granted[licenseKey] = true;
      persist();
    }
    return rec.balance;
  },
  async consumeCredit(licenseKey) {
    const rec = data.credits[licenseKey];
    if (!rec || (rec.balance || 0) <= 0) return 0;
    rec.balance -= 1;
    persist();
    return rec.balance;
  },
};

const impl = useRedis ? R : F;

module.exports = {
  mode: useRedis ? "redis" : "file",
  getMonthly: impl.getMonthly,
  incrementMonthly: impl.incrementMonthly,
  getTrial: impl.getTrial,
  incrementTrial: impl.incrementTrial,
  getCredits: impl.getCredits,
  grantCreditsOnce: impl.grantCreditsOnce,
  consumeCredit: impl.consumeCredit,
  monthlyResetsAt,
  trialResetsAt,
};
