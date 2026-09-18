// ============================================================
// eni.js — Etsy Niche Intelligence · module serveur NicheScout
// Ajouter dans server.js : app.use('/eni', require('./eni'));
// Variables Render requises : ETSY_API_KEY
// ============================================================

const express = require('express');
const router  = express.Router();
const https   = require('https');
const { callAI } = require('./aiprovider');

// ── Config ────────────────────────────────────────────────────
const ETSY_API_KEY   = process.env.ETSY_API_KEY || '';
const ETSY_BASE      = 'https://openapi.etsy.com/v3/application';
const CACHE_TTL_MS   = 60 * 60 * 1000;   // 1h cache mémoire
const MAX_LISTINGS   = 20;                // par requête API Etsy
const MIN_LISTINGS   = 5;                 // seuil confiance faible

// Cache mémoire simple (Redis optionnel en V1.1)
const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { _cache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, data) { _cache.set(k, { data, ts: Date.now() }); }

// ── Etsy API helper ───────────────────────────────────────────
function etsyGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${ETSY_BASE}${path}`;
    const opts = {
      headers: {
        'x-api-key': ETSY_API_KEY,
        'Accept':    'application/json',
      }
    };
    https.get(url, opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('etsy_rate_limit'));
        if (res.statusCode >= 400) return reject(new Error(`etsy_${res.statusCode}`));
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('etsy_parse_error')); }
      });
    }).on('error', reject);
  });
}

// ── Collecte Etsy ─────────────────────────────────────────────
async function fetchEtsyListings(keyword, digitalOnly = true) {
  const cacheKey = `etsy:${keyword}:${digitalOnly}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const encoded = encodeURIComponent(keyword);
  const typeParam = digitalOnly ? '&taxonomy_id=2078' : '';  // 2078 = Digital Downloads
  const path = `/listings/active?keywords=${encoded}&limit=${MAX_LISTINGS}&includes=Shop,MainImage${typeParam}&sort_on=score&sort_order=desc`;

  try {
    const data = await etsyGet(path);
    const listings = (data.results || []).map(l => ({
      id:           l.listing_id,
      title:        l.title || '',
      price:        parseFloat(l.price?.amount || 0) / (l.price?.divisor || 100),
      currency:     l.price?.currency_code || 'USD',
      views:        l.views || 0,
      favorites:    l.num_favorers || 0,
      quantity:     l.quantity || 0,
      tags:         l.tags || [],
      isDigital:    l.is_digital || false,
      shopName:     l.Shop?.shop_name || '',
      shopSales:    l.Shop?.transaction_sold_count || 0,
      created:      l.creation_timestamp || 0,
      updated:      l.last_modified_timestamp || 0,
    }));
    const result = { listings, total: data.count || 0, fetchedAt: Date.now() };
    cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    // Si API indispo ou pending approval → retourner données vides avec flag
    console.warn('[ENI] Etsy API error:', e.message);
    return { listings: [], total: 0, fetchedAt: Date.now(), apiError: e.message };
  }
}

