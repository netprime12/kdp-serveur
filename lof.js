/* =========================================================================
   LOF — Local Opportunity Finder (Éclozia)
   -------------------------------------------------------------------------
   Audit de site web côté serveur + calcul DÉTERMINISTE de l'Opportunity Score
   (0-100) + niveau de confiance, selon un "playbook" de service. L'IA vient
   ensuite EXPLIQUER (problèmes observés + recommandation + brouillon de
   message) — elle ne calcule jamais le score.

   Conforme : on n'audite QUE le site fourni par l'utilisateur (déclenché par
   lui), pas de découverte en arrière-plan, pas de scraping tiers.
   ========================================================================= */
const { generate } = require("./aiprovider");

/* --- Playbooks : poids des 5 sous-scores (somme = 1) --------------------- */
// Sous-scores : besoin, acces (accessibilité), valeur, urgence, fraicheur.
const PLAYBOOKS = {
  site:        { label: "Création de site",   w: { besoin: 0.40, acces: 0.22, valeur: 0.18, urgence: 0.12, fraicheur: 0.08 } },
  seo:         { label: "SEO local",          w: { besoin: 0.38, acces: 0.22, valeur: 0.20, urgence: 0.12, fraicheur: 0.08 } },
  avis:        { label: "Gestion d'avis",     w: { besoin: 0.38, acces: 0.20, valeur: 0.20, urgence: 0.14, fraicheur: 0.08 } },
  reservation: { label: "Réservation",        w: { besoin: 0.40, acces: 0.20, valeur: 0.18, urgence: 0.14, fraicheur: 0.08 } },
  chatbot:     { label: "Chatbot IA",         w: { besoin: 0.36, acces: 0.22, valeur: 0.20, urgence: 0.14, fraicheur: 0.08 } },
  social:      { label: "Réseaux sociaux",    w: { besoin: 0.38, acces: 0.22, valeur: 0.18, urgence: 0.14, fraicheur: 0.08 } },
};
function playbook(key) {
  return PLAYBOOKS[key] || PLAYBOOKS.site;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* --- Audit d'un site web (une requête, limitée au domaine fourni) --------- */
async function auditSite(url) {
  const out = {
    reachable: false, status: 0, https: false, bytes: 0, ms: 0,
    hasViewport: false, hasTitle: false, hasMetaDesc: false, words: 0,
    booking: false, mailto: false, tel: false, social: false, error: null,
  };
  if (!url) { out.error = "no_url"; return out; }
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    out.https = /^https:/i.test(u);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const t0 = Date.now();
    const res = await fetch(u, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "EcloziaLocalScout/1.0 (+audit)" },
    });
    clearTimeout(t);
    out.ms = Date.now() - t0;
    out.status = res.status;
    out.reachable = res.ok;
    out.https = /^https:/i.test(res.url || u);
    let html = await res.text();
    if (html.length > 600000) html = html.slice(0, 600000);
    out.bytes = html.length;
    const low = html.toLowerCase();
    out.hasViewport = /<meta[^>]+name=["']?viewport/i.test(html);
    const mt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    out.hasTitle = !!(mt && mt[1].trim().length >= 1);
    out.hasMetaDesc = /<meta[^>]+name=["']?description["']?[^>]*content=["'][^"']{10,}/i.test(html);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.words = text ? text.split(" ").length : 0;
    out.booking = /(r[ée]serv|rendez-?vous|prendre\s+rdv|booking|calendly|book\s+now|take\s+appointment)/i.test(low);
    out.mailto = /mailto:/i.test(low) || /<form/i.test(low);
    out.tel = /tel:/i.test(low) || /(\+?\d[\d\s().-]{7,}\d)/.test(text.slice(0, 4000));
    out.social = /(facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|twitter\.com|x\.com)/i.test(low);
  } catch (e) {
    out.error = e.name === "AbortError" ? "timeout" : (e.code || e.message || "fetch_error");
  }
  return out;
}

