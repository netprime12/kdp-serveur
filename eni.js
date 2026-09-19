// ============================================================
// eni.js — Etsy Niche Intelligence · NicheScout
// Monté dans server.js : app.use('/eni', require('./eni'))
// ============================================================

const express  = require('express');
const https    = require('https');
const router   = express.Router();

const ETSY_API_KEY = process.env.ETSY_API_KEY || '';
const ETSY_BASE    = 'https://openapi.etsy.com/v3/application';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_LISTINGS = 20;
const MIN_LISTINGS = 5;

const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { _cache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, d) { _cache.set(k, { data: d, ts: Date.now() }); }

function etsyGet(path) {
  return new Promise((resolve, reject) => {
    https.get(ETSY_BASE + path, {
      headers: { 'x-api-key': ETSY_API_KEY, 'Accept': 'application/json' }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('etsy_rate_limit'));
        if (res.statusCode >= 400) return reject(new Error('etsy_' + res.statusCode));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('etsy_parse')); }
      });
    }).on('error', reject);
  });
}

async function fetchEtsyListings(keyword, digitalOnly) {
  const key = 'etsy:' + keyword + ':' + digitalOnly;
  const hit = cacheGet(key);
  if (hit) return { ...hit, fromCache: true };
  try {
    const enc  = encodeURIComponent(keyword);
    const taxo = digitalOnly ? '&taxonomy_id=2078' : '';
    const data = await etsyGet(
      '/listings/active?keywords=' + enc + '&limit=' + MAX_LISTINGS + '&includes=Shop' + taxo + '&sort_on=score&sort_order=desc'
    );
    const listings = (data.results || []).map(function(l) {
      return {
        title:     l.title || '',
        price:     parseFloat(l.price && l.price.amount ? l.price.amount : 0) / (l.price && l.price.divisor ? l.price.divisor : 100),
        favorites: l.num_favorers || 0,
        shopSales: l.Shop && l.Shop.transaction_sold_count ? l.Shop.transaction_sold_count : 0,
        isDigital: l.is_digital || false,
        shopName:  l.Shop && l.Shop.shop_name ? l.Shop.shop_name : '',
        tags:      l.tags || [],
        updated:   l.last_modified_timestamp || 0,
      };
    });
    const result = { listings: listings, total: data.count || 0, fetchedAt: Date.now() };
    cacheSet(key, result);
    return result;
  } catch (e) {
    console.warn('[ENI] Etsy API:', e.message);
    return { listings: [], total: 0, fetchedAt: Date.now(), apiError: e.message };
  }
}