// ── Scoring déterministe ──────────────────────────────────────
function computeScores(listings, manualData = {}) {
  const n = listings.length;
  if (n === 0) {
    // Mode manuel uniquement
    return computeManualScores(manualData);
  }

  // --- Demande proxy (0.28) ---
  // Proxy : nb total de résultats Etsy + densité de favoris top 10
  const top10    = listings.slice(0, 10);
  const avgFavs  = top10.reduce((s, l) => s + l.favorites, 0) / Math.max(top10.length, 1);
  const demandSignal = Math.min(avgFavs / 500, 1);         // 500 favs = signal fort
  const volumeSignal = Math.min(n / MAX_LISTINGS, 1);       // plein de résultats = demande
  const demandScore  = demandSignal * 0.6 + volumeSignal * 0.4;

  // --- Accessibilité (0.24) ---
  // % listings avec < 50 favoris (= boutiques sans domination forte)
  const lowBarrier  = listings.filter(l => l.favorites < 50).length / n;
  // % boutiques avec peu de ventes (shopSales disponible via includes=Shop)
  const smallShops  = listings.filter(l => l.shopSales < 500).length / n;
  const accessScore = lowBarrier * 0.6 + smallShops * 0.4;

  // --- Faiblesse concurrentielle (0.18) - INVERSÉ ---
  // Homogénéité des titres (mots répétitifs → opportunité de différenciation)
  const titleWords = listings.flatMap(l => l.title.toLowerCase().split(/\W+/).filter(w => w.length > 4));
  const wordCount  = {};
  titleWords.forEach(w => { wordCount[w] = (wordCount[w] || 0) + 1; });
  const topWords   = Object.values(wordCount).sort((a,b) => b-a).slice(0, 5);
  const repetition = topWords.reduce((s, c) => s + c, 0) / Math.max(titleWords.length, 1);
  const weakScore  = Math.min(repetition * 3, 1);  // forte répétition = faiblesse = opportunité

  // --- Marge potentielle (0.15) ---
  const prices     = listings.map(l => l.price).filter(p => p > 0);
  const medianPrice = prices.sort((a,b)=>a-b)[Math.floor(prices.length/2)] || 0;
  const isDigital   = listings.filter(l => l.isDigital).length / n > 0.5;
  const minPrice    = manualData.minPrice || 5;
  const marginScore = isDigital
    ? Math.min(medianPrice / 20, 1)          // digital : marge haute si prix > 20$
    : Math.min(Math.max(medianPrice - minPrice, 0) / 30, 1);

  // --- Diversité (0.10) ---
  const uniqueShops  = new Set(listings.map(l => l.shopName)).size;
  const shopDiversity = Math.min(uniqueShops / n, 1);
  const tagSets      = listings.map(l => new Set(l.tags));
  const allTags      = new Set(listings.flatMap(l => l.tags));
  const tagDiversity = Math.min(allTags.size / 100, 1);
  const diversityScore = shopDiversity * 0.5 + tagDiversity * 0.5;
  // Trop de diversité = niche floue (pénalité légère au-delà de 0.9)
  const diversityFinal = diversityScore > 0.9 ? diversityScore * 0.85 : diversityScore;

  // --- Fraîcheur (0.05) ---
  const now = Date.now() / 1000;
  const recency = listings.filter(l => (now - l.updated) < 180 * 86400).length / n;
  const freshnessScore = recency;

  // --- Score final ---
  const raw =
    demandScore   * 0.28 +
    accessScore   * 0.24 +
    weakScore     * 0.18 +
    marginScore   * 0.15 +
    diversityFinal* 0.10 +
    freshnessScore* 0.05;

  // --- Confiance ---
  const signalsPresent = [
    n >= MIN_LISTINGS,
    listings.some(l => l.shopSales > 0),
    prices.length > 0,
    listings.some(l => l.tags.length > 0),
    listings.some(l => l.favorites > 0),
  ].filter(Boolean).length;
  const confidenceRatio = signalsPresent / 5;
  const confidence = confidenceRatio >= 0.8 ? 'high' : confidenceRatio >= 0.55 ? 'medium' : 'low';

  return {
    opportunity: Math.round(raw * 100 * confidenceRatio),
    subscores: {
      demand:        Math.round(demandScore * 100),
      accessibility: Math.round(accessScore * 100),
      weakness:      Math.round(weakScore * 100),
      margin:        Math.round(marginScore * 100),
      diversity:     Math.round(diversityFinal * 100),
      freshness:     Math.round(freshnessScore * 100),
    },
    confidence,
    signalsPresent,
    meta: {
      listingsAnalyzed: n,
      avgFavorites:     Math.round(avgFavs),
      medianPrice:      medianPrice.toFixed(2),
      smallShopPct:     Math.round(smallShops * 100),
      lowBarrierPct:    Math.round(lowBarrier * 100),
      isDigitalNiche:   isDigital,
      uniqueShops,
      priceRange:       prices.length ? `${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)}` : 'N/A',
    },
  };
}

function computeManualScores(d = {}) {
  // Mode dégradé : uniquement données saisies par l'utilisateur
  const demandScore  = Math.min((d.estimatedResults || 0) / 500, 1);
  const accessScore  = d.hasSmallSellers ? 0.7 : 0.3;
  const weakScore    = d.competitionLevel === 'low' ? 0.8 : d.competitionLevel === 'medium' ? 0.5 : 0.2;
  const marginScore  = Math.min((d.avgPrice || 0) / 25, 1);
  const raw = demandScore*0.28 + accessScore*0.24 + weakScore*0.18 + marginScore*0.15 + 0.5*0.10 + 0.5*0.05;
  return {
    opportunity: Math.round(raw * 100 * 0.55), // confiance forcée à medium
    subscores: {
      demand: Math.round(demandScore*100), accessibility: Math.round(accessScore*100),
      weakness: Math.round(weakScore*100), margin: Math.round(marginScore*100),
      diversity: 50, freshness: 50,
    },
    confidence: 'medium',
    signalsPresent: 3,
    meta: { listingsAnalyzed: 0, isDigitalNiche: true, priceRange: `${d.avgPrice||0}`, manualMode: true },
  };
}

// ── Verdict ───────────────────────────────────────────────────
function computeVerdict(score, confidence) {
  if (confidence === 'low')     return 'test';
  if (score >= 65)              return 'go';
  if (score >= 40)              return 'test';
  return 'nogo';
}

