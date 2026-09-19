// ============================================================
// eni.js — Etsy Niche Intelligence · NicheScout v2
// Sources : Google Trends (gratuit) + IA 3 passes (Mistral/Gemini)
// Aucune API externe payante ou soumise à approbation
// Monter dans server.js : app.use('/eni', require('./eni'))
// ============================================================

const express = require('express');
const https   = require('https');
const http    = require('http');
const router  = express.Router();

// ── Cache mémoire simple (1h) ─────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
function cacheGet(k){ const e=_cache.get(k); if(!e||Date.now()-e.ts>CACHE_TTL){_cache.delete(k);return null;} return e.data; }
function cacheSet(k,d){ _cache.set(k,{data:d,ts:Date.now()}); }

// ── Google Trends (sans clé API) ──────────────────────────────
// Utilise l'endpoint non-officiel mais stable de Google Trends
function fetchTrends(keyword, geo) {
  return new Promise(function(resolve) {
    geo = geo || 'US';
    var enc = encodeURIComponent(keyword);
    var url = 'https://trends.google.com/trends/api/explore?hl=en-US&tz=-60&req=' +
      encodeURIComponent(JSON.stringify({
        comparisonItem: [{ keyword: keyword, geo: geo, time: 'today 12-m' }],
        category: 0,
        property: ''
      })) + '&tz=-60';

    var opts = {
      hostname: 'trends.google.com',
      path: '/trends/api/explore?hl=en-US&tz=-60&req=' +
        encodeURIComponent(JSON.stringify({
          comparisonItem: [{ keyword: keyword, geo: geo, time: 'today 12-m' }],
          category: 0,
          property: ''
        })),
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    };

    var req = https.get(opts, function(res) {
      var raw = '';
      res.on('data', function(d){ raw += d; });
      res.on('end', function() {
        try {
          // Google Trends ajoute ")]}',\n" au début — on le retire
          var clean = raw.replace(/^\)\]\}',\n/, '').trim();
          var data = JSON.parse(clean);
          // Extraire les widgets
          var widgets = data.widgets || [];
          var timeWidget = widgets.find(function(w){ return w.id === 'TIMESERIES'; });
          if (!timeWidget) return resolve({ score: 50, trend: 'stable', peak: null, data: [] });

          // Récupérer les données temporelles
          fetchTrendsTimeline(timeWidget.token, geo, keyword, resolve);
        } catch(e) {
          console.warn('[ENI Trends explore]', e.message);
          resolve({ score: 50, trend: 'stable', peak: null, data: [] });
        }
      });
    });
    req.on('error', function(e){
      console.warn('[ENI Trends]', e.message);
      resolve({ score: 50, trend: 'stable', peak: null, data: [] });
    });
    req.setTimeout(8000, function(){ req.destroy(); resolve({ score: 50, trend: 'stable', peak: null, data: [] }); });
  });
}

function fetchTrendsTimeline(token, geo, keyword, resolve) {
  var body = JSON.stringify({
    time: 'today 12-m',
    resolution: 'WEEK',
    locale: 'en-US',
    comparisonItem: [{ geo: { country: geo }, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: keyword }] } }],
    requestOptions: { property: '', backend: 'IZG', category: 0 }
  });

  var path = '/trends/api/widgetdata/multiline?hl=en-US&tz=-60&req=' +
    encodeURIComponent(body) + '&token=' + encodeURIComponent(token) + '&tz=-60';

  var opts = {
    hostname: 'trends.google.com',
    path: path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  };

  var req = https.get(opts, function(res) {
    var raw = '';
    res.on('data', function(d){ raw += d; });
    res.on('end', function() {
      try {
        var clean = raw.replace(/^\)\]\}',\n/, '').trim();
        var data = JSON.parse(clean);
        var points = (data.default && data.default.timelineData) || [];
        var values = points.map(function(p){ return p.value && p.value[0] ? p.value[0] : 0; });

        if (!values.length) return resolve({ score: 50, trend: 'stable', peak: null, data: [] });

        var avg = values.reduce(function(s,v){ return s+v; }, 0) / values.length;
        var max = Math.max.apply(null, values);
        var recent = values.slice(-4); // 4 dernières semaines
        var recentAvg = recent.reduce(function(s,v){ return s+v; }, 0) / recent.length;

        // Tendance : croissante, stable ou déclinante
        var trend = 'stable';
        if (recentAvg > avg * 1.15) trend = 'growing';
        else if (recentAvg < avg * 0.85) trend = 'declining';

        // Pic saisonnier : mois avec valeur max
        var peakIdx = values.indexOf(max);
        var peakWeek = points[peakIdx] ? points[peakIdx].formattedAxisTime : null;

        // Score de demande 0-100
        var demandScore = Math.round(Math.min(avg / 100 * 100, 100));
        // Bonus si tendance croissante
        if (trend === 'growing') demandScore = Math.min(demandScore + 15, 100);
        if (trend === 'declining') demandScore = Math.max(demandScore - 10, 0);

        resolve({
          score: demandScore,
          trend: trend,
          avg: Math.round(avg),
          max: max,
          recentAvg: Math.round(recentAvg),
          peak: peakWeek,
          data: values.slice(-12) // 12 dernières semaines
        });
      } catch(e) {
        console.warn('[ENI Trends timeline]', e.message);
        resolve({ score: 50, trend: 'stable', peak: null, data: [] });
      }
    });
  });
  req.on('error', function(e){ resolve({ score: 50, trend: 'stable', peak: null, data: [] }); });
  req.setTimeout(8000, function(){ req.destroy(); resolve({ score: 50, trend: 'stable', peak: null, data: [] }); });
}

