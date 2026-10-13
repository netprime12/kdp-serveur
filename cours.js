// ============================================================
// cours.js — Cours de langues Éclozia (anglais, espagnol, allemand)
// Monté dans server.js :
//   const cours = require("./cours");
//   app.use(cours.racineSousDomaine);   // AVANT app.get("/")
//   app.use("/cours", cours.router);    // anglais (adresse historique)
//   app.use("/espagnol", cours.routers.espagnol);
//   app.use("/allemand", cours.routers.allemand);
//
// Routes de chaque cours (préfixe /cours, /espagnol ou /allemand) :
//   GET  /            → la page du cours
//   GET  /preview     → modules gratuits, sans clé
//   POST /activate    → { license_key, device_id } → vérifie Gumroad → cours complet
//   GET  /og.png      → image de partage (réseaux sociaux)
// Administration commune : /cours/admin (choix du cours dans la page)
//
// Sur chaque sous-domaine (COURS_HOST, ESPAGNOL_HOST, ALLEMAND_HOST) :
//   /  → la page du cours · /robots.txt · /sitemap.xml · /og.png
//
// Variables d'environnement (Render), par cours :
//   Anglais  : GUMROAD_PRODUCT_COURS,    COURS_GUMROAD_URL,    COURS_PRIX,    COURS_HOST
//   Espagnol : GUMROAD_PRODUCT_ESPAGNOL, ESPAGNOL_GUMROAD_URL, ESPAGNOL_PRIX, ESPAGNOL_HOST
//   Allemand : GUMROAD_PRODUCT_ALLEMAND, ALLEMAND_GUMROAD_URL, ALLEMAND_PRIX, ALLEMAND_HOST
// Communes :
//   COURS_MAX_APPAREILS  appareils autorisés par clé (défaut : 3)
//   COURS_ADMIN_TOKEN    mot de passe de la page /cours/admin
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN : mémoire permanente des appareils
//
// Contenu des cours : fichiers secrets Render (jamais dans le dépôt public) :
//   cours-content.json · espagnol-content.json · allemand-content.json
//
// IMPORTANT : ne PAS ajouter ces ID de produits à GUMROAD_PRODUCT_IDS,
// sinon une clé de cours donnerait accès aux analyses IA des extensions.
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TTL_MS = 6 * 60 * 60 * 1000; // une clé vérifiée reste en mémoire 6 h

// ── Description des cours ──────────────────────────────────────
const COURS = {
  anglais: {
    slug: "anglais", base: "/cours", page: "cours.html", fichier: "cours-content.json",
    envContenu: "COURS_CONTENT_PATH", envProduit: "GUMROAD_PRODUCT_COURS", envUrl: "COURS_GUMROAD_URL",
    envPrix: "COURS_PRIX", envHost: "COURS_HOST", hostDefaut: "parleranglais.geteclozia.com",
    prixDefaut: "12 $", gratuits: [1, 3],
    nom: "Parler anglais au centre d'appel",
    titreSeo: "Parler anglais au centre d'appel — Cours audio interactif | Éclozia",
    descSeo: "Cours interactif pour agents de centre d'appel francophones : plus de 300 phrases à écouter et à répéter au micro, 11 dialogues et des exercices corrigés. 2 modules gratuits.",
  },
  espagnol: {
    slug: "espagnol", base: "/espagnol", page: "langue.html", fichier: "espagnol-content.json",
    envContenu: "ESPAGNOL_CONTENT_PATH", envProduit: "GUMROAD_PRODUCT_ESPAGNOL", envUrl: "ESPAGNOL_GUMROAD_URL",
    envPrix: "ESPAGNOL_PRIX", envHost: "ESPAGNOL_HOST", hostDefaut: "parlerespagnol.geteclozia.com",
    prixDefaut: "12 $", gratuits: [2, 3],
    nom: "Parler espagnol",
    titreSeo: "Apprendre l'espagnol : cours audio interactif pour francophones | Éclozia",
    descSeo: "Apprenez l'espagnol en parlant : plus de 400 phrases à écouter et à répéter au micro, de débutant à intermédiaire, avec grammaire, dialogues et exercices corrigés. 2 modules gratuits.",
  },
  allemand: {
    slug: "allemand", base: "/allemand", page: "langue.html", fichier: "allemand-content.json",
    envContenu: "ALLEMAND_CONTENT_PATH", envProduit: "GUMROAD_PRODUCT_ALLEMAND", envUrl: "ALLEMAND_GUMROAD_URL",
    envPrix: "ALLEMAND_PRIX", envHost: "ALLEMAND_HOST", hostDefaut: "parlerallemand.geteclozia.com",
    prixDefaut: "12 $", gratuits: [2, 3],
    nom: "Parler allemand",
    titreSeo: "Apprendre l'allemand : cours audio interactif pour francophones | Éclozia",
    descSeo: "Apprenez l'allemand en parlant : plus de 400 phrases à écouter et à répéter au micro, de débutant à intermédiaire, avec grammaire, dialogues et exercices corrigés. 2 modules gratuits.",
  },
};
const env = (k, d) => (process.env[k] || d || "").trim();
const hostDe = c => env(c.envHost, c.hostDefaut).toLowerCase();
const urlSite = c => "https://" + hostDe(c) + "/";