/* --- Sous-scores déterministes (0..1) selon le playbook ------------------- */
function subscores(b, a, pb) {
  const rating = b.rating != null ? Number(b.rating) : null;      // 0..5
  const reviews = b.reviews != null ? Number(b.reviews) : null;   // entier
  const ticket = b.ticket != null ? Number(b.ticket) : null;      // valeur moyenne client
  const noSite = !a.reachable;
  const slow = a.reachable && a.ms > 3500;
  const notMobile = a.reachable && !a.hasViewport;
  const thin = a.reachable && a.words < 200;
  const weakSeo = a.reachable && (!a.hasTitle || !a.hasMetaDesc || a.words < 300);
  const lowRating = rating != null && rating < 4.0;
  const fewReviews = reviews != null && reviews < 15;

  // BESOIN détecté — dépend du service vendu
  let besoin = 0;
  if (pb === "site") {
    besoin = (noSite ? 1 : 0) || (0.35 * notMobile + 0.30 * slow + 0.35 * thin);
    if (noSite) besoin = 1;
  } else if (pb === "seo") {
    besoin = noSite ? 0.9 : (0.5 * weakSeo + 0.3 * thin + 0.2 * (fewReviews ? 1 : 0));
  } else if (pb === "avis") {
    // besoin fort si note basse ou peu d'avis (signaux fournis)
    if (rating == null && reviews == null) besoin = 0.4; // inconnu -> modéré
    else besoin = clamp01(0.6 * (lowRating ? 1 : (rating != null ? (5 - rating) / 1.5 : 0)) + 0.4 * (fewReviews ? 1 : 0));
  } else if (pb === "reservation") {
    besoin = noSite ? 0.85 : clamp01((a.booking ? 0 : 0.8) + 0.2 * notMobile);
  } else if (pb === "chatbot") {
    besoin = noSite ? 0.8 : clamp01((a.mailto ? 0.4 : 0.8) + 0.2 * thin);
  } else if (pb === "social") {
    besoin = clamp01((a.social ? 0.15 : 0.85) + 0.15 * (noSite ? 1 : 0));
  }
  besoin = clamp01(besoin);

  // ACCESSIBILITÉ — peut-on joindre un décideur ?
  let acces = 0;
  acces += a.mailto ? 0.5 : 0;
  acces += (a.tel || b.phone) ? 0.35 : 0;
  acces += (b.email) ? 0.15 : 0;
  if (!a.reachable && (b.phone || b.email)) acces = Math.max(acces, (b.phone ? 0.5 : 0) + (b.email ? 0.3 : 0));
  acces = clamp01(acces);

  // VALEUR potentielle (relative, jamais un CA prétendu)
  let valeur;
  if (ticket != null && !isNaN(ticket)) valeur = clamp01(ticket / 500); // 500+ = valeur haute
  else valeur = 0.5; // inconnu -> neutre

  // URGENCE — problèmes à impact immédiat
  let urgence = 0;
  urgence += noSite ? 0.5 : 0;
  urgence += (a.reachable && a.status >= 400) ? 0.5 : 0;
  urgence += (a.reachable && !a.https) ? 0.3 : 0;
  urgence += slow ? 0.2 : 0;
  urgence += lowRating ? 0.3 : 0;
  urgence = clamp01(urgence);

  // FRAÎCHEUR — données récentes/observées à l'instant
  let fraicheur = a.reachable ? 1 : (b.phone || rating != null ? 0.6 : 0.4);

  return { besoin, acces, valeur, urgence, fraicheur };
}

/* --- Confiance + pénalité qualité ---------------------------------------- */
function confidenceInfo(b, a) {
  // signaux attendus : site joignable, note, nb avis, un moyen de contact
  const expected = [
    a.reachable,
    b.rating != null,
    b.reviews != null,
    !!(a.mailto || a.tel || b.phone || b.email),
  ];
  const present = expected.filter(Boolean).length;
  const ratio = present / expected.length;
  let level = "Faible";
  if (ratio >= 0.8) level = "Élevée";
  else if (ratio >= 0.55) level = "Moyenne";
  const penalty = a.reachable ? 1 : (ratio >= 0.55 ? 0.92 : 0.85);
  return { level, ratio, penalty };
}

/* --- Liste de preuves lisibles ------------------------------------------- */
function evidence(b, a, pb) {
  const ev = [];
  if (!a.reachable) ev.push(a.error === "timeout" ? "Site trop lent ou injoignable (timeout)" : (a.error === "no_url" ? "Aucun site web fourni" : "Site web injoignable"));
  else {
    if (a.status >= 400) ev.push("Le site renvoie une erreur (" + a.status + ")");
    if (!a.https) ev.push("Site sans HTTPS (non sécurisé)");
    if (!a.hasViewport) ev.push("Site non optimisé mobile (pas de viewport)");
    if (a.ms > 3500) ev.push("Chargement lent (" + a.ms + " ms)");
    if (!a.hasTitle) ev.push("Balise <title> absente");
    if (!a.hasMetaDesc) ev.push("Méta-description absente");
    if (a.words < 200) ev.push("Contenu très pauvre (" + a.words + " mots)");
    if (pb === "reservation" && !a.booking) ev.push("Aucun système de réservation détecté");
    if (pb === "chatbot" && !a.mailto) ev.push("Aucun formulaire/contact clair détecté");
    if (pb === "social" && !a.social) ev.push("Aucun lien vers les réseaux sociaux");
  }
  if (b.rating != null && Number(b.rating) < 4.0) ev.push("Note faible : " + b.rating + "/5");
  if (b.reviews != null && Number(b.reviews) < 15) ev.push("Peu d'avis : " + b.reviews);
  return ev;
}

/* --- Analyse déterministe d'un lot --------------------------------------- */
function auditAndScoreOne(b, a, pbKey) {
  const pb = playbook(pbKey);
  const s = subscores(b, a, pbKey);
  const conf = confidenceInfo(b, a);
  const raw = 100 * (pb.w.besoin * s.besoin + pb.w.acces * s.acces + pb.w.valeur * s.valeur
    + pb.w.urgence * s.urgence + pb.w.fraicheur * s.fraicheur);
  const score = Math.round(clamp01(raw / 100 * conf.penalty) * 100);
  return {
    name: b.name || "(sans nom)",
    city: b.city || "",
    website: b.website || "",
    score,
    confidence: conf.level,
    subscores: {
      besoin: Math.round(s.besoin * 100),
      acces: Math.round(s.acces * 100),
      valeur: Math.round(s.valeur * 100),
      urgence: Math.round(s.urgence * 100),
      fraicheur: Math.round(s.fraicheur * 100),
    },
    evidence: evidence(b, a, pbKey),
    audit: a,
  };
}

