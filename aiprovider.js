/* =========================================================================
   Adaptateur multi-fournisseurs IA — Mistral (primaire) + Gemini (secours)
   -------------------------------------------------------------------------
   - Expose la MÊME fonction generate(prompt) que l'ancien keypool.
     => server.js n'a qu'à changer sa ligne d'import, rien d'autre.
   - Ordre des fournisseurs réglé par AI_PROVIDER_ORDER (ex. "mistral,gemini").
   - Pour chaque fournisseur : rotation de clés + bascule automatique.
   - Si un fournisseur n'a PAS de clés configurées, on le saute (pas d'erreur)
     => tant que tu n'as pas mis MISTRAL_KEYS, tout part sur Gemini comme avant.
   ========================================================================= */

const keypool = require("./keypool"); // moteur Gemini existant (rotation de clés)

const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

/* --- Clés Mistral : "cle1,cle2,..." --------------------------------------- */
function getMistralKeys() {
  return (process.env.MISTRAL_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

let mcursor = 0; // position courante pour la rotation Mistral

async function callMistralOnce(apiKey, prompt, model) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error("Mistral " + res.status + " : " + body.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text =
    (data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    "";
  if (!text) throw new Error("Réponse Mistral vide.");
  return text;
}

// Essaie les clés Mistral à tour de rôle jusqu'à ce qu'une réponde.
async function generateMistral(prompt, model) {
  const keys = getMistralKeys();
  if (!keys.length) {
    const e = new Error("Aucune clé Mistral configurée (variable MISTRAL_KEYS).");
    e.status = 500;
    throw e;
  }
  const mdl = model || MISTRAL_MODEL;
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(mcursor + i) % keys.length];
    try {
      const text = await callMistralOnce(key, prompt, mdl);
      mcursor = (mcursor + i + 1) % keys.length; // avance pour la prochaine requête
      return text;
    } catch (e) {
      lastErr = e;
      // 429 (débit 1 req/s dépassé), 5xx ou réseau : on tente la clé suivante.
      continue;
    }
  }
  const e = new Error(
    "Toutes les clés Mistral ont échoué. Dernière erreur : " +
      (lastErr ? lastErr.message : "inconnue")
  );
  e.status = 503;
  throw e;
}

/* --- Ordre des fournisseurs ----------------------------------------------- */
function providerOrder() {
  const raw = (process.env.AI_PROVIDER_ORDER || "gemini").toLowerCase();
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ["gemini"];
}

/* --- Point d'entrée unique : generate(prompt) ----------------------------- */
// Chaque fournisseur utilise SON propre modèle (MISTRAL_MODEL / GEMINI_MODEL),
// donc on n'impose pas de modèle ici : on laisse chacun prendre son défaut.
async function generate(prompt /*, model (ignoré : défaut par fournisseur) */) {
  const order = providerOrder();
  let lastErr;
  for (const p of order) {
    try {
      if (p === "mistral") {
        if (!getMistralKeys().length) continue; // pas de clés -> fournisseur suivant
        return await generateMistral(prompt);
      }
      if (p === "gemini") {
        if (!keypool.getKeys().length) continue; // pas de clés -> fournisseur suivant
        return await keypool.generate(prompt); // rotation Gemini + modèle GEMINI_MODEL
      }
      // fournisseur inconnu -> ignoré
    } catch (e) {
      lastErr = e; // ce fournisseur a échoué -> on bascule sur le suivant
      continue;
    }
  }
  const e = new Error(
    "Aucun fournisseur IA disponible. " +
      (lastErr ? "Dernière erreur : " + lastErr.message : "Vérifie MISTRAL_KEYS / GEMINI_KEYS.")
  );
  e.status = 503;
  throw e;
}

module.exports = { generate, generateMistral, providerOrder, getMistralKeys };