// ── Contenu (fichiers secrets) ─────────────────────────────────
const _contenus = {};
function contenu(c) {
  if (_contenus[c.slug]) return _contenus[c.slug];
  const candidats = [process.env[c.envContenu], "/etc/secrets/" + c.fichier, path.join(__dirname, c.fichier)].filter(Boolean);
  for (const p of candidats) {
    try {
      if (fs.existsSync(p)) { _contenus[c.slug] = JSON.parse(fs.readFileSync(p, "utf8")); return _contenus[c.slug]; }
    } catch (e) { console.error("[cours] fichier illisible :", p, e.message); }
  }
  return null;
}

// ── Pages HTML ─────────────────────────────────────────────────
const _pages = {};
const echapJs = s => String(s).replace(/[\\"<>]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
const echapHtml = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
function prixNombre(p) { const m = String(p).replace(",", ".").match(/\d+(\.\d+)?/); return m ? m[0] : "12"; }

function seoHead(c) {
  const url = urlSite(c);
  const prix = env(c.envPrix, c.prixDefaut);
  const ld = {
    "@context": "https://schema.org",
    "@type": "Course",
    name: c.nom,
    description: c.descSeo,
    inLanguage: "fr",
    url,
    image: url + "og.png",
    provider: { "@type": "Organization", name: "Éclozia", url: "https://geteclozia.com" },
    offers: { "@type": "Offer", category: "Paid", price: prixNombre(prix), priceCurrency: "CAD", url: env(c.envUrl, url) },
    hasCourseInstance: { "@type": "CourseInstance", courseMode: "Online", courseWorkload: "PT15H" },
  };
  return [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Éclozia">`,
    `<meta property="og:locale" content="fr_FR">`,
    `<meta property="og:title" content="${echapHtml(c.titreSeo)}">`,
    `<meta property="og:description" content="${echapHtml(c.descSeo)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${url}og.png">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${echapHtml(c.titreSeo)}">`,
    `<meta name="twitter:description" content="${echapHtml(c.descSeo)}">`,
    `<meta name="twitter:image" content="${url}og.png">`,
    `<meta name="theme-color" content="#13233A">`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`,
  ].join("\n");
}

function page(c) {
  if (!_pages[c.page]) _pages[c.page] = fs.readFileSync(path.join(__dirname, c.page), "utf8");
  const data = contenu(c);
  const config = {
    slug: c.slug,
    api: c.base,
    gumroadUrl: env(c.envUrl, "#"),
    price: env(c.envPrix, c.prixDefaut),
    free: c.gratuits,
    titles: data ? data.modules.map(m => m.title) : [],
    landing: data ? data.landing || null : null,
    target: data ? data.target || null : null,
    sites: Object.fromEntries(Object.values(COURS).map(x => [x.slug, urlSite(x)])),
  };
  const remplacements = [
    ["<!--SEO-->", seoHead(c)],
    ["__TITRE_SEO__", echapHtml(c.titreSeo)],
    ["__DESC_SEO__", echapHtml(c.descSeo)],
    ["__GUMROAD_URL__", echapJs(config.gumroadUrl)],
    ["__PRIX__", echapJs(config.price)],
    ["__LIEN_ESPAGNOL__", urlSite(COURS.espagnol)],
    ["__LIEN_ALLEMAND__", urlSite(COURS.allemand)],
    ["__LIEN_ANGLAIS__", urlSite(COURS.anglais)],
    ['"__CONFIG_JSON__"', JSON.stringify(config).replace(/</g, "\\u003c")],
  ];
  return remplacements.reduce((html, [a, b]) => html.split(a).join(b), _pages[c.page]);
}
function envoyerPage(c, res) {
  res.set("Cache-Control", "no-cache");
  res.type("html").send(page(c));
}
function envoyerOg(c, res) {
  const f = path.join(__dirname, "og-" + c.slug + ".png");
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=86400");
  res.type("png").send(fs.readFileSync(f));
}

// ── Vérification Gumroad ───────────────────────────────────────
const _cache = new Map();
async function verifierCle(c, cle) {
  const productId = env(c.envProduit);
  if (!productId) return { ok: false, statut: 500, erreur: "Serveur mal configuré (" + c.envProduit + " manquant)." };

  const k = crypto.createHash("sha256").update(productId + ":" + cle).digest("hex");
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.res;

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
    res = { ok: false, statut: 403, erreur: "Cette clé de licence n'est pas reconnue pour ce cours. Vérifiez-la dans votre courriel de Gumroad." };
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
// Même formule qu'avant pour l'anglais : les appareils déjà enregistrés restent valables.
function cleAppareils(c, cle) {
  return "cours:appareils:" + crypto.createHash("sha256").update(env(c.envProduit) + ":" + cle).digest("hex").slice(0, 40);
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
async function autoriserAppareil(c, cle, dev) {
  const k = cleAppareils(c, cle);
  try {
    const deja = await appareils.liste(k);
    if (deja.includes(dev)) return { ok: true };
    if (deja.length >= maxAppareils()) {
      return { ok: false, statut: 403, erreur: "Cette clé est déjà utilisée sur " + maxAppareils() + " appareils, le maximum autorisé. Pour réinitialiser vos appareils, écrivez à contact@geteclozia.com avec le courriel de votre achat." };
    }
    await appareils.ajouter(k, dev);
    return { ok: true };
  } catch (e) {
    console.error("[cours] appareils :", e.message);
    return { ok: true }; // stockage en panne : on ne bloque pas un vrai client
  }
}

// ── Routes d'un cours ──────────────────────────────────────────
function creerRouter(c) {
  const router = express.Router();
  router.get("/", (_req, res) => envoyerPage(c, res));
  router.get("/og.png", (_req, res) => envoyerOg(c, res));

  router.get("/preview", (_req, res) => {
    const data = contenu(c);
    if (!data) return res.status(503).json({ ok: false, error: "Le contenu du cours n'est pas encore installé sur le serveur." });
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, preview: true, course: { ...data, modules: data.modules.filter(m => c.gratuits.includes(m.id)) } });
  });

  router.post("/activate", async (req, res) => {
    const cle = String((req.body && req.body.license_key) || "").trim();
    if (!cle || cle.length > 100) return res.status(400).json({ ok: false, error: "Clé de licence manquante ou invalide." });
    const data = contenu(c);
    if (!data) return res.status(503).json({ ok: false, error: "Le contenu du cours n'est pas encore installé sur le serveur." });
    const dev = String((req.body && req.body.device_id) || "").trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(dev)) return res.status(400).json({ ok: false, error: "Rechargez la page, puis réessayez." });
    const v = await verifierCle(c, cle);
    if (!v.ok) return res.status(v.statut).json({ ok: false, error: v.erreur });
    const a = await autoriserAppareil(c, cle, dev);
    if (!a.ok) return res.status(a.statut).json({ ok: false, error: a.erreur });
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, preview: false, email: v.email, course: data });
  });
  return router;
}
const routers = Object.fromEntries(Object.values(COURS).map(c => [c.slug, creerRouter(c)]));
const router = routers.anglais;

// ── Administration (commune aux 3 cours) ───────────────────────
function adminOk(req) {
  const t = process.env.COURS_ADMIN_TOKEN || "";
  const recu = String((req.body && req.body.token) || "");
  if (!t || recu.length !== t.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recu), Buffer.from(t));
}
router.get("/admin", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const options = Object.values(COURS).map(c => `<option value="${c.slug}">${echapHtml(c.nom)}</option>`).join("");
  res.type("html").send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Admin des cours</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h1 style="font-size:1.4rem">Appareils d'une clé</h1>
<p>Choisissez le cours, collez la clé de licence du client, puis choisissez une action.</p>
<form id="f"><p><label>Mot de passe admin<br><input id="t" type="password" style="width:100%;padding:8px" required></label></p>
<p><label>Cours<br><select id="c" style="width:100%;padding:8px">${options}</select></label></p>
<p><label>Clé de licence<br><input id="k" style="width:100%;padding:8px" required></label></p>
<button name="a" value="voir" style="padding:8px 14px">Voir</button>
<button name="a" value="vider" style="padding:8px 14px">Réinitialiser les appareils</button></form>
<p id="r" style="margin-top:16px;font-weight:600"></p>
<script>
document.getElementById("f").addEventListener("submit", async e => {
  e.preventDefault();
  const action = e.submitter.value;
  const r = await fetch("/cours/admin/" + action, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: document.getElementById("t").value, course: document.getElementById("c").value, license_key: document.getElementById("k").value.trim() }) });
  const d = await r.json().catch(() => ({}));
  document.getElementById("r").textContent = d.message || d.error || "Erreur";
});
</script></body></html>`);
});
router.post("/admin/:action", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ ok: false, error: "Mot de passe incorrect, ou COURS_ADMIN_TOKEN absent sur Render." });
  const c = COURS[String((req.body && req.body.course) || "anglais")];
  if (!c) return res.status(400).json({ ok: false, error: "Cours inconnu." });
  const cle = String((req.body && req.body.license_key) || "").trim();
  if (!cle) return res.status(400).json({ ok: false, error: "Indiquez la clé de licence." });
  const k = cleAppareils(c, cle);
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

// ── Sous-domaines : page, robots.txt, sitemap.xml, image de partage ──
function racineSousDomaine(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const host = (req.hostname || "").toLowerCase();
  const c = Object.values(COURS).find(x => hostDe(x) === host);
  if (!c) return next();
  if (req.path === "/") return envoyerPage(c, res);
  if (req.path === "/og.png") return envoyerOg(c, res);
  if (req.path === "/robots.txt") {
    res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /cours/admin\nSitemap: ${urlSite(c)}sitemap.xml\n`);
    return;
  }
  if (req.path === "/sitemap.xml") {
    const jour = new Date().toISOString().slice(0, 10);
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${urlSite(c)}</loc><lastmod>${jour}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`);
    return;
  }
  next();
}

module.exports = { router, routers, racineSousDomaine, COURS };
