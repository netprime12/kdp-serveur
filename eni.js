// ============================================================
// eni.js — NicheScout v3.0 · Etsy Niche Intelligence
// Améliorations v3 : prompt fusionné (2 passes au lieu de 3),
// fallback IA pour Trends, cache Redis, JSON parsing robuste,
// validation résultats, scoring enrichi, champs complets
// ============================================================

const express = require('express');
const https   = require('https');
const router  = express.Router();

// ── Cache : Redis si dispo (store.js), sinon mémoire ─────────
let _store = null;
function getStore() {
  if (!_store) { try { _store = require('./store'); } catch(e) { _store = {}; } }
  return _store;
}
const _mem = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1h

async function cacheGet(k) {
  const st = getStore();
  if (st.redisGet) {
    try { const v = await st.redisGet('eni:' + k); return v ? JSON.parse(v) : null; } catch(e) {}
  }
  const e = _mem.get(k);
  if (!e || Date.now() - e.ts > CACHE_TTL) { _mem.delete(k); return null; }
  return e.data;
}
async function cacheSet(k, d) {
  const st = getStore();
  if (st.redisSet) {
    try { await st.redisSet('eni:' + k, JSON.stringify(d), 3600); return; } catch(e) {}
  }
  _mem.set(k, { data: d, ts: Date.now() });
}

// ── JSON parsing robuste ──────────────────────────────────────
function safeParseAI(raw) {
  if (!raw || typeof raw !== 'string') return raw || {};
  var s = raw.trim();
  // Retirer blocs markdown
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim();
  // Trouver le premier { ou [
  var start = Math.min(
    s.indexOf('{') >= 0 ? s.indexOf('{') : 9999,
    s.indexOf('[') >= 0 ? s.indexOf('[') : 9999
  );
  if (start === 9999) return {};
  s = s.slice(start);
  // Trouver le dernier } ou ]
  var lastB = s.lastIndexOf('}');
  var lastSB = s.lastIndexOf(']');
  var end = Math.max(lastB, lastSB);
  if (end >= 0) s = s.slice(0, end + 1);
  try { return JSON.parse(s); } catch(e) {
    // Tentative de réparation : retirer trailing comma
    try { return JSON.parse(s.replace(/,\s*([\]}])/g, '$1')); } catch(e2) { return {}; }
  }
}

