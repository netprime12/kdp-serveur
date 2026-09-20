// ============================================================
// ari.js — Amazon Review Intelligence · ARI by Éclozia v2.0
// Monter dans server.js : app.use('/ari', require('./ari'))
// Même pattern que eni.js — license.js + aiprovider.generate
// ============================================================

const express = require('express');
const router  = express.Router();

// ── Cache mémoire 1h ──────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
async function cacheGet(k) {
  const st = getStore();
  if (st.redisGet) { try { const v = await st.redisGet('ari:'+k); return v ? JSON.parse(v) : null; } catch(e) {} }
  const e = _cache.get(k); if (!e || Date.now()-e.ts > CACHE_TTL) { _cache.delete(k); return null; } return e.data;
}
async function cacheSet(k, d) {
  const st = getStore();
  if (st.redisSet) { try { await st.redisSet('ari:'+k, JSON.stringify(d), 3600); return; } catch(e) {} }
  _cache.set(k, { data: d, ts: Date.now() });
}
let _store = null;
function getStore() { if (!_store) { try { _store = require('./store'); } catch(e) { _store = {}; } } return _store; }

// ── JSON parsing robuste ──────────────────────────────────────
function safeParseAI(raw) {
  if (!raw || typeof raw !== 'string') return raw || {};
  var s = raw.trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/,'').trim();
  var start = Math.min(s.indexOf('{')>=0?s.indexOf('{'):9999, s.indexOf('[')>=0?s.indexOf('['):9999);
  if (start===9999) return {};
  s = s.slice(start);
  var end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (end>=0) s = s.slice(0, end+1);
  try { return JSON.parse(s); } catch(e) { try { return JSON.parse(s.replace(/,\s*([\]}])/g,'$1')); } catch(e2) { return {}; } }
}

// ── Taxonomie des 12 thèmes ───────────────────────────────────
const THEMES = ['quality','durability','size','packaging','delivery','instructions','value','support','safety','compatibility','aesthetics','performance'];
const THEME_LABELS = {
  en:{ quality:'Material quality', durability:'Durability', size:'Size & fit', packaging:'Packaging', delivery:'Delivery', instructions:'Instructions / setup', value:'Value for money', support:'Customer support', safety:'Safety', compatibility:'Compatibility', aesthetics:'Appearance', performance:'Overall performance' },
  fr:{ quality:'Qualité matériau', durability:'Durabilité', size:'Taille & dimensions', packaging:'Emballage', delivery:'Livraison', instructions:'Notice / installation', value:'Rapport qualité-prix', support:'Service client', safety:'Sécurité', compatibility:'Compatibilité', aesthetics:'Esthétique', performance:'Fonctionnement général' },
  es:{ quality:'Calidad del material', durability:'Durabilidad', size:'Tamaño y ajuste', packaging:'Embalaje', delivery:'Entrega', instructions:'Instrucciones', value:'Relación calidad-precio', support:'Servicio al cliente', safety:'Seguridad', compatibility:'Compatibilidad', aesthetics:'Estética', performance:'Rendimiento general' },
  de:{ quality:'Materialqualität', durability:'Haltbarkeit', size:'Größe & Passform', packaging:'Verpackung', delivery:'Lieferung', instructions:'Anleitung', value:'Preis-Leistungs-Verhältnis', support:'Kundendienst', safety:'Sicherheit', compatibility:'Kompatibilität', aesthetics:'Ästhetik', performance:'Allgemeine Leistung' },
  pt:{ quality:'Qualidade do material', durability:'Durabilidade', size:'Tamanho e ajuste', packaging:'Embalagem', delivery:'Entrega', instructions:'Instruções', value:'Custo-benefício', support:'Suporte ao cliente', safety:'Segurança', compatibility:'Compatibilidade', aesthetics:'Estética', performance:'Desempenho geral' },
};

// ── Validation résultats ──────────────────────────────────────
function validateARI(r, lang) {
  if (!r || typeof r !== 'object') r = {};
  if (!Array.isArray(r.weaknesses) || r.weaknesses.length < 2)
    r.weaknesses = [{ theme:'performance', frequency_pct:30, severity:2, summary:'General performance issues noted by customers', improvement:'Improve core product functionality' }];
  if (!Array.isArray(r.strengths) || r.strengths.length < 1)
    r.strengths = [{ theme:'value', frequency_pct:40, summary:'Customers find good value for the price' }];
  if (!Array.isArray(r.feature_requests)) r.feature_requests = [];
  if (!r.return_risk) r.return_risk = { score: 20, main_triggers: [], summary: 'Low return risk detected' };
  if (!r.voice_mining) r.voice_mining = { top_benefits: [], bullets: [] };
  if (!Array.isArray(r.voice_mining.bullets) || r.voice_mining.bullets.length < 3)
    r.voice_mining.bullets = ['Quality product at a competitive price', 'Customers appreciate fast delivery', 'Easy to use and set up'];
  if (!Array.isArray(r.product_brief) || r.product_brief.length < 2)
    r.product_brief = [{ problem:'Performance could be improved', requirement:'Enhance core functionality', priority:'Should', evidence_theme:'performance', frequency_pct:30 }];
  if (!r.theme_breakdown) r.theme_breakdown = {};
  if (!r.listing_title_suggestion) r.listing_title_suggestion = '';
  return r;
}