// ── Score composite ───────────────────────────────────────────
function buildCompositeScore(trendsData, manualData, aiPrelim) {
  manualData = manualData || {};

  // 1. Demande (0.35) — Google Trends
  var demandScore = trendsData.score || 50;

  // 2. Accessibilité (0.25) — données manuelles ou estimation IA
  var accessScore = 50;
  if (manualData.competitionLevel) {
    accessScore = { low: 80, medium: 50, high: 20 }[manualData.competitionLevel] || 50;
  } else if (aiPrelim && aiPrelim.competition_level) {
    accessScore = { low: 80, medium: 50, high: 20 }[aiPrelim.competition_level] || 50;
  }
  if (manualData.hasSmallSellers) accessScore = Math.min(accessScore + 15, 100);

  // 3. Opportunité différenciation (0.20) — IA passe 1
  var diffScore = aiPrelim ? (aiPrelim.differentiation_score || 50) : 50;

  // 4. Marge potentielle (0.12)
  var marginScore = 50;
  if (manualData.avgPrice) marginScore = Math.min(manualData.avgPrice / 20 * 100, 100);
  else if (aiPrelim && aiPrelim.avg_price_estimate) marginScore = Math.min(aiPrelim.avg_price_estimate / 20 * 100, 100);

  // 5. Fraîcheur / Tendance (0.08)
  var freshScore = 50;
  if (trendsData.trend === 'growing') freshScore = 80;
  else if (trendsData.trend === 'declining') freshScore = 25;

  var raw =
    demandScore  * 0.35 +
    accessScore  * 0.25 +
    diffScore    * 0.20 +
    marginScore  * 0.12 +
    freshScore   * 0.08;

  // Confiance selon les sources disponibles
  var sources = 0;
  if (trendsData.score && trendsData.data && trendsData.data.length > 0) sources += 2;
  if (manualData.competitionLevel) sources += 1;
  if (aiPrelim && aiPrelim.differentiation_score) sources += 2;
  var confRatio = Math.min(sources / 5, 1);
  var confidence = confRatio >= 0.8 ? 'high' : confRatio >= 0.4 ? 'medium' : 'low';

  return {
    opportunity: Math.round(raw * (0.7 + confRatio * 0.3)),
    subscores: {
      demand:        Math.round(demandScore),
      accessibility: Math.round(accessScore),
      weakness:      Math.round(diffScore),
      margin:        Math.round(marginScore),
      diversity:     50,
      freshness:     Math.round(freshScore),
    },
    confidence: confidence,
    trendsData: trendsData,
    meta: {
      listingsAnalyzed: 0,
      avgFavorites:     0,
      medianPrice:      aiPrelim ? (aiPrelim.avg_price_estimate || 0).toFixed(2) : '0.00',
      smallShopPct:     accessScore > 60 ? 60 : 30,
      lowBarrierPct:    accessScore > 60 ? 55 : 25,
      isDigitalNiche:   true,
      uniqueShops:      0,
      priceRange:       aiPrelim ? '$' + (aiPrelim.price_range || '5-25') : 'N/A',
      trendScore:       trendsData.score || 50,
      trendDirection:   trendsData.trend || 'stable',
      trendPeak:        trendsData.peak || null,
    },
  };
}

