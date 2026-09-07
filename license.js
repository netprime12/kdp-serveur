/* =========================================================================
   Vérification des licences / packs via Lemon Squeezy (+ cache court).

   Reconnaissance de l'offre achetée : on lit le NOM du produit/variante
   renvoyé par Lemon Squeezy (pas besoin de chercher des ID numériques).
     - nom contenant "abonn" / "mensuel" / "abo"      -> ABONNEMENT (quota mensuel)
     - nom contenant un nombre (10, 30, 100…)          -> PACK DE CRÉDITS de ce nombre
   (Un override par ID de variante reste possible via les variables
    d'environnement LEMON_VARIANT_* si tu veux être 100 % précis un jour.)

   Modes :
     DEV_OPEN=true -> aucune licence requise (tests) ; plan "dev"
     sinon         -> clé Lemon obligatoire
   ========================================================================= */

// Quota mensuel de l'abonnement + essai (modifiables via variables d'environnement)
function planLimits() {
  return {
    dev: parseInt(process.env.LIMIT_DEV || "1000", 10),
    abo: parseInt(process.env.LIMIT_ABO || "60", 10),   // abonnement unique 4,99 €
    trial: parseInt(process.env.LIMIT_TRIAL || "3", 10), // essai gratuit / an / appareil
  };
}

// (Optionnel) override précis par ID de variante Lemon.
function creditPacksById() {
  const m = {};
  if (process.env.LEMON_VARIANT_PACK10) m[process.env.LEMON_VARIANT_PACK10] = 10;
  if (process.env.LEMON_VARIANT_PACK30) m[process.env.LEMON_VARIANT_PACK30] = 30;
  if (process.env.LEMON_VARIANT_PACK100) m[process.env.LEMON_VARIANT_PACK100] = 100;
  return m;
}
function isSubscriptionVariantId(variantId) {
  const sub = String(process.env.LEMON_VARIANT_ABO || "");
  return sub && String(variantId) === sub;
}

// Classe l'achat à partir des noms (et des ID si fournis).
function classify({ variantId, variantName, productName }) {
  const limits = planLimits();

  // 1) Override précis par ID de variante (si tu les as renseignés un jour)
  if (isSubscriptionVariantId(variantId)) return { kind: "subscription", limit: limits.abo };
  const byId = creditPacksById();
  if (byId[String(variantId)]) return { kind: "credits", creditGrant: byId[String(variantId)] };

  // 2) Sinon, on lit les NOMS renvoyés par Lemon Squeezy
  const name = ((variantName || "") + " " + (productName || "")).toLowerCase();

  // Abonnement ?
  if (/abonn|mensuel|subscription|\babo\b/.test(name)) {
    return { kind: "subscription", limit: limits.abo };
  }
  // Pack de crédits ? -> on prend le nombre présent dans le nom
  //   "Pack Test — 10 recherches" -> 10 crédits, "… 100 …" -> 100 crédits
  let m = name.match(/(\d+)\s*(cr[ée]dit|recherche)/);
  if (!m) m = name.match(/pack[^0-9]*(\d+)/);
  if (!m) m = name.match(/(\d+)/);
  if (m) return { kind: "credits", creditGrant: parseInt(m[1], 10) };

  // 3) Par défaut : on considère un abonnement (évite de bloquer un vrai client)
  return { kind: "subscription", limit: limits.abo };
}

// Cache mémoire court pour éviter d'appeler Lemon à chaque analyse
const cache = new Map(); // key -> { at, result }
const TTL_MS = 10 * 60 * 1000; // 10 minutes

async function validateWithLemon(licenseKey) {
  const res = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ license_key: licenseKey }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  const valid = !!data.valid;
  const meta = data.meta || {};
  const status = (data.license_key && data.license_key.status) || "";
  return {
    valid: valid && status !== "expired",
    variantId: meta.variant_id || meta.variantId || "",
    variantName: meta.variant_name || "",
    productName: meta.product_name || "",
  };
}

/* Renvoie un objet décrivant la clé :
   { kind: "dev"|"subscription"|"credits"|"invalid"|"error"|"none",
     limit,          // quota mensuel si abonnement
     creditGrant }   // nb de crédits à créditer si pack
*/
async function checkLicense(licenseKey) {
  const limits = planLimits();

  if (String(process.env.DEV_OPEN).toLowerCase() === "true") {
    return { kind: "dev", limit: limits.dev };
  }
  if (!licenseKey) {
    return { kind: "none" }; // seul l'essai gratuit est possible
  }

  const now = Date.now();
  const cached = cache.get(licenseKey);
  if (cached && now - cached.at < TTL_MS) return cached.result;

  let result;
  try {
    const info = await validateWithLemon(licenseKey);
    result = info.valid ? classify(info) : { kind: "invalid" };
  } catch (_) {
    result = { kind: "error" }; // panne Lemon -> on proposera de réessayer
  }
  cache.set(licenseKey, { at: now, result });
  return result;
}

module.exports = { checkLicense, planLimits, classify };