// ── Score qualité données ─────────────────────────────────────
function computeQuality(reviews, total) {
  if (!reviews.length) return 0;
  const withText = reviews.filter(r => (r.text||'').split(' ').length >= 15).length;
  return Math.round((withText/Math.max(total,1)*0.6 + Math.min(reviews.length/200,1)*0.4)*100);
}

// ── Score opportunité ─────────────────────────────────────────
function computeOpportunity(ai, qualityScore) {
  const weaknesses = ai.weaknesses || [];
  const features   = ai.feature_requests || [];
  const returnRisk = ai.return_risk || {};
  const sevScore   = weaknesses.reduce((s,w)=>s+((w.severity||1)/4)*((w.frequency_pct||0)/100),0)/Math.max(weaknesses.length,1);
  const sigW       = weaknesses.filter(w=>(w.severity||1)>=2);
  const freqScore  = sigW.length>0 ? sigW.reduce((s,w)=>s+(w.frequency_pct||0),0)/sigW.length/100 : 0;
  const demandScore= features.filter(f=>(f.frequency_pct||0)>10).length/Math.max(features.length,1);
  const raw        = sevScore*0.30 + freqScore*0.25 + 0.5*0.20*0.5 + demandScore*0.15 + 0.7*0.10;
  return Math.round(raw*100*(qualityScore/100));
}

// ── Prompt IA ─────────────────────────────────────────────────
function buildPrompt(reviews, productName, lang, themeLabels) {
  const sample   = reviews.length > 2000 ? reviews.slice(0,2000) : reviews;
  const avgRating= (sample.reduce((s,r)=>s+(r.rating||3),0)/sample.length).toFixed(1);
  const revText  = sample.slice(0,80).map(r=>`[★${r.rating||'?'}] ${(r.text||'').substring(0,300)}`).join('\n');
  const themeList= THEMES.map(k=>`"${k}":"${themeLabels[k]}"`).join(', ');
  return `You are an expert Amazon product analyst. Analyze these customer reviews for "${productName}" and return a structured JSON report in "${lang}" language.

REVIEWS (${sample.length} samples, avg rating ${avgRating}):
${revText}

THEME KEYS — use exactly these: {${themeList}}

Return ONLY valid JSON (no markdown):
{
  "weaknesses": [{"theme":"<key>","frequency_pct":<0-100>,"severity":<1-4>,"summary":"<1 sentence in ${lang}>","improvement":"<actionable fix in ${lang}>"}],
  "strengths": [{"theme":"<key>","frequency_pct":<0-100>,"summary":"<1 sentence in ${lang}>"}],
  "feature_requests": [{"request":"<what customers want in ${lang}>","frequency_pct":<0-100>,"type":"explicit|implicit"}],
  "return_risk": {"score":<0-100>,"main_triggers":["<theme_key>"],"summary":"<1 sentence in ${lang}>"},
  "voice_mining": {"top_benefits":["<benefit phrase in ${lang}>"],"bullets":["<marketing bullet 1 in ${lang}>","<bullet 2>","<bullet 3>","<bullet 4>","<bullet 5>"]},
  "product_brief": [{"problem":"<observed problem in ${lang}>","requirement":"<proposed fix in ${lang}>","priority":"Must|Should|Could","evidence_theme":"<theme_key>","frequency_pct":<0-100>}],
  "theme_breakdown": {"<theme_key>":{"mentions":<count>,"sentiment":"positive|negative|neutral|mixed","severity":<1-4 or null>}},
  "listing_title_suggestion": "<optimized Amazon title under 200 chars using top keywords>"
}

Rules:
- All text in "${lang}" (except theme keys and priority values)
- severity: 1=minor, 2=noticeable, 3=significant, 4=critical/safety
- Minimum 3 weaknesses, 2 strengths, 2 feature_requests, 3 product_brief items
- 5 marketing bullets — original copy based on observed benefits, NOT copied from reviews
- listing_title_suggestion: keyword-rich Amazon title`;
}

