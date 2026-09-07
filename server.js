/* =========================================================================
   Serveur de l'analyseur de niches KDP (abonnement + crédits)
   - /health           : test de vie
   - /verifier-licence : état d'une clé (abonnement ? crédits ? essai ?)
   - /analyse          : vérifie droits + quota, puis appelle Gemini (pool de clés)

   Ordre de consommation d'une recherche :
     1) quota MENSUEL de l'abonnement (si abonné et quota restant)
     2) CRÉDITS non expirants (si solde > 0)
     3) ESSAI gratuit annuel par appareil (si aucune licence)
   ========================================================================= */
// Chargement simple du .env (sans dépendance) pour les tests locaux.
(function loadEnv() {
  try {
    const fs = require("fs"), path = require("path");
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch (_) {}
})();

const express = require("express");
const cors = require("cors");
const { generate } = require("./keypool");
const { checkLicense } = require("./license");
const store = require("./store");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "kdp-analyzer-server", time: new Date().toISOString() });
});

// Page d'accueil simple (utile pour vérifier que le service tourne)
app.get("/", (_req, res) => {
  res.type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Analyseur KDP</title>
     <div style="font:16px/1.5 system-ui;max-width:640px;margin:60px auto;padding:0 20px">
     <h1>Analyseur de niches KDP</h1>
     <p>Le service fonctionne ✅</p>
     <p><a href="/confidentialite">Politique de confidentialité</a></p>
     </div>`
  );
});

// Politique de confidentialité (URL exigée par le Chrome Web Store)
app.get("/confidentialite", (_req, res) => {
  const email = process.env.SUPPORT_EMAIL || "ton-email@exemple.com";
  const maj = new Date().toISOString().slice(0, 10);
  res.type("html").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Politique de confidentialité — Analyseur de niches KDP</title>
<style>body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a}
h1{font-size:24px}h2{font-size:18px;margin-top:28px}
.small{color:#666;font-size:14px}code{background:#f2f2ef;padding:1px 5px;border-radius:4px}</style>
</head><body>
<h1>Politique de confidentialité</h1>
<p class="small">Extension « Analyseur de niches KDP » — dernière mise à jour : ${maj}</p>

<p>Cette extension aide à analyser des niches de livres sur Amazon. Cette page explique
quelles données sont traitées et pourquoi. Nous collectons le strict minimum et ne
vendons aucune donnée.</p>

<h2>1. Données traitées</h2>
<ul>
<li><b>Identifiant d'appareil anonyme</b> : un identifiant aléatoire (généré par
l'extension) sert uniquement à compter les recherches de l'essai gratuit. Il ne
contient aucune information personnelle et ne permet pas de vous identifier.</li>
<li><b>Clé de licence</b> : si vous êtes abonné ou avez acheté des crédits, votre clé
est envoyée au serveur pour vérifier vos droits et votre quota.</li>
<li><b>Données d'analyse</b> : lorsque vous lancez une analyse, les informations de la
page Amazon consultée (titres, prix, classements publics) et votre demande sont
envoyées à notre serveur, puis à l'API Google Gemini, afin de générer l'analyse.</li>
</ul>

<h2>2. Ce que nous ne faisons pas</h2>
<ul>
<li>Aucune vente ni location de données à des tiers.</li>
<li>Aucune publicité.</li>
<li>Aucune collecte de données de navigation en dehors des pages Amazon que vous
analysez volontairement.</li>
<li>Aucune donnée de paiement n'est traitée par l'extension : les paiements sont gérés
par notre prestataire (Lemon Squeezy).</li>
</ul>

<h2>3. Prestataires (sous-traitants)</h2>
<ul>
<li><b>Google (API Gemini)</b> — génération des analyses par IA.</li>
<li><b>Lemon Squeezy</b> — paiement, TVA et gestion des licences.</li>
<li><b>Hébergeur du serveur</b> — exécution du service.</li>
</ul>

<h2>4. Conservation</h2>
<p>Les compteurs d'usage (essai, quota mensuel, crédits) sont conservés le temps
nécessaire à la gestion de votre accès au service.</p>

<h2>5. Vos droits</h2>
<p>Vous pouvez demander l'accès à vos données ou leur suppression en écrivant à :
<a href="mailto:${email}">${email}</a>.</p>

<h2>6. Contact</h2>
<p>Pour toute question : <a href="mailto:${email}">${email}</a>.</p>
</body></html>`);
});