function computeVerdict(score, confidence) {
  if (confidence === 'low' && score < 50) return 'test';
  if (score >= 62) return 'go';
  if (score >= 38) return 'test';
  return 'nogo';
}

// ── IA PASSE 1 : Analyse préliminaire rapide ──────────────────
function buildPromptPass1(keyword, lang, digitalOnly, manualData) {
  var extra = '';
  if (manualData && manualData.competitionLevel) {
    extra = '\nUser observation: competition level = ' + manualData.competitionLevel +
      ', avg price = $' + (manualData.avgPrice || '?') +
      ', small sellers present = ' + (manualData.hasSmallSellers ? 'yes' : 'no');
  }
  return 'You are an expert Etsy market analyst with deep knowledge of the Etsy marketplace in 2024-2025.\n\n' +
    'Quickly assess this niche for an Etsy seller wanting to create ' + (digitalOnly ? 'digital products' : 'products') + '.\n' +
    'Niche keyword: "' + keyword + '"' + extra + '\n\n' +
    'Return ONLY valid JSON (no markdown, no explanation):\n' +
    '{\n' +
    '  "competition_level": "low|medium|high",\n' +
    '  "differentiation_score": <0-100, higher means more room to differentiate>,\n' +
    '  "avg_price_estimate": <typical digital product price in USD, number only>,\n' +
    '  "price_range": "<min>-<max>",\n' +
    '  "market_maturity": "emerging|growing|mature|saturated",\n' +
    '  "key_insight": "<most important thing to know about this niche in ' + lang + ', 1 sentence>"\n' +
    '}';
}

// ── IA PASSE 2 : Sous-niches + Small Seller Wins ──────────────
function buildPromptPass2(keyword, lang, digitalOnly, scores, aiPrelim) {
  return 'You are an Etsy niche specialist. Based on the analysis of "' + keyword + '":\n\n' +
    'Market context:\n' +
    '- Competition: ' + (aiPrelim.competition_level || 'medium') + '\n' +
    '- Differentiation opportunity: ' + (aiPrelim.differentiation_score || 50) + '/100\n' +
    '- Market maturity: ' + (aiPrelim.market_maturity || 'growing') + '\n' +
    '- Demand trend score: ' + scores.subscores.demand + '/100\n' +
    '- Key insight: ' + (aiPrelim.key_insight || '') + '\n\n' +
    'Generate 10 DISTINCT sub-niches for a seller creating ' + (digitalOnly ? 'DIGITAL products (PDF, PNG, SVG, Canva templates, Notion templates, Lightroom presets, etc.)' : 'products') + '.\n' +
    'Each sub-niche must target a DIFFERENT angle: audience, occasion, style, format, season, culture, humor, bundle.\n' +
    'Avoid generic sub-niches. Be specific and creative.\n\n' +
    'Also identify 3 "Small Seller Wins" — specific observations about accessible opportunities for new sellers.\n\n' +
    'Respond ONLY in "' + lang + '" language. Return ONLY valid JSON:\n' +
    '{\n' +
    '  "sub_niches": [\n' +
    '    {\n' +
    '      "keyword": "<specific searchable keyword>",\n' +
    '      "angle": "<audience|occasion|style|format|season|culture|humor|bundle>",\n' +
    '      "description": "<why this sub-niche is promising, 1 sentence in ' + lang + '>",\n' +
    '      "estimated_score": <0-100>,\n' +
    '      "digital_friendly": <true|false>,\n' +
    '      "example_product": "<concrete product idea in ' + lang + '>"\n' +
    '    }\n' +
    '  ],\n' +
    '  "small_seller_wins": [\n' +
    '    "<specific accessible opportunity for new sellers, in ' + lang + '>",\n' +
    '    "<win 2>",\n' +
    '    "<win 3>"\n' +
    '  ],\n' +
    '  "verdict_reasons": [\n' +
    '    "<reason explaining the market score, in ' + lang + '>",\n' +
    '    "<reason 2>",\n' +
    '    "<reason 3>"\n' +
    '  ],\n' +
    '  "summary": "<2-3 sentence market overview in ' + lang + '>"\n' +
    '}';
}

