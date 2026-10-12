// ============================================================
// cours.js — Cours « Parler anglais au centre d'appel » · Éclozia
// Monté dans server.js :
//   const cours = require("./cours");
//   app.use(cours.racineSousDomaine);   // AVANT app.get("/")
//   app.use("/cours", cours.router);
//
// Routes :
//   GET  /cours            → la page du cours (cours.html)
//   GET  /cours/preview    → modules gratuits (1 et 3), sans clé
//   POST /cours/activate   → { license_key } → vérifie Gumroad → cours complet
//
// Variables d'environnement (Render) :
//   GUMROAD_PRODUCT_COURS  identifiant du produit Gumroad du cours (obligatoire)
//   COURS_GUMROAD_URL      page de vente Gumroad (bouton « Acheter »)
//   COURS_PRIX             prix affiché, ex. « 12 $ »
//   COURS_HOST             sous-domaine qui affiche le cours à la racine,
//                          ex. parleranglais.geteclozia.com
//   COURS_MAX_APPAREILS    nombre d'appareils autorisés par clé (défaut : 3)
//   COURS_ADMIN_TOKEN      mot de passe de la page /cours/admin (réinitialiser
//                          les appareils d'une clé). Sans lui, la page est fermée.
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (déjà utilisés par les
//                          extensions) : mémorisent les appareils de façon
//                          permanente. Sans eux, la liste repart à zéro à chaque
//                          redéploiement de Render.
//
// Contenu du cours : fichier secret Render « cours-content.json »
// (lu dans /etc/secrets/, jamais dans le dépôt GitHub public).
//
// IMPORTANT : ne PAS ajouter l'ID du cours à GUMROAD_PRODUCT_IDS,
// sinon une clé du cours donnerait accès aux analyses IA des extensions.
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const MODULES_GRATUITS = [1, 3];
const TTL_MS = 6 * 60 * 60 * 1000; // une clé vérifiée reste en mémoire 6 h

// ── Contenu du cours (fichier secret) ──────────────────────────
let _contenu = null;
function contenu() {
  if (_contenu) return _contenu;
  const candidats = [
    process.env.COURS_CONTENT_PATH,
    "/etc/secrets/cours-content.json",
    path.join(__dirname, "cours-content.json"), // tests en local (ignoré par Git)
  ].filter(Boolean);
  for (const p of candidats) {
    try {
      if (fs.existsSync(p)) { _contenu = JSON.parse(fs.readFileSync(p, "utf8")); return _contenu; }
    } catch (e) { console.error("[cours] fichier illisible :", p, e.message); }
  }
  return null;
}

// ── Page HTML (réglages injectés depuis les variables d'env) ───
let _page = null;
function page() {
  if (!_page) _page = fs.readFileSync(path.join(__dirname, "cours.html"), "utf8");
  const echap = s => String(s).replace(/[\\"<>]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return _page
    .replace("__GUMROAD_URL__", echap(process.env.COURS_GUMROAD_URL || "#"))
    .replace("__PRIX__", echap(process.env.COURS_PRIX || "12 $"));
}
function envoyerPage(res) {
  res.set("Cache-Control", "no-cache");
  res.type("html").send(page());
}

// ── Vérification Gumroad (indépendante des licences des extensions) ──
const _cache = new Map();
async function verifierCle(cle) {
  const productId = process.env.GUMROAD_PRODUCT_COURS;
  if (!productId) return { ok: false, statut: 500, erreur: "Serveur mal configuré (GUMROAD_PRODUCT_COURS manquant)." };

  const k = crypto.createHash("sha256").update(productId + ":" + cle).digest("hex");
  const c = _cache.get(k);
  if (c && Date.now() - c.at < TTL_MS) return c.res;

  let data;
  try {
    const r = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ product_id: productId, license_key: cle, increment_uses_count: "false" }).toString(),
    });
    data = await r.json().catch(() => ({ success: false }));
  } catch (_) {
    return { ok: false, statut: 503, erreur: "Gumroad ne répond pas. Réessayez dans un instant." };
  }

  let res;
  if (!data || !data.success) {
    res = { ok: false, statut: 403, erreur: "Cette clé de licence n'est pas reconnue. Vérifiez-la dans votre courriel de Gumroad." };
  } else {
    const p = data.purchase || {};
    if (p.refunded || p.chargebacked || p.disputed) {
      res = { ok: false, statut: 403, erreur: "Cet achat a été remboursé ou contesté : l'accès n'est plus actif." };
    } else {
      res = { ok: true, email: masquer(p.email || "") };
    }
  }
  _cache.set(k, { at: Date.now(), res });
  return res;
}
function masquer(email) {
  const [u, d] = email.split("@");
  return d ? u.slice(0, 2) + "•••@" + d : "";
}


