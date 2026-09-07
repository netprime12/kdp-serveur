# Serveur — Analyseur de niches KDP (abonnement)

Ce petit serveur est le « cerveau » de la version abonnement :
- il **fournit l'IA** à ta place (pool de clés Gemini, avec bascule automatique) ;
- il **vérifie les licences** (Lemon Squeezy) ;
- il gère **3 façons de payer une recherche**, dans cet ordre :
  1. le **quota mensuel** de l'abonnement (4,99 € = 60 recherches/mois),
  2. les **crédits** achetés en pack (non expirants),
  3. l'**essai gratuit** (3 recherches par an et par appareil).

L'extension Chrome de tes abonnés appellera ce serveur — plus besoin qu'ils fournissent leur propre clé IA.

---

## 1. Tester en local (5 minutes)

Prérequis : Node.js 18+ installé.

1. Copie `.env.example` en `.env` et mets au moins une clé Gemini dans `GEMINI_KEYS`.
   Laisse `DEV_OPEN=true` pour tester sans licence.
2. Dans ce dossier :
   ```
   npm install
   npm start
   ```
3. Vérifie que ça tourne : ouvre http://localhost:8787/health
   -> tu dois voir `{"ok":true,...}`

---

## 2. Les 3 points d'entrée (API)

- `GET  /health` — test de vie.
- `POST /verifier-licence` — corps `{ "license": "...", "deviceId": "..." }`
  -> renvoie `{ active, plan, limit, used, credits, restant, resetsAt }`.
     `plan` vaut `abo`, `credits`, `trial` ou `dev`.
- `POST /analyse` — corps `{ "license": "...", "deviceId": "...", "prompt": "..." }`
  -> choisit le compteur à débiter (mensuel → crédits → essai), appelle Gemini,
     puis ne débite qu'**en cas de succès**. Renvoie `{ ok, text, used, limit, credits, restant }`.
  -> `429 quota_atteint` / `429 credits_epuises` / `402 essai_termine` / `402 abonnement_inactif`.

L'essai gratuit fonctionne sans licence : il est compté par `deviceId`
(identifiant unique généré par l'extension) et se réinitialise chaque année.
Les crédits sont liés à la **clé** du pack acheté ; ils sont crédités **une seule fois**.

---

## 3. Le pool de clés Gemini

Mets plusieurs clés séparées par des virgules dans `GEMINI_KEYS` :
```
GEMINI_KEYS=cleA,cleB
```
Le serveur tourne de l'une à l'autre et **bascule automatiquement** si une clé
atteint sa limite (429) ou tombe en panne. ⚠️ Utilise des clés de **ton propre
compte** (idéalement avec facturation activée) — pas des comptes gratuits
multipliés pour contourner les limites (fragile et non conforme).

---

## 4. Mettre en ligne (quand tu es prêt)

Le plus simple : **Render** ou **Railway** (offres gratuites/peu chères).
1. Mets ce dossier dans un dépôt (GitHub) ou téléverse-le.
2. Crée un service « Web Service » Node, commande de démarrage `npm start`.
3. Ajoute tes variables (celles du `.env`) dans les « Environment Variables »
   de l'hébergeur — **ne mets jamais tes clés dans le code**.
4. Mets `DEV_OPEN=false` en production.
5. Récupère l'URL publique (ex. `https://kdp-xxx.onrender.com`) : c'est elle
   que l'extension appellera.

---

## 5. Passage en production (checklist)

- [ ] `DEV_OPEN=false`
- [ ] Clé(s) Gemini avec **facturation activée**
- [ ] Offres créées dans Lemon Squeezy + IDs de variants renseignés :
      `LEMON_VARIANT_ABO` (abonnement 4,99 €), et les packs de crédits
      `LEMON_VARIANT_PACK10`, `LEMON_VARIANT_PACK30`, `LEMON_VARIANT_PACK100`
      (produits « achat unique » qui délivrent une clé de licence)
- [ ] Restreindre le CORS à l'ID de ton extension (au lieu de tout ouvrir)
- [ ] **Stockage persistant** : renseigne `UPSTASH_REDIS_REST_URL` et
      `UPSTASH_REDIS_REST_TOKEN` (base Redis gratuite sur upstash.com).
      Le serveur bascule alors automatiquement sur Redis : les compteurs
      (crédits, abonnements, essais) ne se réinitialisent plus jamais.
      Sans ces variables, il utilise le fichier local (tests uniquement).

---

## Fichiers

- `server.js`  — routes et logique principale
- `keypool.js` — pool de clés Gemini (rotation + secours)
- `license.js` — vérification Lemon Squeezy (abonnement / packs de crédits)
- `store.js`   — comptage : quota mensuel + essai annuel + solde de crédits (fichier JSON pour le MVP)
- `.env.example` — configuration à copier en `.env`