/* Construit un résumé de l'état d'une clé (pour l'extension). */
async function statusFor(license, deviceId) {
  const info = await checkLicense(license);

  if (info.kind === "error") {
    return { error: "verification_indisponible" };
  }
  if (info.kind === "dev") {
    const used = await store.getMonthly("dev");
    return {
      active: true, plan: "dev", limit: info.limit, used,
      restant: Math.max(0, info.limit - used), resetsAt: store.monthlyResetsAt(),
    };
  }
  if (info.kind === "subscription") {
    const id = "lic:" + license;
    const used = await store.getMonthly(id);
    const credits = await store.getCredits(license);
    return {
      active: true, plan: "abo", limit: info.limit, used,
      restant: Math.max(0, info.limit - used) + credits,
      credits, resetsAt: store.monthlyResetsAt(),
    };
  }
  if (info.kind === "credits") {
    await store.grantCreditsOnce(license, info.creditGrant); // crédite une seule fois
    const credits = await store.getCredits(license);
    return { active: credits > 0, plan: "credits", credits, restant: credits };
  }
  if (info.kind === "invalid") {
    return { active: false, plan: null, restant: 0 };
  }
  // kind === "none" -> essai gratuit
  const usedTrial = await store.getTrial(deviceId);
  const limitTrial = require("./license").planLimits().trial;
  return {
    active: false, plan: "trial", limit: limitTrial, used: usedTrial,
    restant: Math.max(0, limitTrial - usedTrial), resetsAt: store.trialResetsAt(),
  };
}

// État d'une licence (bouton "Vérifier ma licence" de l'extension)
app.post("/verifier-licence", async (req, res) => {
  try {
    const license = (req.body && req.body.license) || "";
    const deviceId = (req.body && req.body.deviceId) || "";
    res.json(await statusFor(license, deviceId));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Analyse : cœur du service
app.post("/analyse", async (req, res) => {
  try {
    const body = req.body || {};
    const license = body.license || "";
    const deviceId = body.deviceId || "";
    const prompt = body.prompt || "";
    if (!prompt) return res.status(400).json({ ok: false, error: "prompt manquant" });

    const info = await checkLicense(license);

    if (info.kind === "error") {
      return res.status(503).json({
        ok: false, error: "verification_indisponible",
        message: "Vérification de la licence momentanément indisponible. Réessaie dans un instant.",
      });
    }
    if (info.kind === "invalid") {
      return res.status(402).json({
        ok: false, error: "abonnement_inactif",
        message: "Clé invalide, expirée ou annulée. Abonne-toi ou achète un pack de crédits.",
      });
    }
    if (info.kind === "credits") {
      await store.grantCreditsOnce(license, info.creditGrant); // crédite une seule fois
    }

    // Choix du "compteur" à débiter, SANS débiter tout de suite (on ne débite qu'en cas de succès IA).
    const limits = require("./license").planLimits();
    let bucket = null; // "monthly" | "credits" | "trial"
    let ctx = {};

    if (info.kind === "dev") {
      bucket = "dev";
    } else if (info.kind === "subscription") {
      const id = "lic:" + license;
      const used = await store.getMonthly(id);
      if (used < info.limit) { bucket = "monthly"; ctx = { id, limit: info.limit }; }
      else if (await store.getCredits(license) > 0) { bucket = "credits"; }
      else {
        return res.status(429).json({
          ok: false, error: "quota_atteint",
          message: "Quota mensuel atteint. Il se réinitialise le mois prochain, ou achète un pack de crédits.",
          used, limit: info.limit, resetsAt: store.monthlyResetsAt(),
        });
      }
    } else if (info.kind === "credits") {
      if (await store.getCredits(license) > 0) { bucket = "credits"; }
      else {
        return res.status(429).json({
          ok: false, error: "credits_epuises",
          message: "Crédits épuisés. Achète un nouveau pack ou abonne-toi.",
        });
      }
    } else {
      // kind === "none" -> essai gratuit annuel par appareil
      if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId requis pour l'essai gratuit" });
      const usedTrial = await store.getTrial(deviceId);
      if (usedTrial < limits.trial) { bucket = "trial"; ctx = { limit: limits.trial }; }
      else {
        return res.status(402).json({
          ok: false, error: "essai_termine",
          message: "Essai gratuit épuisé pour cette année. Abonne-toi (4,99 €) ou achète un pack de crédits pour continuer.",
          used: usedTrial, limit: limits.trial, resetsAt: store.trialResetsAt(),
        });
      }
    }

    // Appel IA (pool de clés Gemini, bascule automatique)
    const text = await generate(prompt);

    // On ne débite qu'en cas de succès
    let restant = null, used = null, limit = null, credits = null;
    if (bucket === "monthly") {
      used = await store.incrementMonthly(ctx.id);
      limit = ctx.limit;
      credits = await store.getCredits(license);
      restant = Math.max(0, limit - used) + credits;
    } else if (bucket === "credits") {
      credits = await store.consumeCredit(license);
      restant = credits;
    } else if (bucket === "trial") {
      used = await store.incrementTrial(deviceId);
      limit = ctx.limit;
      restant = Math.max(0, limit - used);
    } else if (bucket === "dev") {
      used = await store.incrementMonthly("dev");
      limit = info.limit;
      restant = Math.max(0, limit - used);
    }

    res.json({ ok: true, text, used, limit, credits, restant });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("KDP Analyzer server en écoute sur le port " + PORT);
  console.log("Mode DEV_OPEN =", String(process.env.DEV_OPEN).toLowerCase() === "true");
  console.log("Stockage =", store.mode === "redis" ? "Redis Upstash (persistant)" : "fichier local");
});