// ── Validation résultats IA ───────────────────────────────────
function validateAndFill(aiResult, keyword, lang) {
  if (!aiResult || typeof aiResult !== 'object') aiResult = {};

  // sub_niches : minimum 5, max 10
  if (!Array.isArray(aiResult.sub_niches) || aiResult.sub_niches.length < 3) {
    aiResult.sub_niches = [
      { keyword: keyword + ' digital download', angle: 'format', description: 'Instant download version targeting busy buyers', estimated_score: 55, digital_friendly: true, example_product: 'Instant PDF ' + keyword },
      { keyword: keyword + ' canva template', angle: 'format', description: 'Editable Canva template for easy personalization', estimated_score: 60, digital_friendly: true, example_product: 'Canva template ' + keyword },
      { keyword: keyword + ' bundle', angle: 'bundle', description: 'Value bundle combining multiple designs', estimated_score: 65, digital_friendly: true, example_product: 'Bundle pack ' + keyword },
    ];
  }

  // tags : minimum 13
  if (!Array.isArray(aiResult.tags_candidates) || aiResult.tags_candidates.length < 10) {
    var base = keyword.toLowerCase().split(' ');
    aiResult.tags_candidates = [
      ...base,
      'digital download', 'printable', 'instant download', 'editable',
      'canva template', 'pdf download', 'commercial use',
    ].slice(0, 13);
  }
  // Tronquer les tags à 20 chars
  aiResult.tags_candidates = aiResult.tags_candidates.slice(0, 13).map(function(t) {
    return String(t).slice(0, 20);
  });

  // Champs obligatoires
  if (!aiResult.verdict_reasons || aiResult.verdict_reasons.length < 2) {
    aiResult.verdict_reasons = ['Market analysis based on competitive intelligence', 'AI assessment of niche differentiation potential'];
  }
  if (!aiResult.summary) aiResult.summary = 'Analysis of the "' + keyword + '" niche for digital product sellers.';
  if (!aiResult.small_seller_wins || !aiResult.small_seller_wins.length) {
    aiResult.small_seller_wins = ['Target micro-audiences underserved by current listings', 'Focus on specific occasions rather than broad categories'];
  }
  if (!aiResult.concept) aiResult.concept = 'Original ' + keyword + ' digital product with unique angle';
  if (!aiResult.target_audience) aiResult.target_audience = 'Etsy buyers searching for ' + keyword;
  if (!aiResult.usp) aiResult.usp = 'Unique design approach differentiating from existing listings';
  if (!Array.isArray(aiResult.assets_to_create) || !aiResult.assets_to_create.length) {
    aiResult.assets_to_create = ['Main PDF file (US Letter)', 'Preview mockup image', 'Instruction guide', 'Color variation', 'Bonus template'];
  }
  if (!Array.isArray(aiResult.pre_publish_checklist) || !aiResult.pre_publish_checklist.length) {
    aiResult.pre_publish_checklist = ['Check trademark on searched keywords', 'Prepare 10 high-quality listing photos', 'Write SEO-optimized description', 'Set competitive pricing', 'Enable instant download'];
  }
  if (!aiResult.trademark_warning) aiResult.trademark_warning = 'Verify that no terms in your title or tags are trademarked before listing.';
  if (!aiResult.listing_title_suggestion) aiResult.listing_title_suggestion = keyword + ' | Digital Download | Printable | Instant Download';
  if (!aiResult.launch_window) aiResult.launch_window = 'Consider launching 4-6 weeks before peak season for this niche.';
  if (!aiResult.demand_score_estimate) aiResult.demand_score_estimate = 50;
  if (!aiResult.seasonality_peak) aiResult.seasonality_peak = null;
  if (!aiResult.trend_direction) aiResult.trend_direction = 'stable';
  if (!aiResult.competition_level) aiResult.competition_level = 'medium';
  if (!aiResult.avg_price_estimate) aiResult.avg_price_estimate = 8;
  if (!aiResult.differentiation_score) aiResult.differentiation_score = 50;
  if (!aiResult.market_maturity) aiResult.market_maturity = 'growing';

  return aiResult;
}