async function scoreBatch(businesses, pbKey) {
  const audits = await Promise.all(
    businesses.map((b) => (b.website ? auditSite(b.website) : Promise.resolve({ reachable: false, error: "no_url" })))
  );
  return businesses.map((b, i) => auditAndScoreOne(b, audits[i], pbKey));
}

/* --- Explication IA (un seul appel JSON pour le lot) ---------------------- */
function buildPrompt(results, pbKey, locale) {
  const pb = playbook(pbKey);
  const lang = (locale || "fr").slice(0, 2).toLowerCase() === "en" ? "English" : "français";
  const items = results.map((r, i) => ({
    i,
    entreprise: r.name,
    ville: r.city,
    score: r.score,
    confiance: r.confidence,
    problemes_observes: r.evidence,
  }));
  return (
`Tu es un expert en prospection B2B locale. Service vendu par l'utilisateur : "${pb.label}".
Pour CHAQUE entreprise ci-dessous, en te basant UNIQUEMENT sur les problèmes observés fournis (n'invente rien, n'ajoute aucun chiffre non fourni), réponds en ${lang}.

Renvoie un objet JSON STRICT de la forme :
{"resultats":[{"i":0,"problemes":["..."],"recommandation":"...","message":"..."}]}

Règles :
- "problemes" : 1 à 3 problèmes concrets reformulés à partir des problèmes observés.
- "recommandation" : 1 phrase d'action précise liée au service "${pb.label}".
- "message" : un court brouillon d'e-mail de prise de contact (2-4 phrases), poli, personnalisé, citant seulement les problèmes observés, sans promesse chiffrée, prêt à être édité par l'utilisateur. Ne pas inventer le nom d'un interlocuteur.
- Si aucun problème n'est observé, dis-le honnêtement (faible opportunité) au lieu d'inventer.

Entreprises :
${JSON.stringify(items, null, 0)}`
  );
}

async function explain(results, pbKey, locale) {
  if (!results.length) return results;
  let parsed = null;
  try {
    const text = await generate(buildPrompt(results, pbKey, locale));
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch (_) { parsed = null; }
  const byI = {};
  if (parsed && Array.isArray(parsed.resultats)) {
    for (const r of parsed.resultats) if (r && typeof r.i === "number") byI[r.i] = r;
  }
  return results.map((r, i) => {
    const ai = byI[i] || {};
    return {
      ...r,
      problems: Array.isArray(ai.problemes) ? ai.problemes : r.evidence.slice(0, 3),
      recommendation: ai.recommandation || "",
      outreach: ai.message || "",
    };
  });
}

/* --- Recherche Google Places (API "New") — source principale -------------- */
// La clé Google reste CÔTÉ SERVEUR (env GOOGLE_PLACES_KEY). L'extension n'y a
// jamais accès : elle appelle /lof/search, qui appelle Google ici.
// searchText couvre le monde entier ; on récupère aussi site + téléphone + note
// en un seul appel (pas besoin de Place Details séparé) pour limiter le coût.
async function placesSearch({ query, category, city, max, locale, regionCode }) {
  const key = process.env.GOOGLE_PLACES_KEY || "";
  if (!key) { const e = new Error("places_non_configure"); e.status = 501; throw e; }
  const textQuery = (query && query.trim()) || [category, city].filter(Boolean).join(" ").trim();
  if (!textQuery) { const e = new Error("requete_vide"); e.status = 400; throw e; }
  const maxN = Math.max(1, Math.min(20, Number(max) || 20));
  const lang = (locale || "fr").slice(0, 2).toLowerCase();

  const fieldMask = [
    "places.id", "places.displayName", "places.formattedAddress",
    "places.rating", "places.userRatingCount", "places.websiteUri",
    "places.nationalPhoneNumber", "places.location", "places.googleMapsUri",
    "places.businessStatus",
  ].join(",");

  const body = { textQuery, maxResultCount: maxN, languageCode: lang };
  if (regionCode) body.regionCode = String(regionCode).slice(0, 2).toUpperCase();

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("Places " + res.status);
    const e = new Error(msg); e.status = res.status === 403 ? 403 : 502; throw e;
  }
  const places = Array.isArray(data.places) ? data.places : [];
  return places.map((p) => ({
    name: (p.displayName && p.displayName.text) || "",
    city: city || "",
    address: p.formattedAddress || "",
    website: p.websiteUri || "",
    phone: p.nationalPhoneNumber || "",
    rating: typeof p.rating === "number" ? p.rating : null,
    reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    place_id: p.id || "",
    mapsUri: p.googleMapsUri || "",
    status: p.businessStatus || "",
  }));
}

module.exports = { PLAYBOOKS, playbook, scoreBatch, explain, placesSearch };
