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
  const v = await verifierCle(cle);
  if (!v.ok) return res.status(v.statut).json({ ok: false, error: v.erreur });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, preview: false, email: v.email, course: c });
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