// ── Ping ──────────────────────────────────────────────────────
router.get('/ping', function(req, res) {
  res.json({ ok: true, version: '2.0', product: 'ARI by Éclozia', cacheSize: _cache.size });
});

// ── POST /ari/analyse ─────────────────────────────────────────
router.post('/analyse', async function(req, res) {
  try {
    var body       = req.body || {};
    var license    = body.licenseKey || body.license || '';
    var deviceId   = body.deviceId  || '';
    var rawReviews = body.reviews   || [];
    var productName= body.productName || 'Product';
    var lang       = body.lang      || 'en';
    var projectId  = body.projectId || null;

    if (!Array.isArray(rawReviews) || rawReviews.length < 3)
      return res.status(400).json({ ok:false, error:'insufficient_reviews', message:'Need at least 3 reviews' });

    // --- Licence ---
    var checkLicense = require('./license').checkLicense;
    var store        = require('./store');
    var generate     = require('./aiprovider').generate;
    var planLimits   = require('./license').planLimits;

    var info = await checkLicense(license);
    if (info.kind === 'error')
      return res.status(503).json({ ok:false, error:'verification_indisponible', message:'License verification unavailable. Try again.' });
    if (info.kind === 'invalid')
      return res.status(402).json({ ok:false, error:'abonnement_inactif', message:'Invalid or expired key. Subscribe or buy credits.' });
    if (info.kind === 'credits' && store.grantCreditsOnce)
      await store.grantCreditsOnce(license, info.creditGrant);
    if (info.kind === 'none' && !deviceId)
      return res.status(400).json({ ok:false, error:'deviceId_required' });

    var limits = planLimits ? planLimits() : { trial: 3 };
    var available = 0, bucketPlan = 'trial';
    if (info.kind === 'dev') {
      available = 9999; bucketPlan = 'dev';
    } else if (info.kind === 'subscription') {
      var u1 = await store.getMonthly('lic:'+license);
      var c1 = await store.getCredits(license);
      available = Math.max(0, info.limit-u1)+c1; bucketPlan = 'abo';
    } else if (info.kind === 'credits') {
      available = await store.getCredits(license); bucketPlan = 'credits';
    } else {
      var u2 = await store.getTrial(deviceId);
      available = Math.max(0, (limits.trial||3)-u2);
    }
    if (available <= 0)
      return res.status(402).json({ ok:false, error:'quota_atteint',
        message: bucketPlan==='trial' ? 'Free trial exhausted. Subscribe or buy credits.' : 'Quota reached. Resets next month, or buy credits.' });

    // --- Normaliser les avis ---
    var reviews = rawReviews.map(function(r) {
      return {
        text:   String(r.text||r.body||r.review||r.content||'').trim(),
        rating: parseInt(r.rating||r.stars||r.note||r.star_rating||0,10)||null,
        date:   r.date||r.review_date||null,
        asin:   r.asin||r.variant||null,
      };
    }).filter(function(r){ return r.text.length > 0; });

    if (reviews.length < 3)
      return res.status(400).json({ ok:false, error:'insufficient_text', message:'Not enough reviews with text' });

    // --- Cache ---
    var ck = (productName+':'+lang+':'+reviews.length).replace(/\s+/g,'_').slice(0,60);
    var cached = await cacheGet(ck);
    if (cached) return res.json(Object.assign({}, cached, { fromCache:true }));

    // --- Qualité ---
    var withText     = reviews.filter(function(r){ return (r.text||'').split(' ').length >= 15; });
    var qualityScore = computeQuality(withText.length ? withText : reviews, rawReviews.length);
    var confidence   = qualityScore>=70?'high':qualityScore>=40?'medium':'low';
    var warnings     = [];
    if (withText.length < 30) warnings.push({ code:'low_volume', message:'Less than 30 usable reviews — confidence reduced' });
    if (qualityScore < 40)    warnings.push({ code:'low_quality', message:'Many reviews are very short' });

    var themeLabels = THEME_LABELS[lang] || THEME_LABELS['en'];

    // --- IA ---
    var prompt = buildPrompt(withText.length ? withText : reviews, productName, lang, themeLabels);
    var aiResult = {};
    try {
      var raw = await generate(prompt);
      aiResult = validateARI(safeParseAI(raw), lang);
    } catch(e) {
      console.error('[ARI] AI error:', e.message);
      return res.status(500).json({ ok:false, error:'ai_error', message:'AI analysis failed' });
    }

    var opportunityScore = computeOpportunity(aiResult, qualityScore);

    // --- Débit ---
    if (info.kind === 'dev') {
      if (store.incrementMonthly) await store.incrementMonthly('dev');
    } else if (info.kind === 'subscription') {
      var idL='lic:'+license, uL=await store.getMonthly(idL);
      if (uL<info.limit) await store.incrementMonthly(idL);
      else if (store.consumeCredit) await store.consumeCredit(license);
    } else if (info.kind === 'credits') {
      if (store.consumeCredit) await store.consumeCredit(license);
    } else {
      await store.incrementTrial(deviceId);
    }

    var restant = null;
    if (info.kind === 'subscription') {
      var uR=await store.getMonthly('lic:'+license);
      restant = Math.max(0,info.limit-uR)+(await store.getCredits(license));
    } else if (info.kind === 'credits') {
      restant = await store.getCredits(license);
    } else if (info.kind === 'none') {
      var uT=await store.getTrial(deviceId);
      restant = Math.max(0,(limits.trial||3)-uT);
    }

    var result = {
      ok: true,
      productName, lang,
      meta: {
        reviewsTotal:    rawReviews.length,
        reviewsAnalyzed: reviews.length,
        qualityScore, confidence, warnings, themeLabels,
        generatedAt: new Date().toISOString(),
      },
      scores: {
        opportunity: opportunityScore,
        returnRisk:  aiResult.return_risk?.score || 0,
        dataQuality: qualityScore,
      },
      reports: {
        weaknesses:      aiResult.weaknesses      || [],
        strengths:       aiResult.strengths       || [],
        featureRequests: aiResult.feature_requests|| [],
        returnRisk:      aiResult.return_risk     || {},
        voiceMining:     aiResult.voice_mining    || {},
        productBrief:    aiResult.product_brief   || [],
        themeBreakdown:  aiResult.theme_breakdown || {},
        listingTitle:    aiResult.listing_title_suggestion || '',
      },
      restant,
    };

    await cacheSet(ck, result);
    return res.json(result);

  } catch(err) {
    console.error('[ARI]', err);
    return res.status(500).json({ ok:false, error:'server_error', message:err.message });
  }
});

