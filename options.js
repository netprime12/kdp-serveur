/* Réglages — ReviewScout */
"use strict";
const $ = (id) => document.getElementById(id);

// Liens Gumroad — À REMPLACER par les produits ReviewScout
const SUBSCRIBE_URL = "https://eclozia.gumroad.com";
const PACK15 = "https://eclozia.gumroad.com";
const PACK50 = "https://eclozia.gumroad.com";
const PACK150 = "https://eclozia.gumroad.com";

$("buy").innerHTML =
  `Pas encore de licence ? <a href="${SUBSCRIBE_URL}" target="_blank">S'abonner</a> — ` +
  `packs : <a href="${PACK15}" target="_blank">15</a>, <a href="${PACK50}" target="_blank">50</a>, <a href="${PACK150}" target="_blank">150</a>.`;

chrome.storage.sync.get({ serverUrl: "", licenseKey: "", lang: "auto" }, (s) => {
  $("license").value = s.licenseKey || "";
  $("server").value = s.serverUrl || "";
  $("lang").value = s.lang || "auto";
});

$("save").addEventListener("click", () => {
  chrome.storage.sync.set(
    { licenseKey: $("license").value.trim(), serverUrl: $("server").value.trim(), lang: $("lang").value },
    () => { $("msg").textContent = "✅ Enregistré."; }
  );
});

$("check").addEventListener("click", () => {
  chrome.storage.sync.set(
    { licenseKey: $("license").value.trim(), serverUrl: $("server").value.trim() },
    () => {
      $("msg").textContent = "Vérification…";
      chrome.runtime.sendMessage({ action: "licenseStatus" }, (st) => {
        if (!st) { $("msg").textContent = "Aucune réponse du serveur."; return; }
        if (st.active) $("msg").textContent = "✅ Licence active.";
        else if (st.error === "serveur_injoignable") $("msg").textContent = "Serveur injoignable (réveil ~30 s), réessaie.";
        else $("msg").textContent = "Licence inactive — abonne-toi ou vérifie ta clé.";
      });
    }
  );
});