// ── IA PASSE 3 : Creation Brief complet ──────────────────────
function buildPromptPass3(keyword, lang, digitalOnly, aiPrelim, aiPass2) {
  var subNichesSummary = '';
  if (aiPass2 && aiPass2.sub_niches && aiPass2.sub_niches.length > 0) {
    subNichesSummary = 'Available sub-niches identified:\n' +
      aiPass2.sub_niches.slice(0, 3).map(function(sn, i) {
        return (i+1) + '. "' + sn.keyword + '" — ' + (sn.description || '');
      }).join('\n');
  }

  return 'You are a creative product strategist for Etsy sellers.\n\n' +
    'Create a detailed Creation Brief for a seller entering the "' + keyword + '" niche with a ' +
    (digitalOnly ? 'DIGITAL product' : 'product') + '.\n\n' +
    'Market context:\n' +
    '- Competition: ' + (aiPrelim.competition_level || 'medium') + '\n' +
    '- Key insight: ' + (aiPrelim.key_insight || '') + '\n' +
    subNichesSummary + '\n\n' +
    'Create an ORIGINAL product concept — NOT a copy of existing listings.\n' +
    'The brief must be immediately actionable: a seller should be able to start creating today.\n\n' +
    'Respond ONLY in "' + lang + '" language. Return ONLY valid JSON:\n' +
    '{\n' +
    '  "concept": "<original product concept, specific and actionable, NOT a copy, in ' + lang + '>",\n' +
    '  "target_audience": "<precise buyer persona with context, in ' + lang + '>",\n' +
    '  "occasion": "<specific use case or occasion, in ' + lang + '>",\n' +
    '  "style": "<precise visual/aesthetic style with references, in ' + lang + '>",\n' +
    '  "format": "<exact file format and specs for digital, in ' + lang + '>",\n' +
    '  "usp": "<unique selling proposition vs existing competition, in ' + lang + '>",\n' +
    '  "assets_to_create": [\n' +
    '    "<asset 1 with specific details, in ' + lang + '>",\n' +
    '    "<asset 2>", "<asset 3>", "<asset 4>", "<asset 5>"\n' +
    '  ],\n' +
    '  "tags_candidates": [\n' +
    '    "<tag1>","<tag2>","<tag3>","<tag4>","<tag5>",\n' +
    '    "<tag6>","<tag7>","<tag8>","<tag9>","<tag10>",\n' +
    '    "<tag11>","<tag12>","<tag13>"\n' +
    '  ],\n' +
    '  "listing_title_suggestion": "<optimized Etsy title under 140 chars, in ' + lang + '>",\n' +
    '  "pre_publish_checklist": [\n' +
    '    "<item 1 in ' + lang + '>","<item 2>","<item 3>","<item 4>","<item 5>"\n' +
    '  ],\n' +
    '  "trademark_warning": "<trademark and brand check reminder, in ' + lang + '>",\n' +
    '  "launch_window": "<best time to launch this product (month/season), in ' + lang + '>"\n' +
    '}';
}

// ── Ping ──────────────────────────────────────────────────────
router.get('/ping', function(req, res) {
  res.json({
    ok: true,
    version: '2.0',
    dataSources: ['google-trends', 'mistral-ai', 'gemini-ai', 'manual-data'],
    etsyApiRequired: false,
    cacheSize: _cache.size,
  });
});

