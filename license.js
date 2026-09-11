/* =========================================================================
   Vérification des licences / packs via GUMROAD (+ cache court).

   Gumroad fournit une clé de licence à chaque achat. On la vérifie via
   l'API publique https://api.gumroad.com/v2/licenses/verify (product_id + key).
   On configure l'ID de chaque produit Gumroad dans les variables d'env :
     GUMROAD_PRODUCT_ABO    -> abonnement (quota mensuel)
     GUMROAD_PRODUCT_PACK10 -> pack 10 crédits
     GUMROAD_PRODUCT_PACK30 -> pack 30 crédits
     GUMROAD_PRODUCT_PACK100-> pack 100 crédits

   Modes :
     DEV_OPEN=true -> aucune licence requise (tests) ; plan "dev"
     sinon         -> clé Gumroad obligatoire
   ========================================================================= */

// Quota mensuel de l'abonnement + essai (modifiables via variables d'environnement)
function planLimits() {
  return {
    dev: parseInt(process.env.LIMIT_DEV || "1000", 10),
    abo: parseInt(process.env.LIMIT_ABO || "60", 10),
    trial: parseInt(process.env.LIMIT_TRIAL || "3", 10),
  };
}

// Liste des IDs de produits Gumroad à essayer (l'offre est ensuite déduite
// du NOM du produit renvoyé par Gumroad, pas de l'ordre des variables).
// Un même serveur peut alimenter PLUSIEURS extensions : ajoute tous les
// product IDs (KDP + MarketScout + ...) dans GUMROAD_PRODUCT_IDS
// (liste séparée par des virgules). Les 4 variables nommées restent gérées
// pour compatibilité.
function gumroadProductIds() {
  const named = [
    process.env.GUMROAD_PRODUCT_ABO,
    process.env.GUMROAD_PRODUCT_PACK10,
    process.env.GUMROAD_PRODUCT_PACK30,
    process.env.GUMROAD_PRODUCT_PACK100,
    process.env.GUMROAD_PRODUCT_EXTRA,
  ];
  const list = (process.env.GUMROAD_PRODUCT_IDS || "")
    .split(",")
    .map((s) => s.trim());
  // dédoublonnage + suppression des vides
  return [...new Set([...named, ...list].filter(Boolean))];
}

// Déduit l'offre à partir du nom du produit/variante renvoyé par Gumroad.
// - "Abonnement …" -> abonnement (quota mensuel = 1er nombre trouvé, sinon LIMIT_ABO)
// - "… 10/30/100 …" -> pack de crédits de ce nombre
function classifyByName(purchase) {
  const limits = planLimits();
  const name = (
    (purchase.product_name || "") + " " + (purchase.variants || "")
  ).toLowerCase();
  if (/abonn|mensuel|subscription|\babo\b/.test(name)) {
    // quota mensuel : un nombre dans le nom (ex. "100 analyses/mois") sinon défaut
    const mm = name.match(/(\d{1,4})/);
    const limit = mm ? parseInt(mm[1], 10) : limits.abo;
    return { kind: "subscription", limit };
  }
  let m = name.match(/(\d+)\s*(cr[ée]dit|recherche|analyse)/);
  if (!m) m = name.match(/(\d{1,4})/);
  if (m) return { kind: "credits", creditGrant: parseInt(m[1], 10) };
  // Par défaut : abonnement (évite de bloquer un vrai client)
  return { kind: "subscription", limit: limits.abo };
}

// Cache mémoire court pour éviter d'appeler Gumroad à chaque analyse
const cache = new Map(); // key -> { at, result }
const TTL_MS = 10 * 60 * 1000; // 10 minutes

// Appel API Gumroad. On accepte aussi bien un ID de produit qu'un permalien
// (la fin de l'URL gumroad.com/l/XXXX) : on essaie les deux champs.
// Lève une erreur en cas de panne réseau ; renvoie {success:false} si non reconnu.
async function verifyGumroad(value, licenseKey) {
  for (const field of ["product_id", "product_permalink"]) {
    const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        [field]: value,
        license_key: licenseKey,
        increment_uses_count: "false", // on ne gonfle pas le compteur d'usages Gumroad
      }).toString(),
    });
    const data = await res.json().catch(() => ({ success: false }));
    if (data && data.success) return data;
  }
  return { success: false };
}

// Un achat est-il encore "vivant" (ni remboursé, ni contesté) ?
function purchaseAlive(p) {
  if (!p) return false;
  if (p.refunded || p.disputed || p.chargebacked) return false;
  return true;
}
// L'abonnement est-il encore actif (pas terminé/échoué) ?
function subscriptionActive(p) {
  if (!purchaseAlive(p)) return false;
  // subscription_cancelled_at seul = résilié mais actif jusqu'à la fin de période.
  // subscription_ended_at / subscription_failed_at = réellement terminé.
  if (p.subscription_ended_at) return false;
  if (p.subscription_failed_at) return false;
  return true;
}

/* Renvoie { kind: "dev"|"subscription"|"credits"|"invalid"|"error"|"none", limit, creditGrant } */
async function checkLicense(licenseKey) {
  const limits = planLimits();

  if (String(process.env.DEV_OPEN).toLowerCase() === "true") {
    return { kind: "dev", limit: limits.dev };
  }
  if (!licenseKey) return { kind: "none" };

  const now = Date.now();
  const cached = cache.get(licenseKey);
  if (cached && now - cached.at < TTL_MS) return cached.result;

  const productIds = gumroadProductIds();
  let result = { kind: "invalid" };
  let hadError = false;

  try {
    // On essaie la clé contre chacun de nos produits jusqu'à trouver le bon.
    for (const id of productIds) {
      let data;
      try {
        data = await verifyGumroad(id, licenseKey);
      } catch (_) {
        hadError = true;
        continue;
      }
      if (data && data.success && data.purchase) {
        const p = data.purchase;
        const offer = classifyByName(p); // { kind: subscription|credits, ... }
        if (offer.kind === "subscription") {
          result = subscriptionActive(p) ? offer : { kind: "invalid" };
        } else {
          result = purchaseAlive(p) ? offer : { kind: "invalid" };
        }
        break; // clé reconnue, on arrête
      }
    }
    // Si aucune correspondance mais qu'une requête a planté -> erreur (réessai possible)
    if (result.kind === "invalid" && hadError) result = { kind: "error" };
  } catch (_) {
    result = { kind: "error" };
  }

  // On ne met en cache que les résultats stables (pas les erreurs réseau)
  if (result.kind !== "error") cache.set(licenseKey, { at: now, result });
  return result;
}

module.exports = { checkLicense, planLimits, gumroadProductIds, classifyByName };