// ── POST /ari/compare ─────────────────────────────────────────
router.post('/compare', async function(req, res) {
  try {
    var body     = req.body || {};
    var projects = body.projects || [];
    var lang     = body.lang || 'en';
    if (projects.length < 2 || projects.length > 3)
      return res.status(400).json({ ok:false, error:'invalid_projects', message:'Provide 2 or 3 projects' });

    var generate = require('./aiprovider').generate;
    var themeLabels = THEME_LABELS[lang] || THEME_LABELS['en'];

    // Matrice thèmes × produits
    var matrix = {};
    THEMES.forEach(function(theme) {
      matrix[theme] = projects.map(function(p,i) {
        var tb = (p.reports?.themeBreakdown||{})[theme]||{};
        return { productIndex:i, productName:p.productName||('Product '+(i+1)), sentiment:tb.sentiment||'neutral', mentions:tb.mentions||0, severity:tb.severity||null };
      });
    });
    var commonWeaknesses = THEMES.filter(function(t){
      return matrix[t].every(function(p){ return ['negative','mixed'].includes(p.sentiment); });
    });

    var ctx = projects.map(function(p,i){
      return 'Product '+(i+1)+': "'+p.productName+'"\n- Opportunity: '+(p.scores?.opportunity||0)+'/100\n- Return risk: '+(p.scores?.returnRisk||0)+'\n- Top weaknesses: '+(p.reports?.weaknesses||[]).slice(0,3).map(function(w){return themeLabels[w.theme]||w.theme;}).join(', ');
    }).join('\n\n');

    var prompt = 'Compare these '+projects.length+' Amazon products based on customer review analysis. Respond in "'+lang+'".\n\n'+ctx+'\n\nCommon weaknesses (opportunity for a better product): '+(commonWeaknesses.map(function(t){return themeLabels[t]||t;}).join(', ')||'None')+'\n\nReturn ONLY valid JSON:\n{"gap_opportunity":"<main market gap in '+lang+', 2 sentences>","differentiation_angles":["<angle 1 in '+lang+'>","<angle 2>","<angle 3>"],"recommended_focus":"<which product has best improvement opportunity and why, in '+lang+'>","action_plan":"<concrete next steps for the seller, 2 sentences in '+lang+'>" }';

    var gapAnalysis = {};
    try { var rr = await generate(prompt); gapAnalysis = safeParseAI(rr); } catch(e) { console.error('[ARI compare]', e.message); }

    return res.json({
      ok:true, lang, themeLabels, matrix, commonWeaknesses, gapAnalysis,
      products: projects.map(function(p){ return { name:p.productName, scores:p.scores, reviewsAnalyzed:p.meta?.reviewsAnalyzed }; }),
    });
  } catch(err) {
    console.error('[ARI compare]', err);
    return res.status(500).json({ ok:false, error:err.message });
  }
});

module.exports = router;