// ── Score composite ───────────────────────────────────────────
function buildScore(aiResult, manualData) {
  manualData = manualData || {};

  // Demande : IA donne demand_score_estimate 0-100
  var demandScore = aiResult.demand_score_estimate || 50;
  // Boost si données manuelles
  if (manualData.estimatedResults > 5000) demandScore = Math.min(demandScore + 10, 100);

  // Accessibilité
  var compMap = { low: 80, medium: 50, high: 20 };
  var accessScore = compMap[aiResult.competition_level] || 50;
  if (manualData.hasSmallSellers) accessScore = Math.min(accessScore + 15, 100);
  if (manualData.competitionLevel) accessScore = compMap[manualData.competitionLevel] || accessScore;

  // Faiblesse concurrentielle = differentiation_score
  var diffScore = aiResult.differentiation_score || 50;

  // Marge
  var price = manualData.avgPrice || aiResult.avg_price_estimate || 8;
  var marginScore = Math.min(price / 20 * 100, 100);

  // Diversité (fixe à 50 — pas de données Etsy)
  var diversityScore = 50;

  // Fraîcheur / Tendance IA
  var trendMap = { growing: 80, stable: 50, declining: 25, seasonal: 70 };
  var freshScore = trendMap[aiResult.trend_direction] || 50;
  // Boost saisonnier si on est dans le bon mois
  if (aiResult.seasonality_peak) {
    var now = new Date();
    var peak = String(aiResult.seasonality_peak).toLowerCase();
    var monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    var peakMonth = monthNames.findIndex(function(m) { return peak.includes(m); });
    if (peakMonth >= 0) {
      var diff = Math.abs(now.getMonth() - peakMonth);
      if (diff <= 1) freshScore = Math.min(freshScore + 20, 100); // dans le bon mois ±1
      else if (diff <= 2) freshScore = Math.min(freshScore + 10, 100); // 2 mois avant
    }
  }

  var raw =
    demandScore   * 0.32 +
    accessScore   * 0.25 +
    diffScore     * 0.22 +
    marginScore   * 0.12 +
    diversityScore* 0.05 +
    freshScore    * 0.04;

  // Confiance
  var sources = 0;
  if (aiResult.demand_score_estimate && aiResult.demand_score_estimate !== 50) sources += 2;
  if (aiResult.differentiation_score && aiResult.differentiation_score !== 50) sources += 2;
  if (manualData.competitionLevel) sources += 1;
  var confRatio = Math.min(sources / 5, 1);
  // Toujours au moins medium car l'IA fournit toujours des données
  var confidence = confRatio >= 0.8 ? 'high' : 'medium';

  return {
    opportunity: Math.round(raw),
    subscores: {
      demand:        Math.round(demandScore),
      accessibility: Math.round(accessScore),
      weakness:      Math.round(diffScore),
      margin:        Math.round(marginScore),
      diversity:     diversityScore,
      freshness:     Math.round(freshScore),
    },
    confidence: confidence,
    trendDirection: aiResult.trend_direction || 'stable',
    seasonalityPeak: aiResult.seasonality_peak || null,
    meta: {
      listingsAnalyzed: 0,
      avgFavorites:     0,
      medianPrice:      price.toFixed ? price.toFixed(2) : price,
      smallShopPct:     accessScore > 60 ? 60 : 30,
      lowBarrierPct:    accessScore > 60 ? 55 : 25,
      isDigitalNiche:   true,
      uniqueShops:      0,
      priceRange:       aiResult.price_range || ('$5-$' + (price * 2.5).toFixed(0)),
      competitionLevel: aiResult.competition_level || 'medium',
      marketMaturity:   aiResult.market_maturity || 'growing',
      dataSource:       'ai-market-intelligence',
    },
  };
}

function computeVerdict(score, confidence) {
  if (score >= 63) return 'go';
  if (score >= 38) return 'test';
  return 'nogo';
}

// ── PROMPT PASSE 1 : Analyse rapide du marché ─────────────────
function buildPromptP1(keyword, lang, digitalOnly, manualData) {
  var extra = '';
  if (manualData && manualData.competitionLevel) {
    extra = '\nSeller observations: competition=' + manualData.competitionLevel +
      ', avg_price=$' + (manualData.avgPrice || '?') +
      ', small_sellers=' + (manualData.hasSmallSellers ? 'yes' : 'no') +
      ', estimated_results=' + (manualData.estimatedResults || '?');
  }
  return 'You are a senior Etsy market analyst with deep expertise in digital product niches (2023-2025 data).\n\n' +
    'Quickly assess the Etsy market for: "' + keyword + '"\n' +
    'Product type: ' + (digitalOnly ? 'digital products (PDF, PNG, SVG, Canva/Notion templates, etc.)' : 'all products') + extra + '\n\n' +
    'Use your training knowledge about Etsy marketplace trends, competition patterns, and digital product pricing.\n\n' +
    'Return ONLY valid JSON:\n{\n' +
    '  "competition_level": "low|medium|high",\n' +
    '  "differentiation_score": <0-100, 100=massive room to differentiate>,\n' +
    '  "demand_score_estimate": <0-100, based on your knowledge of search popularity>,\n' +
    '  "avg_price_estimate": <typical digital product price in USD>,\n' +
    '  "price_range": "<min>-<max>",\n' +
    '  "market_maturity": "emerging|growing|mature|saturated",\n' +
    '  "trend_direction": "growing|stable|declining|seasonal",\n' +
    '  "seasonality_peak": "<month name if seasonal, else null>",\n' +
    '  "key_insight": "<single most important insight about this niche in ' + lang + '>"\n' +
    '}';
}