// ── POST /eni/analyse ─────────────────────────────────────────
router.post('/analyse', async function(req, res) {
  try {
    var body        = req.body || {};
    var license     = body.licenseKey || body.license || '';
    var deviceId    = body.deviceId || '';
    var keyword     = (body.keyword || '').trim();
    var lang        = body.lang || 'en';
    var digitalOnly = body.digitalOnly !== false;
    var manualData  = body.manualData || {};

    if (keyword.length < 2) {
      return res.status(400).json({ ok: false, error: 'invalid_keyword' });
    }

    // --- Licence (même pattern que lof dans server.js) ---
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
    var available = 0;
    var bucketPlan = 'trial';

    if (info.kind === 'dev') {
      available = 9999; bucketPlan = 'dev';
    } else if (info.kind === 'subscription') {
      var used1 = await store.getMonthly('lic:' + license);
      var cred1 = await store.getCredits(license);
      available = Math.max(0, info.limit - used1) + cred1;
      bucketPlan = 'abo';
    } else if (info.kind === 'credits') {
      available = await store.getCredits(license);
      bucketPlan = 'credits';
    } else {
      var used2 = await store.getTrial(deviceId);
      available = Math.max(0, limits.trial - used2);
    }

    if (available <= 0) {
      return res.status(402).json({ ok: false, error: 'quota_atteint',
        message: bucketPlan === 'trial'
          ? 'Free trial exhausted. Subscribe or buy credits.'
          : 'Quota reached. Resets next month, or buy credits.' });
    }

    // --- Vérifier cache ---
    var cacheKey = 'eni:' + keyword + ':' + lang + ':' + digitalOnly;
    var cached = cacheGet(cacheKey);
    if (cached) {
      return res.json(Object.assign({}, cached, { fromCache: true }));
    }

    // ══════════════════════════════════════════════════════════
    // PASSE 1 : Google Trends + IA analyse préliminaire (parallèle)
    // ══════════════════════════════════════════════════════════
    var promptPass1 = buildPromptPass1(keyword, lang, digitalOnly, manualData);
    var [trendsData, rawPass1] = await Promise.all([
      fetchTrends(keyword, 'US'),
      generate(promptPass1).catch(function(e){ console.error('[ENI P1]', e.message); return '{}'; })
    ]);

    var aiPrelim = {};
    try {
      aiPrelim = typeof rawPass1 === 'string' ? JSON.parse(rawPass1.replace(/^```json\n?|```$/g,'').trim()) : rawPass1;
    } catch(e) {
      console.warn('[ENI P1 parse]', e.message);
      aiPrelim = { competition_level: 'medium', differentiation_score: 50, avg_price_estimate: 8, market_maturity: 'growing' };
    }

    // Score composite
    var scores  = buildCompositeScore(trendsData, manualData, aiPrelim);
    var verdict = computeVerdict(scores.opportunity, scores.confidence);

    // ══════════════════════════════════════════════════════════
    // PASSE 2 : Sous-niches + Small Wins (parallèle avec passe 3 si premium)
    // ══════════════════════════════════════════════════════════
    var promptPass2 = buildPromptPass2(keyword, lang, digitalOnly, scores, aiPrelim);
    var rawPass2 = await generate(promptPass2).catch(function(e){
      console.error('[ENI P2]', e.message); return '{}';
    });

    var aiPass2 = {};
    try {
      aiPass2 = typeof rawPass2 === 'string' ? JSON.parse(rawPass2.replace(/^```json\n?|```$/g,'').trim()) : rawPass2;
    } catch(e) {
      console.warn('[ENI P2 parse]', e.message);
      aiPass2 = { sub_niches: [], small_seller_wins: [], verdict_reasons: [], summary: '' };
    }

    // ══════════════════════════════════════════════════════════
    // PASSE 3 : Creation Brief complet
    // ══════════════════════════════════════════════════════════
    var promptPass3 = buildPromptPass3(keyword, lang, digitalOnly, aiPrelim, aiPass2);
    var rawPass3 = await generate(promptPass3).catch(function(e){
      console.error('[ENI P3]', e.message); return '{}';
    });

    var aiPass3 = {};
    try {
      aiPass3 = typeof rawPass3 === 'string' ? JSON.parse(rawPass3.replace(/^```json\n?|```$/g,'').trim()) : rawPass3;
    } catch(e) {
      console.warn('[ENI P3 parse]', e.message);
      aiPass3 = {};
    }

    // --- Débit ---
    if (info.kind === 'dev') {
      if (store.incrementMonthly) await store.incrementMonthly('dev');
    } else if (info.kind === 'subscription') {
      var idL = 'lic:' + license;
      var usedL = await store.getMonthly(idL);
      if (usedL < info.limit) await store.incrementMonthly(idL);
      else if (store.consumeCredit) await store.consumeCredit(license);
    } else if (info.kind === 'credits') {
      if (store.consumeCredit) await store.consumeCredit(license);
    } else {
      await store.incrementTrial(deviceId);
    }

    // Restant
    var restant = null;
    if (info.kind === 'subscription') {
      var usedR = await store.getMonthly('lic:' + license);
      restant = Math.max(0, info.limit - usedR) + (await store.getCredits(license));
    } else if (info.kind === 'credits') {
      restant = await store.getCredits(license);
    } else if (info.kind === 'none') {
      var usedT = await store.getTrial(deviceId);
      restant = Math.max(0, (limits.trial || 5) - usedT);
    }

    var result = {
      ok:         true,
      keyword:    keyword,
      lang:       lang,
      digitalOnly:digitalOnly,
      verdict:    verdict,
      scores:     scores,
      market: {
        totalListings:    0,
        listingsAnalyzed: 0,
        fetchedAt:        Date.now(),
        apiError:         null,
        sampleListings:   [],
        trendsData: {
          score:     trendsData.score,
          trend:     trendsData.trend,
          peak:      trendsData.peak,
          recentAvg: trendsData.recentAvg,
          data:      trendsData.data || [],
        },
        dataSource: 'google-trends + ai-analysis',
      },
      reports: {
        verdictReasons:  aiPass2.verdict_reasons   || [],
        summary:         aiPass2.summary           || aiPrelim.key_insight || '',
        subNiches:       aiPass2.sub_niches        || [],
        smallSellerWins: aiPass2.small_seller_wins || [],
        creationBrief:   aiPass3,
        seasonalityNote: aiPass3.launch_window     || null,
        marketInsight:   aiPrelim.key_insight      || '',
        marketMaturity:  aiPrelim.market_maturity  || '',
      },
      restant: restant,
    };

    // Mettre en cache
    cacheSet(cacheKey, result);

    return res.json(result);

  } catch(err) {
    console.error('[ENI]', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: err.message });
  }
});