// ── Limite d'appareils par clé ─────────────────────────────────
function maxAppareils() {
  const n = parseInt(process.env.COURS_MAX_APPAREILS || "3", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function cleAppareils(cle) {
  const id = process.env.GUMROAD_PRODUCT_COURS || "";
  return "cours:appareils:" + crypto.createHash("sha256").update(id + ":" + cle).digest("hex").slice(0, 40);
}
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
async function redis(args) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const d = await r.json().catch(() => ({}));
  if (d && d.error) throw new Error("Redis: " + d.error);
  return d ? d.result : null;
}
// Secours sans Redis : petit fichier JSON local
const FICHIER = process.env.COURS_DEVICES_FILE || path.join(__dirname, "cours-appareils.json");
function lireFichier() { try { return JSON.parse(fs.readFileSync(FICHIER, "utf8")); } catch (_) { return {}; } }
function ecrireFichier(d) { try { fs.writeFileSync(FICHIER, JSON.stringify(d)); } catch (_) {} }

const appareils = {
  async liste(k) {
    if (REDIS_URL && REDIS_TOKEN) return (await redis(["SMEMBERS", k])) || [];
    return lireFichier()[k] || [];
  },
  async ajouter(k, dev) {
    if (REDIS_URL && REDIS_TOKEN) { await redis(["SADD", k, dev]); return; }
    const d = lireFichier(); d[k] = [...new Set([...(d[k] || []), dev])]; ecrireFichier(d);
  },
  async vider(k) {
    if (REDIS_URL && REDIS_TOKEN) { await redis(["DEL", k]); return; }
    const d = lireFichier(); delete d[k]; ecrireFichier(d);
  },
};

// Renvoie { ok:true } si l'appareil est connu ou s'il reste une place.
async function autoriserAppareil(cle, dev) {
  const k = cleAppareils(cle);
  try {
    const deja = await appareils.liste(k);
    if (deja.includes(dev)) return { ok: true };
    if (deja.length >= maxAppareils()) {
      return { ok: false, statut: 403, erreur: "Cette clé est déjà utilisée sur " + maxAppareils() + " appareils, le maximum autorisé. Pour réinitialiser vos appareils, écrivez à contact@geteclozia.com avec le courriel de votre achat." };
    }
    await appareils.ajouter(k, dev);
    return { ok: true };
  } catch (e) {
    // Si le stockage est en panne, on ne bloque pas un vrai client.
    console.error("[cours] appareils :", e.message);
    return { ok: true };
  }
}

// ── Routes ─────────────────────────────────────────────────────
router.get("/", (_req, res) => envoyerPage(res));

router.get("/preview", (_req, res) => {
  const c = contenu();
  if (!c) return res.status(503).json({ ok: false, error: "Le contenu du cours n'est pas encore installé sur le serveur." });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, preview: true, course: { ...c, modules: c.modules.filter(m => MODULES_GRATUITS.includes(m.id)) } });
});

router.post("/activate", async (req, res) => {
  const cle = String((req.body && req.body.license_key) || "").trim();
  if (!cle || cle.length > 100) return res.status(400).json({ ok: false, error: "Clé de licence manquante ou invalide." });
  const c = contenu();
  if (!c) return res.status(503).json({ ok: false, error: "Le contenu du cours n'est pas encore installé sur le serveur." });
  const dev = String((req.body && req.body.device_id) || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(dev)) return res.status(400).json({ ok: false, error: "Rechargez la page, puis réessayez." });
  const v = await verifierCle(cle);
  if (!v.ok) return res.status(v.statut).json({ ok: false, error: v.erreur });
  const a = await autoriserAppareil(cle, dev);
  if (!a.ok) return res.status(a.statut).json({ ok: false, error: a.erreur });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, preview: false, email: v.email, course: c });
});


// ── Administration : voir / réinitialiser les appareils d'une clé ──
function adminOk(req) {
  const t = process.env.COURS_ADMIN_TOKEN || "";
  const recu = String((req.body && req.body.token) || "");
  if (!t || recu.length !== t.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recu), Buffer.from(t));
}
router.get("/admin", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Admin du cours</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h1 style="font-size:1.4rem">Appareils d'une clé</h1>
<p>Collez la clé de licence du client, puis choisissez une action.</p>
<form id="f"><p><label>Mot de passe admin<br><input id="t" type="password" style="width:100%;padding:8px" required></label></p>
<p><label>Clé de licence<br><input id="k" style="width:100%;padding:8px" required></label></p>
<button name="a" value="voir" style="padding:8px 14px">Voir</button>
<button name="a" value="vider" style="padding:8px 14px">Réinitialiser les appareils</button></form>
<p id="r" style="margin-top:16px;font-weight:600"></p>
<script>
document.getElementById("f").addEventListener("submit", async e => {
  e.preventDefault();
  const action = e.submitter.value;
  const r = await fetch("/cours/admin/" + action, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: document.getElementById("t").value, license_key: document.getElementById("k").value.trim() }) });
  const d = await r.json().catch(() => ({}));
  document.getElementById("r").textContent = d.message || d.error || "Erreur";
});
</script></body></html>`);
});
router.post("/admin/:action", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ ok: false, error: "Mot de passe incorrect, ou COURS_ADMIN_TOKEN absent sur Render." });
  const cle = String((req.body && req.body.license_key) || "").trim();
  if (!cle) return res.status(400).json({ ok: false, error: "Indiquez la clé de licence." });
  const k = cleAppareils(cle);
  try {
    if (req.params.action === "vider") {
      await appareils.vider(k);
      return res.json({ ok: true, message: "C'est fait : le client peut de nouveau activer sa clé sur " + maxAppareils() + " appareils." });
    }
    const n = (await appareils.liste(k)).length;
    return res.json({ ok: true, message: "Cette clé est utilisée sur " + n + " appareil(s) sur " + maxAppareils() + " autorisés." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Stockage indisponible : " + e.message });
  }
});

// Sur le sous-domaine du cours, la racine « / » affiche directement le cours
function racineSousDomaine(req, res, next) {
  const host = (process.env.COURS_HOST || "").toLowerCase().trim();
  if (host && req.method === "GET" && req.path === "/" && (req.hostname || "").toLowerCase() === host) {
    return envoyerPage(res);
  }
  next();
}

module.exports = { router, racineSousDomaine };