// ── PROMPT PASSE 2 : Sous-niches + Brief (fusionné) ───────────
function buildPromptP2(keyword, lang, digitalOnly, scores, p1) {
  return 'You are an Etsy creative strategist. Build a complete niche report for "' + keyword + '".\n\n' +
    'Market context (from analysis):\n' +
    '- Competition: ' + p1.competition_level + ' | Maturity: ' + p1.market_maturity + '\n' +
    '- Demand: ' + p1.demand_score_estimate + '/100 | Differentiation opportunity: ' + p1.differentiation_score + '/100\n' +
    '- Trend: ' + p1.trend_direction + (p1.seasonality_peak ? ' (peaks: ' + p1.seasonality_peak + ')' : '') + '\n' +
    '- Key insight: ' + p1.key_insight + '\n\n' +
    'Product type: ' + (digitalOnly ? 'DIGITAL products ONLY (PDF, PNG, SVG, Canva template, Notion, Lightroom preset, etc.)' : 'all products') + '\n\n' +
    'Respond ONLY in "' + lang + '". Return ONLY valid JSON:\n' +
    '{\n' +
    '  "verdict_reasons": ["<reason 1>","<reason 2>","<reason 3>"],\n' +
    '  "summary": "<2-3 sentence market overview>",\n' +
    '  "sub_niches": [\n' +
    '    {\n' +
    '      "keyword": "<specific Etsy-searchable keyword>",\n' +
    '      "angle": "audience|occasion|style|format|season|culture|humor|bundle",\n' +
    '      "description": "<why promising, 1 sentence>",\n' +
    '      "estimated_score": <0-100>,\n' +
    '      "digital_friendly": true,\n' +
    '      "example_product": "<concrete product a seller could create today>"\n' +
    '    }\n' +
    '  ],\n' +
    '  "small_seller_wins": ["<opportunity 1>","<opportunity 2>","<opportunity 3>"],\n' +
    '  "concept": "<ORIGINAL product concept, not a copy of existing listings>",\n' +
    '  "target_audience": "<precise buyer persona with context and motivation>",\n' +
    '  "occasion": "<specific use case or occasion>",\n' +
    '  "style": "<precise visual/aesthetic style with concrete references>",\n' +
    '  "format": "<exact file format and technical specs>",\n' +
    '  "usp": "<unique selling proposition vs existing competition>",\n' +
    '  "assets_to_create": ["<asset 1 with specs>","<a2>","<a3>","<a4>","<a5>"],\n' +
    '  "tags_candidates": ["<t1>","<t2>","<t3>","<t4>","<t5>","<t6>","<t7>","<t8>","<t9>","<t10>","<t11>","<t12>","<t13>"],\n' +
    '  "listing_title_suggestion": "<optimized Etsy title, under 140 chars, keyword-rich>",\n' +
    '  "pre_publish_checklist": ["<item 1>","<item 2>","<item 3>","<item 4>","<item 5>"],\n' +
    '  "trademark_warning": "<specific trademark risks to check for this keyword>",\n' +
    '  "launch_window": "<best month/season to launch, with reasoning>"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Exactly 10 sub_niches, each with a DIFFERENT angle\n' +
    '- Exactly 13 tags_candidates, max 20 chars each, no duplicates, no trademark terms\n' +
    '- sub_niches must be specific enough to be searchable on Etsy (not generic)\n' +
    '- All text in "' + lang + '" except keyword fields';
}

// ── Ping ──────────────────────────────────────────────────────
router.get('/ping', function(req, res) {
  res.json({
    ok: true,
    version: '3.0',
    dataSources: ['ai-market-intelligence', 'manual-data'],
    passes: 2,
    cacheBackend: getStore().redisGet ? 'redis' : 'memory',
    memCacheSize: _mem.size,
  });
});