function computeScores(listings, manualData) {
  const n = listings.length;
  if (n === 0) return computeManualScores(manualData || {});

  const top10      = listings.slice(0, 10);
  const avgFavs    = top10.reduce(function(s, l) { return s + l.favorites; }, 0) / Math.max(top10.length, 1);
  const demandScore = Math.min(avgFavs / 500, 1) * 0.6 + Math.min(n / MAX_LISTINGS, 1) * 0.4;
  const lowBarrier  = listings.filter(function(l) { return l.favorites < 50; }).length / n;
  const smallShops  = listings.filter(function(l) { return l.shopSales < 500; }).length / n;
  const accessScore = lowBarrier * 0.6 + smallShops * 0.4;
  const words       = [];
  listings.forEach(function(l) {
    l.title.toLowerCase().split(/\W+/).filter(function(w) { return w.length > 4; }).forEach(function(w) { words.push(w); });
  });
  const wc = {};
  words.forEach(function(w) { wc[w] = (wc[w] || 0) + 1; });
  const top5rep     = Object.values(wc).sort(function(a, b) { return b - a; }).slice(0, 5);
  const rep         = top5rep.reduce(function(s, c) { return s + c; }, 0) / Math.max(words.length, 1);
  const weakScore   = Math.min(rep * 3, 1);
  const prices      = listings.map(function(l) { return l.price; }).filter(function(p) { return p > 0; }).sort(function(a, b) { return a - b; });
  const medianPrice = prices[Math.floor(prices.length / 2)] || 0;
  const isDigital   = listings.filter(function(l) { return l.isDigital; }).length / n > 0.5;
  const marginScore = isDigital ? Math.min(medianPrice / 20, 1) : Math.min(medianPrice / 40, 1);
  const shopNames   = new Set(listings.map(function(l) { return l.shopName; }));
  const allTags     = new Set([]);
  listings.forEach(function(l) { l.tags.forEach(function(t) { allTags.add(t); }); });
  const divRaw      = Math.min(shopNames.size / n, 1) * 0.5 + Math.min(allTags.size / 100, 1) * 0.5;
  const divFinal    = divRaw > 0.9 ? divRaw * 0.85 : divRaw;
  const now         = Date.now() / 1000;
  const freshScore  = listings.filter(function(l) { return (now - l.updated) < 180 * 86400; }).length / n;

  const raw =
    demandScore * 0.28 + accessScore * 0.24 + weakScore * 0.18 +
    marginScore * 0.15 + divFinal * 0.10 + freshScore * 0.05;

  const sigs = [
    n >= MIN_LISTINGS,
    listings.some(function(l) { return l.shopSales > 0; }),
    prices.length > 0,
    listings.some(function(l) { return l.tags.length > 0; }),
    listings.some(function(l) { return l.favorites > 0; }),
  ].filter(Boolean).length;

  const confRatio  = sigs / 5;
  const confidence = confRatio >= 0.8 ? 'high' : confRatio >= 0.55 ? 'medium' : 'low';

  return {
    opportunity: Math.round(raw * 100 * confRatio),
    subscores: {
      demand:        Math.round(demandScore * 100),
      accessibility: Math.round(accessScore * 100),
      weakness:      Math.round(weakScore * 100),
      margin:        Math.round(marginScore * 100),
      diversity:     Math.round(divFinal * 100),
      freshness:     Math.round(freshScore * 100),
    },
    confidence: confidence,
    meta: {
      listingsAnalyzed: n,
      avgFavorites:     Math.round(avgFavs),
      medianPrice:      medianPrice.toFixed(2),
      smallShopPct:     Math.round(smallShops * 100),
      lowBarrierPct:    Math.round(lowBarrier * 100),
      isDigitalNiche:   isDigital,
      uniqueShops:      shopNames.size,
      priceRange:       prices.length ? (Math.min.apply(null, prices).toFixed(2) + '-' + Math.max.apply(null, prices).toFixed(2)) : 'N/A',
    },
  };
}

function computeManualScores(d) {
  const compMap = { low: 0.8, medium: 0.5, high: 0.2 };
  const raw =
    Math.min((d.estimatedResults || 0) / 500, 1) * 0.28 +
    (d.hasSmallSellers ? 0.7 : 0.3) * 0.24 +
    (compMap[d.competitionLevel || 'medium'] || 0.5) * 0.18 +
    Math.min((d.avgPrice || 0) / 25, 1) * 0.15 +
    0.5 * 0.15;
  return {
    opportunity: Math.round(raw * 100 * 0.55),
    subscores: { demand: 0, accessibility: 0, weakness: 0, margin: 0, diversity: 50, freshness: 50 },
    confidence: 'medium',
    meta: { listingsAnalyzed: 0, isDigitalNiche: true, priceRange: 'N/A', manualMode: true },
  };
}

function computeVerdict(score, confidence) {
  if (confidence === 'low') return 'test';
  if (score >= 65)          return 'go';
  if (score >= 40)          return 'test';
  return 'nogo';
}

