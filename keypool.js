/* =========================================================================
   Pool de clés Gemini — rotation + bascule automatique (failover)
   - On tourne d'une clé à l'autre (round-robin) pour répartir la charge.
   - Si une clé renvoie une erreur de limite (429) ou une panne (5xx),
     on essaie la clé suivante automatiquement.
   ========================================================================= */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

function getKeys() {
  // GEMINI_KEYS = "cle1,cle2,..." (clés issues de TON compte, idéalement facturé)
  return (process.env.GEMINI_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

let cursor = 0; // position courante pour la rotation

async function callGeminiOnce(apiKey, prompt, model) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error("Gemini " + res.status + " : " + body.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text =
    (data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts.map((p) => p.text).join("")) ||
    "";
  if (!text) throw new Error("Réponse Gemini vide.");
  return text;
}

// Essaie les clés du pool à tour de rôle jusqu'à ce que l'une réponde.
async function generate(prompt, model) {
  const keys = getKeys();
  if (!keys.length) {
    const e = new Error("Aucune clé Gemini configurée (variable GEMINI_KEYS).");
    e.status = 500;
    throw e;
  }
  const mdl = model || DEFAULT_MODEL;
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(cursor + i) % keys.length];
    try {
      const text = await callGeminiOnce(key, prompt, mdl);
      cursor = (cursor + i + 1) % keys.length; // avance pour la prochaine requête
      return text;
    } catch (e) {
      lastErr = e;
      // On bascule sur la clé suivante en cas de limite (429) ou panne serveur (5xx)
      const s = e.status || 0;
      if (s === 429 || (s >= 500 && s <= 599) || s === 0) continue;
      // Erreur "définitive" (ex. clé invalide 400/403) : inutile d'insister sur celle-ci
      continue;
    }
  }
  const e = new Error(
    "Toutes les clés Gemini ont échoué. Dernière erreur : " +
      (lastErr ? lastErr.message : "inconnue")
  );
  e.status = 503;
  throw e;
}

module.exports = { generate, getKeys };