// ── POST /eni/analyse ─────────────────────────────────────────
router.post('/analyse', async function(req, res) {
  try {
    var body        = req.body || {};
    var license     = body.licenseKey || body.license || '';
    var deviceId    = body.deviceId  || '';
    var keyword     = (body.keyword  || '').trim();
    var lang        = body.lang      || 'en';
    var digitalOnly = body.digitalOnly !== false;
    var manualData  = body.manualData || {};

    if (keyword.length < 2)
      return res.status(400).json({ ok: false, error: 'invalid_keyword' });

    // --- Licence ---
    var checkLicense = require('./license').checkLicense;
    var store        = require('./store');
    var generate     = require('./aiprovider').generate;
    var planLimits   = require('./license').planLimits;

    var info = await checkLicense(license);
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

    var limits = planLimits ? planLimits() : { trial: 5 };
    var available = 0, bucketPlan = 'trial';

    if (info.kind === 'dev') {
      available = 9999; bucketPlan = 'dev';
    } else if (info.kind === 'subscription') {
      var u1 = await store.getMonthly('lic:' + license);
      var c1 = await store.getCredits(license);
      available = Math.max(0, info.limit - u1) + c1; bucketPlan = 'abo';
    } else if (info.kind === 'credits') {
      available = await store.getCredits(license); bucketPlan = 'credits';
    } else {
      var u2 = await store.getTrial(deviceId);
      available = Math.max(0, limits.trial - u2);
    }

    if (available <= 0)
      return res.status(402).json({ ok: false, error: 'quota_atteint',
        message: bucketPlan === 'trial'
          ? 'Free trial exhausted. Subscribe or buy credits.'
          : 'Quota reached. Resets next month, or buy credits.' });

    // --- Cache ---
    var ck = keyword + ':' + lang + ':' + (digitalOnly?'d':'a');
    var cached = await cacheGet(ck);
    if (cached) {
      var rc = Object.assign({}, cached, { fromCache: true, restant: null });
      return res.json(rc);
    }

    // ══════════════════════════════════════════════════════════
    // PASSE 1 : Analyse marché rapide
    // ══════════════════════════════════════════════════════════
    var p1Raw = await generate(buildPromptP1(keyword, lang, digitalOnly, manualData))
      .catch(function(e){ console.error('[ENI P1]', e.message); return '{}'; });
    var p1 = validateAndFill(safeParseAI(p1Raw), keyword, lang);

    // ══════════════════════════════════════════════════════════
    // PASSE 2 : Rapport complet (sous-niches + brief fusionnés)
    // ══════════════════════════════════════════════════════════
    var scores = buildScore(p1, manualData);
    var p2Raw  = await generate(buildPromptP2(keyword, lang, digitalOnly, scores, p1))
      .catch(function(e){ console.error('[ENI P2]', e.message); return '{}'; });
    var p2 = validateAndFill(safeParseAI(p2Raw), keyword, lang);

    var verdict = computeVerdict(scores.opportunity, scores.confidence);

    // --- Débit ---
    if (info.kind === 'dev') {
      if (store.incrementMonthly) await store.incrementMonthly('dev');
    } else if (info.kind === 'subscription') {
      var idL = 'lic:' + license, uL = await store.getMonthly(idL);
      if (uL < info.limit) await store.incrementMonthly(idL);
      else if (store.consumeCredit) await store.consumeCredit(license);
    } else if (info.kind === 'credits') {
      if (store.consumeCredit) await store.consumeCredit(license);
    } else {
      await store.incrementTrial(deviceId);
    }

    // Restant
    var restant = null;
    if (info.kind === 'subscription') {
      var uR = await store.getMonthly('lic:' + license);
      restant = Math.max(0, info.limit - uR) + (await store.getCredits(license));
    } else if (info.kind === 'credits') {
      restant = await store.getCredits(license);
    } else if (info.kind === 'none') {
      var uT = await store.getTrial(deviceId);
      restant = Math.max(0, (limits.trial || 5) - uT);
    }

    var result = {
      ok: true, keyword, lang, digitalOnly, verdict, scores,
      market: {
        totalListings: 0, listingsAnalyzed: 0,
        fetchedAt:     Date.now(),
        dataSource:    'ai-market-intelligence-v3',
        trendDirection: p1.trend_direction || 'stable',
        seasonalityPeak: p1.seasonality_peak || null,
        competitionLevel: p1.competition_level || 'medium',
        marketMaturity: p1.market_maturity || 'growing',
        avgPriceEstimate: p1.avg_price_estimate || 8,
        priceRange: p1.price_range || 'N/A',
        sampleListings: [],
      },
      reports: {
        verdictReasons:  p2.verdict_reasons   || [],
        summary:         p2.summary           || p1.key_insight || '',
        subNiches:       p2.sub_niches        || [],
        smallSellerWins: p2.small_seller_wins || [],
        creationBrief: {
          concept:              p2.concept              || '',
          target_audience:      p2.target_audience      || '',
          occasion:             p2.occasion             || '',
          style:                p2.style                || '',
          format:               p2.format               || '',
          usp:                  p2.usp                  || '',
          assets_to_create:     p2.assets_to_create     || [],
          tags_candidates:      p2.tags_candidates      || [],
          listing_title_suggestion: p2.listing_title_suggestion || '',
          pre_publish_checklist: p2.pre_publish_checklist || [],
          trademark_warning:    p2.trademark_warning    || '',
          launch_window:        p2.launch_window        || '',
        },
        seasonalityNote: p2.launch_window || p1.seasonality_peak || null,
        marketInsight:   p1.key_insight   || '',
      },
      restant,
    };

    await cacheSet(ck, result);
    return res.json(result);

  } catch(err) {
    console.error('[ENI]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

// ── POST /eni/compare ─────────────────────────────────────────
router.post('/compare', async function(req, res) {
  try {
    var body = req.body || {}, analyses = body.analyses || [], lang = body.lang || 'en';
    if (analyses.length < 2 || analyses.length > 3)
      return res.status(400).json({ ok: false, error: 'need 2 or 3 analyses' });

    var generate = require('./aiprovider').generate;
    var ctx = analyses.map(function(a, i) {
      return 'Niche ' + (i+1) + ': "' + a.keyword + '"\n' +
        '- Score: ' + (a.scores&&a.scores.opportunity||0) + '/100 | Verdict: ' + a.verdict + '\n' +
        '- Competition: ' + (a.market&&a.market.competitionLevel||'?') +
        ' | Maturity: ' + (a.market&&a.market.marketMaturity||'?') + '\n' +
        '- Trend: ' + (a.market&&a.market.trendDirection||'?') + '\n' +
        '- Summary: ' + (a.reports&&a.reports.summary||'');
    }).join('\n\n');

    var prompt = 'Compare these ' + analyses.length + ' Etsy niches and give actionable recommendations. Respond in "' + lang + '".\n\n' +
      ctx + '\n\nReturn ONLY valid JSON:\n' +
      '{"winner":<0|1|2>,"winner_reason":"<2 sentences>","comparison_matrix":[{"dimension":"<name>","values":["<n1>","<n2>","<n3 or null>"]}],"combined_opportunity":"<synergy insight or null>","action_plan":"<what the seller should do next, 2-3 sentences>"}';

    var ai = {};
    try {
      var raw = await generate(prompt);
      ai = safeParseAI(raw);
    } catch(e) { console.error('[ENI compare]', e.message); }

    return res.json({
      ok: true,
      analyses: analyses.map(function(a){ return { keyword:a.keyword, score:a.scores&&a.scores.opportunity, verdict:a.verdict }; }),
      winner:              ai.winner,
      winnerReason:        ai.winner_reason        || '',
      comparisonMatrix:    ai.comparison_matrix     || [],
      combinedOpportunity: ai.combined_opportunity  || null,
      actionPlan:          ai.action_plan           || '',
    });
  } catch(err) {
    console.error('[ENI compare]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