// ── POST /eni/compare ─────────────────────────────────────────
router.post('/compare', async function(req, res) {
  try {
    var body     = req.body || {};
    var analyses = body.analyses || [];
    var lang     = body.lang || 'en';
    if (analyses.length < 2 || analyses.length > 3)
      return res.status(400).json({ ok: false, error: 'need 2 or 3 analyses' });

    var generate = require('./aiprovider').generate;

    var context = analyses.map(function(a, i) {
      return 'Niche ' + (i+1) + ': "' + a.keyword + '"\n' +
        '- Opportunity score: ' + (a.scores && a.scores.opportunity || 0) + '/100\n' +
        '- Verdict: ' + a.verdict + '\n' +
        '- Demand trend: ' + (a.scores && a.scores.trendsData && a.scores.trendsData.trend || 'stable') + '\n' +
        '- Market summary: ' + (a.reports && a.reports.summary || '');
    }).join('\n\n');

    var prompt = 'Compare these ' + analyses.length + ' Etsy niches and give a clear recommendation. Respond in "' + lang + '".\n\n' +
      context + '\n\n' +
      'Return ONLY valid JSON:\n' +
      '{\n' +
      '  "winner": <0|1|2>,\n' +
      '  "winner_reason": "<2 sentences explaining why this niche wins, in ' + lang + '>",\n' +
      '  "comparison_matrix": [\n' +
      '    {"dimension": "<dimension name in ' + lang + '>", "values": ["<niche1 assessment>", "<niche2 assessment>", "<niche3 or null>"]}\n' +
      '  ],\n' +
      '  "combined_opportunity": "<is there a way to combine these niches? insight in ' + lang + ' or null>"\n' +
      '}';

    var ai = {};
    try {
      var raw = await generate(prompt);
      ai = typeof raw === 'string' ? JSON.parse(raw.replace(/^```json\n?|```$/g,'').trim()) : raw;
    } catch(e) { console.error('[ENI compare]', e.message); }

    return res.json({
      ok:                  true,
      analyses:            analyses.map(function(a){ return { keyword: a.keyword, score: a.scores && a.scores.opportunity, verdict: a.verdict }; }),
      winner:              ai.winner,
      winnerReason:        ai.winner_reason        || '',
      comparisonMatrix:    ai.comparison_matrix     || [],
      combinedOpportunity: ai.combined_opportunity  || null,
    });
  } catch(err) {
    console.error('[ENI compare]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