// ── Prompt IA ─────────────────────────────────────────────────
function buildENIPrompt(keyword, scores, listings, lang, digitalOnly) {
  const top5titles = listings.slice(0, 5).map(l => l.title.substring(0, 80)).join('\n');
  const top5tags   = [...new Set(listings.flatMap(l => l.tags))].slice(0, 20).join(', ');
  const { meta, subscores, confidence, opportunity } = scores;

  return `You are an Etsy market analyst helping a seller find profitable niches. Analyze this niche and respond ONLY in "${lang}" language.

NICHE KEYWORD: "${keyword}"
PRODUCT TYPE: ${digitalOnly ? 'Digital products only' : 'All products'}
OPPORTUNITY SCORE: ${opportunity}/100
CONFIDENCE: ${confidence}

MARKET DATA:
- Listings analyzed: ${meta.listingsAnalyzed}
- Average favorites (top 10): ${meta.avgFavorites}
- Median price: $${meta.medianPrice}
- Price range: $${meta.priceRange}
- Small sellers present (${meta.lowBarrierPct}% listings < 50 favs): ${meta.lowBarrierPct > 40 ? 'YES' : 'NO'}
- Unique shops: ${meta.uniqueShops}

SUB-SCORES (0-100):
- Demand proxy: ${subscores.demand}
- Accessibility for new sellers: ${subscores.accessibility}
- Competitive weakness (higher = more opportunity): ${subscores.weakness}
- Margin potential: ${subscores.margin}
- Diversity: ${subscores.diversity}

SAMPLE TITLES FROM TOP LISTINGS:
${top5titles || 'No data available'}

POPULAR TAGS IN NICHE:
${top5tags || 'No data available'}

Return ONLY valid JSON (no markdown, no explanation):
{
  "verdict_reasons": [
    "<reason 1 in ${lang}, 1 sentence>",
    "<reason 2 in ${lang}, 1 sentence>",
    "<reason 3 in ${lang}, 1 sentence>"
  ],
  "summary": "<2-3 sentence market overview in ${lang}>",
  "sub_niches": [
    {
      "keyword": "<specific sub-niche keyword>",
      "angle": "<differentiation angle: audience/occasion/style/format/benefit>",
      "description": "<why this sub-niche is interesting, 1 sentence in ${lang}>",
      "estimated_score": <0-100>,
      "digital_friendly": <true|false>
    }
  ],
  "small_seller_wins": [
    "<observation about accessible listings or shops, in ${lang}>",
    "<observation 2>",
    "<observation 3>"
  ],
  "creation_brief": {
    "concept": "<original product concept, NOT copying competitors, in ${lang}>",
    "target_audience": "<specific buyer persona in ${lang}>",
    "occasion": "<use case or occasion in ${lang}>",
    "style": "<visual/aesthetic style in ${lang}>",
    "format": "<file format or product format for digital in ${lang}>",
    "usp": "<unique selling proposition vs competitors, in ${lang}>",
    "assets_to_create": ["<asset 1 in ${lang}>", "<asset 2>", "<asset 3>", "<asset 4>", "<asset 5>"],
    "tags_candidates": [
      "<tag 1>", "<tag 2>", "<tag 3>", "<tag 4>", "<tag 5>",
      "<tag 6>", "<tag 7>", "<tag 8>", "<tag 9>", "<tag 10>",
      "<tag 11>", "<tag 12>", "<tag 13>"
    ],
    "pre_publish_checklist": [
      "<checklist item 1 in ${lang}>",
      "<checklist item 2>",
      "<checklist item 3>",
      "<checklist item 4>",
      "<checklist item 5>"
    ],
    "trademark_warning": "<trademark/brand check reminder in ${lang}>"
  },
  "seasonality_note": "<brief note on seasonality if relevant, or null>"
}

Rules:
- sub_niches: exactly 10, varied angles (audience, occasion, style, format, benefit)
- tags_candidates: exactly 13, no duplicates, max 20 chars each, no trademark terms
- creation_brief concept must be ORIGINAL, not a copy of observed listings
- All text in "${lang}" language
- estimated_score based on sub-niche specificity vs parent niche competition`;
}