function buildPrompt(keyword, scores, listings, lang, digitalOnly) {
  const top5 = listings.slice(0, 5).map(function(l) { return l.title.substring(0, 80); }).join('\n');
  const tagSet = [];
  listings.forEach(function(l) { l.tags.forEach(function(t) { if (tagSet.indexOf(t) < 0) tagSet.push(t); }); });
  const tags = tagSet.slice(0, 20).join(', ');
  const m = scores.meta;
  const s = scores.subscores;

  return 'You are an Etsy market analyst. Analyze this niche and respond ONLY in "' + lang + '" language.\n\n' +
    'NICHE: "' + keyword + '" | Type: ' + (digitalOnly ? 'Digital only' : 'All') + '\n' +
    'OPPORTUNITY SCORE: ' + scores.opportunity + '/100 | CONFIDENCE: ' + scores.confidence + '\n\n' +
    'MARKET DATA:\n' +
    '- Listings analyzed: ' + m.listingsAnalyzed + '\n' +
    '- Avg favorites top 10: ' + m.avgFavorites + '\n' +
    '- Median price: $' + m.medianPrice + ' | Range: $' + m.priceRange + '\n' +
    '- Small sellers (' + m.lowBarrierPct + '% with < 50 favs): ' + (m.lowBarrierPct > 40 ? 'YES' : 'NO') + '\n\n' +
    'SUB-SCORES (0-100): demand=' + s.demand + ' accessibility=' + s.accessibility + ' weakness=' + s.weakness + ' margin=' + s.margin + '\n\n' +
    'SAMPLE TITLES:\n' + (top5 || 'No data') + '\n\n' +
    'POPULAR TAGS: ' + (tags || 'No data') + '\n\n' +
    'Return ONLY valid JSON (no markdown):\n' +
    '{\n' +
    '  "verdict_reasons": ["<reason 1 in ' + lang + '>","<reason 2>","<reason 3>"],\n' +
    '  "summary": "<2-3 sentences in ' + lang + '>",\n' +
    '  "sub_niches": [\n' +
    '    {"keyword":"<sub-niche>","angle":"<audience|occasion|style|format|benefit>","description":"<1 sentence in ' + lang + '>","estimated_score":<0-100>,"digital_friendly":<true|false>}\n' +
    '  ],\n' +
    '  "small_seller_wins": ["<obs in ' + lang + '>","<obs 2>","<obs 3>"],\n' +
    '  "creation_brief": {\n' +
    '    "concept":"<ORIGINAL concept, not copying competitors, in ' + lang + '>",\n' +
    '    "target_audience":"<persona in ' + lang + '>",\n' +
    '    "occasion":"<use case in ' + lang + '>",\n' +
    '    "style":"<visual style in ' + lang + '>",\n' +
    '    "format":"<file format in ' + lang + '>",\n' +
    '    "usp":"<USP in ' + lang + '>",\n' +
    '    "assets_to_create":["<asset 1 in ' + lang + '>","<a2>","<a3>","<a4>","<a5>"],\n' +
    '    "tags_candidates":["<t1>","<t2>","<t3>","<t4>","<t5>","<t6>","<t7>","<t8>","<t9>","<t10>","<t11>","<t12>","<t13>"],\n' +
    '    "pre_publish_checklist":["<item 1 in ' + lang + '>","<i2>","<i3>","<i4>","<i5>"],\n' +
    '    "trademark_warning":"<trademark reminder in ' + lang + '>"\n' +
    '  },\n' +
    '  "seasonality_note":"<seasonality note in ' + lang + ' or null>"\n' +
    '}\n' +
    'Rules: exactly 10 sub_niches, exactly 13 tags_candidates (max 20 chars each), original concept only.';
}

router.get('/ping', function(req, res) {
  res.json({ ok: true, etsyApiConfigured: !!ETSY_API_KEY, cacheSize: _cache.size });
});

