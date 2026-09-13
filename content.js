/* =========================================================================
   ReviewScout — content script
   Extrait les avis clients affichés sur la page Amazon que l'utilisateur
   consulte (fiche produit OU page "Voir tous les avis").
   Ne fait AUCUNE requête automatique : lit uniquement la page ouverte.
   ========================================================================= */
(function () {
  "use strict";
  if (window.__reviewScoutLoaded) return;
  window.__reviewScoutLoaded = true;

  const txt = (el) => (el ? el.textContent.trim().replace(/\s+/g, " ") : "");
  const domain = location.hostname.replace("www.", "");

  function parseRating(str) {
    if (!str) return null;
    const m = str.replace(",", ".").match(/([0-5](?:\.\d)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  function parseCount(str) {
    if (!str) return null;
    const m = str.replace(/[^\d]/g, "");
    return m ? parseInt(m, 10) : null;
  }

  // Titre / note globale / nb d'avis / ASIN du produit
  function productContext() {
    const title =
      txt(document.querySelector("#productTitle")) ||
      txt(document.querySelector('[data-hook="product-link"]')) ||
      txt(document.querySelector("h1"));
    const rating = parseRating(
      txt(document.querySelector('[data-hook="rating-out-of-text"]')) ||
        txt(document.querySelector("#acrPopover .a-icon-alt")) ||
        txt(document.querySelector('[data-hook="average-star-rating"] .a-icon-alt'))
    );
    const totalReviews = parseCount(
      txt(document.querySelector("#acrCustomerReviewText")) ||
        txt(document.querySelector('[data-hook="total-review-count"]'))
    );
    const asin =
      (location.pathname.match(/\/(?:dp|product|product-reviews|d)\/([A-Z0-9]{10})/) || [])[1] || "";
    return { title, rating, totalReviews, asin };
  }

  // Extrait tous les blocs d'avis présents sur la page
  function scrapeReviews(limit = 60) {
    const nodes = Array.from(
      document.querySelectorAll('[data-hook="review"], [data-hook="cr-desktop-review"]')
    );
    const reviews = [];
    for (const n of nodes) {
      const rating = parseRating(
        txt(n.querySelector('[data-hook="review-star-rating"] .a-icon-alt')) ||
          txt(n.querySelector('[data-hook="cmps-review-star-rating"] .a-icon-alt')) ||
          txt(n.querySelector(".a-icon-star .a-icon-alt"))
      );
      const title = txt(
        n.querySelector('[data-hook="review-title"] span:not(.a-icon-alt)') ||
          n.querySelector('[data-hook="review-title"]')
      );
      const body = txt(
        n.querySelector('[data-hook="review-body"] span') ||
          n.querySelector('[data-hook="review-body"]')
      );
      if (!body && !title) continue;
      const date = txt(n.querySelector('[data-hook="review-date"]'));
      const verified = !!n.querySelector('[data-hook="avp-badge"]');
      const helpful = parseCount(txt(n.querySelector('[data-hook="helpful-vote-statement"]'))) || 0;
      reviews.push({
        rating,
        title,
        body: (body || "").slice(0, 800),
        date,
        verified,
        helpful,
      });
      if (reviews.length >= limit) break;
    }
    return reviews;
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    try {
      if (req.action === "scrapeReviews") {
        const reviews = scrapeReviews(req.limit || 60);
        if (!reviews.length) {
          sendResponse({
            ok: false,
            error:
              "Aucun avis détecté sur cette page. Ouvre une fiche produit avec des avis, ou la page « Voir tous les avis », puis relance. / No reviews found on this page.",
          });
          return;
        }
        sendResponse({
          ok: true,
          data: { domain, url: location.href, product: productContext(), reviews },
        });
      }
    } catch (e) {
      sendResponse({ ok: false, error: "Erreur d'extraction : " + e.message });
    }
    return true;
  });
})();