// ── Endpoint principal : POST /eni/analyse ────────────────────
router.post('/analyse', async (req, res) => {
  try {
    const {
      deviceId, licenseKey,
      keyword,
      lang        = 'en',
      digitalOnly = true,
      manualData  = {},
    } = req.body;

    if (!keyword || keyword.trim().length < 2) {
      return res.status(400).json({ error: 'invalid_keyword', message: 'Keyword is required (min 2 chars)' });
    }

    // --- Licence ---
    const { checkLicense, deductUnit } = require('./store');
    const license = await checkLicense(deviceId, licenseKey, 'eni');
    if (!license.valid) {
      return res.status(403).json({ error: 'license_invalid', message: license.reason });
    }
    if (license.remaining < 1) {
      return res.status(402).json({ error: 'quota_exceeded', remaining: 0 });
    }

    // --- Collecte Etsy API ---
    const { listings, total, fetchedAt, apiError, fromCache } = await fetchEtsyListings(keyword.trim(), digitalOnly);

    // --- Scoring ---
    const scores  = computeScores(listings, manualData);
    const verdict = computeVerdict(scores.opportunity, scores.confidence);

    // --- IA ---
    const prompt = buildENIPrompt(keyword, scores, listings, lang, digitalOnly);
    let aiResult;
    try {
      const raw = await callAI(prompt, { maxTokens: 4096, temperature: 0.4, jsonMode: true });
      aiResult  = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error('[ENI] AI error:', e.message);
      return res.status(500).json({ error: 'ai_error', message: 'AI analysis failed' });
    }

    // --- Déduire 1 unité ---
    await deductUnit(deviceId, licenseKey, 'eni', 1);

    return res.json({
      success: true,
      keyword: keyword.trim(),
      lang,
      digitalOnly,
      verdict,
      scores,
      market: {
        totalListings: total,
        listingsAnalyzed: listings.length,
        fetchedAt,
        fromCache: !!fromCache,
        apiError: apiError || null,
        sampleListings: listings.slice(0, 5).map(l => ({
          title: l.title,
          price: l.price,
          favorites: l.favorites,
          shopSales: l.shopSales,
          isDigital: l.isDigital,
        })),
      },
      reports: {
        verdictReasons:  aiResult.verdict_reasons  || [],
        summary:         aiResult.summary          || '',
        subNiches:       aiResult.sub_niches       || [],
        smallSellerWins: aiResult.small_seller_wins|| [],
        creationBrief:   aiResult.creation_brief   || {},
        seasonalityNote: aiResult.seasonality_note || null,
      },
    });

  } catch (err) {
    console.error('[ENI]', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── Endpoint comparaison : POST /eni/compare ─────────────────
router.post('/compare', async (req, res) => {
  try {
    const { deviceId, licenseKey, analyses, lang = 'en' } = req.body;

    if (!Array.isArray(analyses) || analyses.length < 2 || analyses.length > 3) {
      return res.status(400).json({ error: 'invalid_analyses', message: 'Provide 2 or 3 analyses to compare' });
    }

    const { checkLicense, deductUnit } = require('./store');
    const license = await checkLicense(deviceId, licenseKey, 'eni');
    if (!license.valid) return res.status(403).json({ error: 'license_invalid', message: license.reason });

    const prompt = `You are an Etsy market analyst. Compare these ${analyses.length} niches and give a recommendation. Respond in "${lang}".

${analyses.map((a, i) => `NICHE ${i+1}: "${a.keyword}"
- Opportunity score: ${a.scores?.opportunity}/100
- Confidence: ${a.scores?.confidence}
- Demand: ${a.scores?.subscores?.demand}, Accessibility: ${a.scores?.subscores?.accessibility}, Weakness: ${a.scores?.subscores?.weakness}
- Verdict: ${a.verdict}`).join('\n\n')}

Return ONLY valid JSON:
{
  "winner": <0|1|2 (index of best niche)>,
  "winner_reason": "<why this niche is best, 2 sentences in ${lang}>",
  "comparison_matrix": [
    { "dimension": "<dimension name in ${lang}>", "values": ["<niche1 assessment>", "<niche2 assessment>", "<niche3 assessment or null>"] }
  ],
  "combined_opportunity": "<is there a way to combine these niches? insight in ${lang} or null>"
}`;

    let aiResult = {};
    try {
      const raw = await callAI(prompt, { maxTokens: 1024, temperature: 0.3, jsonMode: true });
      aiResult  = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { console.error('[ENI compare]', e.message); }

    await deductUnit(deviceId, licenseKey, 'eni', analyses.length);

    return res.json({
      success: true,
      analyses: analyses.map(a => ({ keyword: a.keyword, score: a.scores?.opportunity, verdict: a.verdict })),
      winner:              aiResult.winner,
      winnerReason:        aiResult.winner_reason        || '',
      comparisonMatrix:    aiResult.comparison_matrix    || [],
      combinedOpportunity: aiResult.combined_opportunity || null,
    });

  } catch (err) {
    console.error('[ENI compare]', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── Endpoint utilitaire : GET /eni/ping ───────────────────────
router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    etsyApiConfigured: !!ETSY_API_KEY,
    cacheSize: _cache.size,
  });
});

module.exports = router;
