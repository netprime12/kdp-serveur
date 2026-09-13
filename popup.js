/* ReviewScout — popup : analyse d'avis Amazon par IA */
"use strict";

// ---- Liens de paiement Gumroad — À REMPLACER par les produits ReviewScout ----
const SUBSCRIBE_URL = "https://eclozia.gumroad.com"; // abonnement ReviewScout
const PACK_URLS = {
  p15: "https://eclozia.gumroad.com", // Pack 15 recherches
  p50: "https://eclozia.gumroad.com", // Pack 50 recherches
  p150: "https://eclozia.gumroad.com", // Pack 150 recherches
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let LANG = "fr";
let lastAnalysis = null; // {product, sentiment, ...}

const T = {
  fr: {
    sub: "Analyse d'avis Amazon",
    go: "🔍 Analyser les avis",
    working: "Lecture des avis et analyse par IA…",
    trial: (n) => `🎁 Essai gratuit : ${n} analyse(s) restante(s) cette année.`,
    active: "✅ Licence active.",
    buy: `S'abonner · packs : <a href="${PACK_URLS.p15}" target="_blank">15</a>, <a href="${PACK_URLS.p50}" target="_blank">50</a>, <a href="${PACK_URLS.p150}" target="_blank">150</a> — puis colle ta clé dans ⚙️.`,
    inactive: "Essai épuisé ou clé invalide. Abonne-toi ou entre une clé dans les réglages ⚙️.",
    sentiment: "Sentiment global",
    douleurs: "Points de douleur (à corriger)",
    forts: "Points forts (à préserver)",
    attentes: "Attentes non satisfaites",
    verbatims: "Verbatims clients",
    diff: "Angles de différenciation (IA)",
    args: "Arguments marketing prêts à l'emploi",
    pos: "positif", neg: "négatif", neu: "neutre", note: "note moy.",
    onreviews: (n) => `${n} avis analysés`,
  },
  en: {
    sub: "Amazon review analysis",
    go: "🔍 Analyze reviews",
    working: "Reading reviews and running AI analysis…",
    trial: (n) => `🎁 Free trial: ${n} analysis(es) left this year.`,
    active: "✅ License active.",
    buy: `Subscribe · packs: <a href="${PACK_URLS.p15}" target="_blank">15</a>, <a href="${PACK_URLS.p50}" target="_blank">50</a>, <a href="${PACK_URLS.p150}" target="_blank">150</a> — then paste your key in ⚙️.`,
    inactive: "Trial used up or invalid key. Subscribe or enter a key in settings ⚙️.",
    sentiment: "Overall sentiment",
    douleurs: "Pain points (to fix)",
    forts: "Strengths (to keep)",
    attentes: "Unmet expectations",
    verbatims: "Customer verbatims",
    diff: "Differentiation angles (AI)",
    args: "Ready-to-use marketing bullets",
    pos: "positive", neg: "negative", neu: "neutral", note: "avg. rating",
    onreviews: (n) => `${n} reviews analyzed`,
  },
};
const t = () => T[LANG] || T.fr;

function send(action, extra) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(Object.assign({ action }, extra || {}), resolve));
}

function buildPrompt(data) {
  const p = data.product || {};
  const lang = LANG === "en" ? "anglais" : "français";
  const lines = data.reviews.map((r, i) =>
    `${i + 1}. [${r.rating != null ? r.rating + "★" : "?"}${r.verified ? " ✔" : ""}] ${r.title || ""} — ${r.body || ""}`
  ).join("\n");
  return (
`Tu es analyste produit e-commerce spécialisé Amazon FBA. Voici les avis clients d'un produit. Analyse-les et renvoie UNIQUEMENT un JSON valide (aucun texte ni balise autour), au format EXACT :
{
 "sentiment": {"positif": <entier %>, "negatif": <entier %>, "neutre": <entier %>, "note_moyenne": <nombre>},
 "douleurs": [{"point": "...", "frequence": "élevée|moyenne|faible"}],
 "points_forts": ["..."],
 "attentes": ["..."],
 "verbatims": [{"theme": "...", "citation": "..."}],
 "differenciation": ["..."],
 "arguments_marketing": ["..."]
}
Règles : max 6 douleurs (triées du plus fréquent), max 5 éléments pour les autres listes, citations courtes tirées mot pour mot des avis. Base-toi UNIQUEMENT sur les avis fournis, n'invente rien. Rédige les textes en ${lang}.

PRODUIT : ${p.title || "(inconnu)"}${p.rating != null ? " — note globale " + p.rating : ""}${p.totalReviews ? " (" + p.totalReviews + " avis)" : ""}
MARCHÉ : ${data.domain}
AVIS (${data.reviews.length}) :
${lines}`
  );
}