router.post('/analyse', async function(req, res) {
  try {
    const body        = req.body || {};
    const license     = body.licenseKey || body.license || '';
    const deviceId    = body.deviceId || '';
    const keyword     = (body.keyword || '').trim();
    const lang        = body.lang || 'en';
    const digitalOnly = body.digitalOnly !== false;
    const manualData  = body.manualData || {};

    if (keyword.length < 2) {
      return res.status(400).json({ ok: false, error: 'invalid_keyword' });
    }

    const checkLicense = require('./license').checkLicense;
    const store        = require('./store');
    const { generate } = require('./aiprovider');
    const planLimits   = require('./license').planLimits;

    const info = await checkLicense(license);
    if (info.kind === 'error')
      return res.status(503).json({ ok: false, error: 'verification_indisponible',
        message: 'License verification unavailable. Try again.' });
    if (info.kind === 'invalid')
      return res.status(402).json({ ok: false, error: 'abonnement_inactif',
        message: 'Invalid or expired key. Subscribe or buy credits.' });
    if (info.kind === 'credits' && store.grantCreditsOnce)
      await store.grantCreditsOnce(license, info.creditGrant);
    if (info.kind === 'none' && !deviceId)
      return res.status(400).json({ ok: false, error: 'deviceId_required' });

    const limits = planLimits ? planLimits() : { trial: 5 };
    let available  = 0;
    let bucketPlan = 'trial';

    if (info.kind === 'dev') {
      available = 9999; bucketPlan = 'dev';
    } else if (info.kind === 'subscription') {
      const used = await store.getMonthly('lic:' + license);
      const cred = await store.getCredits(license);
      available  = Math.max(0, info.limit - used) + cred;
      bucketPlan = 'abo';
    } else if (info.kind === 'credits') {
      available  = await store.getCredits(license);
      bucketPlan = 'credits';
    } else {
      const used = await store.getTrial(deviceId);
      available  = Math.max(0, limits.trial - used);
    }

    if (available <= 0) {
      return res.status(402).json({ ok: false, error: 'quota_atteint',
        message: bucketPlan === 'trial'
          ? 'Free trial exhausted. Subscribe or buy credits.'
          : 'Quota reached. Resets next month, or buy credits.' });
    }

    const { listings, total, fetchedAt, apiError } = await fetchEtsyListings(keyword, digitalOnly);
    const scores  = computeScores(listings, manualData);
    const verdict = computeVerdict(scores.opportunity, scores.confidence);
    const prompt  = buildPrompt(keyword, scores, listings, lang, digitalOnly);

    let aiResult = {};
    try {
      const raw = await generate(prompt);
      aiResult  = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error('[ENI] AI error:', e.message);
      return res.status(500).json({ ok: false, error: 'ai_error', message: 'AI analysis failed' });
    }

    // Debit
    if (info.kind === 'dev') {
      if (store.incrementMonthly) await store.incrementMonthly('dev');
    } else if (info.kind === 'subscription') {
      const id   = 'lic:' + license;
      const used = await store.getMonthly(id);
      if (used < info.limit) await store.incrementMonthly(id);
      else if (store.consumeCredit) await store.consumeCredit(license);
    } else if (info.kind === 'credits') {
      if (store.consumeCredit) await store.consumeCredit(license);
    } else {
      await store.incrementTrial(deviceId);
    }

    // Restant
    let restant = null;
    if (info.kind === 'subscription') {
      const id   = 'lic:' + license;
      const used = await store.getMonthly(id);
      restant    = Math.max(0, info.limit - used) + (await store.getCredits(license));
    } else if (info.kind === 'credits') {
      restant = await store.getCredits(license);
    } else if (info.kind === 'none') {
      const used = await store.getTrial(deviceId);
      restant    = Math.max(0, (limits.trial || 5) - used);
    }

    return res.json({
      ok: true,
      keyword: keyword,
      lang: lang,
      digitalOnly: digitalOnly,
      verdict: verdict,
      scores: scores,
      market: {
        totalListings:    total,
        listingsAnalyzed: listings.length,
        fetchedAt:        fetchedAt,
        apiError:         apiError || null,
        sampleListings:   listings.slice(0, 5).map(function(l) {
          return { title: l.title, price: l.price, favorites: l.favorites, isDigital: l.isDigital };
        }),
      },
      reports: {
        verdictReasons:  aiResult.verdict_reasons   || [],
        summary:         aiResult.summary           || '',
        subNiches:       aiResult.sub_niches        || [],
        smallSellerWins: aiResult.small_seller_wins || [],
        creationBrief:   aiResult.creation_brief    || {},
        seasonalityNote: aiResult.seasonality_note  || null,
      },
      restant: restant,
    });

  } catch (err) {
    console.error('[ENI]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

router.post('/compare', async function(req, res) {
  try {
    const body     = req.body || {};
    const analyses = body.analyses || [];
    const lang     = body.lang || 'en';
    if (analyses.length < 2 || analyses.length > 3)
      return res.status(400).json({ ok: false, error: 'need 2 or 3 analyses' });

    const { generate } = require('./aiprovider');
    const lines  = analyses.map(function(a, i) {
      return 'Niche ' + (i+1) + ': "' + a.keyword + '" score=' + (a.scores && a.scores.opportunity || 0) + '/100 verdict=' + a.verdict;
    }).join('\n');

    const prompt = 'Compare these ' + analyses.length + ' Etsy niches. Respond in "' + lang + '".\n' + lines + '\n' +
      'Return ONLY JSON: {"winner":<0|1|2>,"winner_reason":"<2 sentences in ' + lang + '>","comparison_matrix":[{"dimension":"<in ' + lang + '>","values":["<n1>","<n2>","<n3 or null>"]}],"combined_opportunity":"<insight in ' + lang + ' or null>"}';

    let ai = {};
    try {
      const raw = await generate(prompt);
      ai        = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { console.error('[ENI compare]', e.message); }

    return res.json({
      ok:                  true,
      analyses:            analyses.map(function(a) { return { keyword: a.keyword, score: a.scores && a.scores.opportunity, verdict: a.verdict }; }),
      winner:              ai.winner,
      winnerReason:        ai.winner_reason        || '',
      comparisonMatrix:    ai.comparison_matrix     || [],
      combinedOpportunity: ai.combined_opportunity  || null,
    });
  } catch (err) {
    console.error('[ENI compare]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