function stripToJson(text) {
  let s = (text || "").trim();
  s = s.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

function renderAnalysis(a, nReviews) {
  const L = t();
  const s = a.sentiment || {};
  const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
  let h = `<div class="cards">
    <div class="stat"><div class="v" style="color:var(--good)">${s.positif != null ? s.positif + "%" : "–"}</div><div class="l">${L.pos}</div></div>
    <div class="stat"><div class="v" style="color:var(--bad)">${s.negatif != null ? s.negatif + "%" : "–"}</div><div class="l">${L.neg}</div></div>
    <div class="stat"><div class="v">${s.neutre != null ? s.neutre + "%" : "–"}</div><div class="l">${L.neu}</div></div>
    <div class="stat"><div class="v" style="color:var(--gold)">${s.note_moyenne != null ? s.note_moyenne : "–"}</div><div class="l">${L.note}</div></div>
  </div>
  <div class="note">${esc(L.onreviews(nReviews))}</div>`;

  if (a.douleurs && a.douleurs.length) {
    h += `<h2>${L.douleurs}</h2><ul>` + a.douleurs.map((d) =>
      `<li>${esc(d.point)}${d.frequence ? `<span class="freq">${esc(d.frequence)}</span>` : ""}</li>`).join("") + `</ul>`;
  }
  if (a.points_forts && a.points_forts.length) h += `<h2>${L.forts}</h2><ul>${li(a.points_forts)}</ul>`;
  if (a.attentes && a.attentes.length) h += `<h2>${L.attentes}</h2><ul>${li(a.attentes)}</ul>`;
  if (a.verbatims && a.verbatims.length) {
    h += `<h2>${L.verbatims}</h2>` + a.verbatims.map((v) =>
      `<div class="verb"><b>${esc(v.theme || "")}</b>« ${esc(v.citation || "")} »</div>`).join("");
  }
  if (a.differenciation && a.differenciation.length) h += `<h2>${L.diff}</h2><ul>${li(a.differenciation)}</ul>`;
  if (a.arguments_marketing && a.arguments_marketing.length) h += `<h2>${L.args}</h2><ul>${li(a.arguments_marketing)}</ul>`;
  return h;
}

function setQuota(status) {
  const L = t();
  if (!status || status.error) {
    $("quota").textContent = "";
    $("buy").innerHTML = L.buy; $("buy").hidden = false;
    return;
  }
  if (status.active) {
    const extra = (typeof status.restant === "number") ? ` (${status.restant})` : "";
    $("quota").textContent = L.active + extra;
    $("buy").hidden = true;
  } else if (status.plan === "trial") {
    $("quota").innerHTML = L.trial(typeof status.restant === "number" ? status.restant : "?");
    $("buy").innerHTML = L.buy; $("buy").hidden = false;
  } else {
    $("quota").textContent = "";
    $("buy").innerHTML = L.buy; $("buy").hidden = false;
  }
}

async function refreshLicense() {
  const st = await send("licenseStatus");
  // st: {active, trialLeft?} selon le serveur ; on tolère les champs manquants.
  setQuota(st || {});
}

async function analyze() {
  const L = t();
  $("go").disabled = true;
  $("result").hidden = true;
  $("status").hidden = false;
  $("status").innerHTML = `<span class="spin"></span>${esc(L.working)}`;

  const scraped = await send("scrapeReviewsActiveTab", { limit: 60 });
  if (!scraped || !scraped.ok) {
    $("status").innerHTML = `<div class="err">${(scraped && scraped.error) || "Erreur."}</div>`;
    $("go").disabled = false;
    return;
  }
  const prompt = buildPrompt(scraped.data);
  const ai = await send("ai", { prompt });
  if (!ai || !ai.ok) {
    let msg = (ai && ai.message) || (ai && ai.error) || "Erreur d'analyse.";
    if (ai && (ai.error === "abonnement_inactif" || ai.status === 402)) msg = t().inactive;
    if (ai && ai.error === "serveur_injoignable")
      msg = "Serveur momentanément indisponible (il se réveille). Réessaie dans ~30 s.";
    $("status").innerHTML = `<div class="err">${esc(msg)}</div>`;
    $("go").disabled = false;
    await refreshLicense();
    return;
  }
  let parsed;
  try { parsed = stripToJson(ai.text); }
  catch (e) {
    $("status").innerHTML = `<div class="err">Réponse IA illisible. Réessaie.</div>`;
    $("go").disabled = false;
    return;
  }
  lastAnalysis = { product: scraped.data.product, domain: scraped.data.domain, nReviews: scraped.data.reviews.length, analysis: parsed };
  $("status").hidden = true;
  $("render").innerHTML = renderAnalysis(parsed, scraped.data.reviews.length);
  $("result").hidden = false;
  $("go").disabled = false;
  await refreshLicense();
}

/* ---- Export ---- */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
function exportCSV() {
  if (!lastAnalysis) return;
  const a = lastAnalysis.analysis;
  const rows = [["Section", "Élément", "Détail"]];
  (a.douleurs || []).forEach((d) => rows.push(["Douleur", d.point, d.frequence || ""]));
  (a.points_forts || []).forEach((x) => rows.push(["Point fort", x, ""]));
  (a.attentes || []).forEach((x) => rows.push(["Attente", x, ""]));
  (a.verbatims || []).forEach((v) => rows.push(["Verbatim", v.theme || "", v.citation || ""]));
  (a.differenciation || []).forEach((x) => rows.push(["Différenciation", x, ""]));
  (a.arguments_marketing || []).forEach((x) => rows.push(["Argument", x, ""]));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  download("reviewscout-avis.csv", "﻿" + csv, "text/csv;charset=utf-8");
}
function exportHTML() {
  if (!lastAnalysis) return;
  const p = lastAnalysis.product || {};
  const body = renderAnalysis(lastAnalysis.analysis, lastAnalysis.nReviews)
    .replace(/var\(--good\)/g, "#1b8a4e").replace(/var\(--bad\)/g, "#c0392b").replace(/var\(--gold\)/g, "#b8860b");
  const html = `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8">
<title>ReviewScout — ${esc(p.title || "Analyse d'avis")}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:800px;margin:24px auto;padding:0 18px;color:#1a2130}
h1{font-size:20px}h2{font-size:15px;border-bottom:2px solid #b8860b;padding-bottom:4px;margin-top:22px}
.cards{display:flex;gap:8px;flex-wrap:wrap}.stat{flex:1;border:1px solid #ddd;border-radius:8px;padding:8px;text-align:center}
.stat .v{font-size:20px;font-weight:800}.stat .l{font-size:11px;color:#667}
.verb{border-left:3px solid #b8860b;background:#fafafa;padding:7px 9px;margin:6px 0;font-style:italic}
.verb b{display:block;font-style:normal;color:#b8860b}.freq{font-size:10px;background:#f0e0c0;padding:1px 6px;border-radius:10px;margin-left:6px}
ul{padding-left:20px}.note{color:#667;font-size:12px}</style></head>
<body><h1>Analyse d'avis — ${esc(p.title || "")}</h1>
<div class="note">${esc(lastAnalysis.domain || "")} · ReviewScout (Éclozia)</div>
${body}</body></html>`;
  download("reviewscout-rapport.html", html, "text/html;charset=utf-8");
}

/* ---- Init ---- */
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get({ lang: "auto" }, (s) => {
    const chosen = s.lang && s.lang !== "auto" ? s.lang : (navigator.language || "fr").slice(0, 2);
    LANG = chosen === "en" ? "en" : "fr";
    const L = t();
    $("sub").textContent = L.sub;
    $("go").textContent = L.go;
    refreshLicense();
  });
  $("go").addEventListener("click", analyze);
  $("gear").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("csv").addEventListener("click", exportCSV);
  $("html").addEventListener("click", exportHTML);
});
