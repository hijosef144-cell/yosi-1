/*
 * Lint and path statistics for the deep check (stage 5). Build-time / test-time / server-side only: the browser does not load this file.
 * It uses only the public API of engine.js. Messages are Hebrew (they are shown to whoever edits the route).
 *
 *   lintDeep(route, topics, opts) → { errors, warnings, skipped, cfg, stats }
 *     (i)   minimal collection: every profile question, every derived question and every gated question is used by at least one active rule
 *     (ii)  every sensitive question has a "prefer not to answer" option, is optional in effect, is used by a rule, and no gate depends on it
 *     (iii) no id collision after qualification
 *     (iv)  every applied fact targets an existing question and an existing option, and yields a valid answer for every profile answer
 *     (v)   the number of visible questions on any path is measured (exact min / max, sampled distribution); the maximum may not exceed opts.maxPath (60)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.KaspchemEngineDeepLint = factory(root.KaspchemEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function arr(v) { return v == null ? [] : [].concat(v); }
  function byId(cfg) { var m = {}; cfg.questions.forEach(function (q) { m[q.id] = q; }); return m; }
  function opt(q, id) { for (var i = 0; i < q.options.length; i++) if (q.options[i].id === id) return q.options[i]; return null; }
  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /** All valid answers of a question (single = each option; multi = every non-empty subset, an exclusive option alone). */
  function allChoices(q) {
    if (!q.multi) return q.options.map(function (o) { return o.id; });
    var ex = q.options.filter(function (o) { return o.exclusive; }).map(function (o) { return [o.id]; });
    var free = q.options.filter(function (o) { return !o.exclusive; }).map(function (o) { return o.id; }), out = ex.slice();
    for (var m = 1; m < (1 << free.length); m++) out.push(free.filter(function (_, i) { return m & (1 << i); }));
    return out;
  }

  /* ---------- exact path bounds ---------- */
  // Only the answers that can change what is shown matter: options referenced by some showIf (gates included) or by a fact's map. Every other question is
  // collapsed to one representative answer. The recursion is memoised on the answers of the questions that matter.
  function referenced(cfg) {
    var refs = {};
    function add(qid, ids) { (refs[qid] = refs[qid] || {}); ids.forEach(function (i) { refs[qid][i] = true; }); }
    function walk(c) {
      if (!c) return;
      if (c.all) c.all.forEach(walk); else if (c.any) c.any.forEach(walk); else if (c.not) walk(c.not); else if (c.q) add(c.q, c.in || []);
    }
    cfg.questions.forEach(function (q) { walk(q.showIf); });
    (cfg.derive || []).forEach(function (d) { add(d.from, Object.keys(d.map)); });
    return refs;
  }
  function reducedChoices(q, refs) {
    var r = refs[q.id];
    if (!r) return [q.multi ? [q.options.filter(function (o) { return o.exclusive; }).concat(q.options)[0].id] : q.options[0].id];
    if (!q.multi) {
      var out = q.options.filter(function (o) { return r[o.id]; }).map(function (o) { return o.id; });
      var other = q.options.filter(function (o) { return !r[o.id]; })[0]; if (other) out.push(other.id);
      return out;
    }
    var free = q.options.filter(function (o) { return !o.exclusive && r[o.id]; }).map(function (o) { return o.id; }), out2 = [];
    for (var m = 1; m < (1 << free.length); m++) out2.push(free.filter(function (_, i) { return m & (1 << i); }));
    q.options.filter(function (o) { return o.exclusive && r[o.id]; }).forEach(function (o) { out2.push([o.id]); });
    var rep = q.options.filter(function (o) { return o.exclusive && !r[o.id]; })[0] || q.options.filter(function (o) { return !o.exclusive && !r[o.id]; })[0];
    if (rep) out2.push([rep.id]);
    return out2;
  }
  // Exact bounds, topic by topic: what a topic shows depends only on the profile answers (through gates and facts) and on its own answers. So the profile
  // answers are enumerated, and each topic is solved once per distinct "view" of the profile (memoised); a path is the profile plus the topics.
  function pathBounds(cfg) {
    var refs = referenced(cfg), qs = cfg.questions, prof = qs.filter(function (q) { return q.topicId === 'profile'; });
    var topicIds = []; qs.forEach(function (q) { if (q.topicId !== 'profile' && topicIds.indexOf(q.topicId) === -1) topicIds.push(q.topicId); });
    var topicQs = {}; topicIds.forEach(function (t) { topicQs[t] = qs.filter(function (q) { return q.topicId === t; }); });
    var profRefd = {}; // profile questions that some topic question looks at, directly (gates) or through a fact
    topicIds.forEach(function (t) { topicQs[t].forEach(function (q) { E.condQs(q.showIf, function (id) { if (id.indexOf('profile.') === 0) profRefd[id] = true; }); }); });
    var memoT = {};
    function topicBounds(t, P, der) {
      var tq = topicQs[t], view = {};
      Object.keys(profRefd).forEach(function (k) { if (k in P) view[k] = P[k]; });
      tq.forEach(function (q) { if (q.id in der) view[q.id] = der[q.id]; });
      var key = t + '|' + JSON.stringify(view);
      if (memoT[key]) return memoT[key];
      var idx = {}; tq.forEach(function (q, i) { idx[q.id] = i; });
      var rel = [];
      for (var i0 = tq.length - 1; i0 >= 0; i0--) { var set = {}; if (rel[i0 + 1]) Object.keys(rel[i0 + 1]).forEach(function (k) { set[k] = true; }); E.condQs(tq[i0].showIf, function (id) { set[id] = true; }); rel[i0] = set; }
      var relKeys = rel.map(function (st) { return Object.keys(st).sort(); }), memo = {};
      function f(i, ans) {
        if (i >= tq.length) return { min: 0, max: 0 };
        var k = i + '|' + relKeys[i].map(function (x) { return x in ans ? JSON.stringify(ans[x]) : '-'; }).join('');
        if (memo[k]) return memo[k];
        var q = tq[i], merged = Object.assign({}, P, der, ans), res;
        if (!E.check(q.showIf, merged) || (q.id in der)) res = f(i + 1, ans);
        else {
          var mn = Infinity, mx = -Infinity;
          reducedChoices(q, refs).forEach(function (c) { var o = {}; o[q.id] = c; var r = f(i + 1, Object.assign({}, ans, o)); if (r.min < mn) mn = r.min; if (r.max > mx) mx = r.max; });
          res = { min: 1 + mn, max: 1 + mx };
        }
        return (memo[k] = res);
      }
      return (memoT[key] = f(0, {}));
    }
    var best = { min: Infinity, max: -Infinity };
    (function walk(i, P) {
      if (i >= prof.length) {
        var der = E.deriveAnswers(cfg, P), n = Object.keys(P).length, mn = n, mx = n;
        topicIds.forEach(function (t) { var b = topicBounds(t, P, der); mn += b.min; mx += b.max; });
        if (mn < best.min) best.min = mn; if (mx > best.max) best.max = mx;
        return;
      }
      var q = prof[i];
      if (!E.check(q.showIf, P)) { walk(i + 1, P); return; }
      reducedChoices(q, refs).forEach(function (c) { var o = {}; o[q.id] = c; walk(i + 1, Object.assign({}, P, o)); });
    })(0, {});
    return best;
  }

  /* ---------- sampled paths ---------- */
  function pickAnswer(q, rand, p) {
    if (!q.multi) return q.options[Math.floor(rand() * q.options.length)].id;
    var chosen = q.options.filter(function (o) { return !o.exclusive && rand() < p; }).map(function (o) { return o.id; });
    if (chosen.length) return chosen;
    var ex = q.options.filter(function (o) { return o.exclusive; });
    if (ex.length) return [ex[Math.floor(rand() * ex.length)].id];
    return [q.options[Math.floor(rand() * q.options.length)].id];
  }
  /** One simulated visitor: answers every question that is asked. Returns { answers, asked } (asked = the questions shown, derived ones excluded). */
  function samplePath(cfg, rand, p) {
    var ans = {}, asked = 0, q;
    while ((q = E.deepNext(cfg, ans))) { ans[q.id] = pickAnswer(q, rand, p == null ? 0.3 : p); asked++; if (asked > 500) throw new Error('path does not terminate'); }
    return { answers: ans, asked: asked };
  }
  function samplePaths(cfg, n, seed, p) { var rand = rng(seed == null ? 20261103 : seed), out = []; for (var i = 0; i < n; i++) out.push(samplePath(cfg, rand, p)); return out; }
  function quantile(sorted, k) { return sorted[Math.min(sorted.length - 1, Math.floor(k * sorted.length))]; }
  /** Path length report: exact min/max over all possible answers, and the distribution over `n` simulated visitors (uniform single answers, each multi option with probability p). */
  function pathStats(cfg, n, seed, p) {
    var b = pathBounds(cfg), lens = samplePaths(cfg, n || 3000, seed, p).map(function (x) { return x.asked; }).sort(function (a, c) { return a - c; });
    var hist = {}; lens.forEach(function (l) { hist[l] = (hist[l] || 0) + 1; });
    var mean = lens.reduce(function (s, x) { return s + x; }, 0) / lens.length;
    return { exactMin: b.min, exactMax: b.max, samples: lens.length, min: lens[0], max: lens[lens.length - 1], mean: Math.round(mean * 10) / 10,
      p10: quantile(lens, 0.1), median: quantile(lens, 0.5), p90: quantile(lens, 0.9), histogram: hist };
  }

  /* ---------- lint ---------- */
  function lintDeep(route, topics, opts) {
    opts = opts || {};
    var errors = [], warnings = [], maxPath = opts.maxPath || 60;
    var cfg = E.buildDeep(route, topics), q = byId(cfg);
    var skipped = cfg.skipped.slice();

    // ---- the route itself (independent of the served topics) ----
    var pq = (route.profile && route.profile.questions) || [], pIds = {}, pById = {};
    pq.forEach(function (x, i) {
      if (!x.id) errors.push('שאלת פרופיל ' + (i + 1) + ' ללא מזהה'); else { if (pIds[x.id]) errors.push('מזהה שאלת פרופיל כפול: ' + x.id); pIds[x.id] = true; pById['profile.' + x.id] = x; }
      if (!x.text || !String(x.text).trim()) errors.push('שאלת פרופיל ' + x.id + ' ללא נוסח');
      if (!Array.isArray(x.options) || x.options.length < 2) errors.push('שאלת פרופיל ' + x.id + ' דורשת לפחות שתי תשובות');
      if (x.multi && !(x.options || []).some(function (o) { return o.exclusive; })) errors.push('שאלת פרופיל ' + x.id + ': בחירה מרובה דורשת תשובה בלעדית');
    });
    (route.facts || []).forEach(function (f) {
      var from = pById[f.from];
      if (!from) { errors.push('עובדה ' + f.id + ': מקור לא קיים ' + f.from); return; }
      Object.keys(f.map || {}).forEach(function (o) {
        if (!from.options.some(function (x) { return x.id === o; }) && !(o === 'pna')) errors.push('עובדה ' + f.id + ': תשובה לא קיימת בשאלת הפרופיל: ' + o);
      });
    });
    var fIds = {}; (route.facts || []).forEach(function (f) { if (fIds[f.id]) errors.push('מזהה עובדה כפול: ' + f.id); fIds[f.id] = true; });
    (route.gates || []).forEach(function (g) {
      E.condQs(g.show, function (id) { if (!pById[id]) errors.push('שער ' + g.id + ': מתייחס לשאלה לא קיימת ' + id); });
      if (!g.show) errors.push('שער ' + g.id + ' ללא תנאי');
    });

    // ---- (iii) ids after qualification ----
    var seen = {}; cfg.questions.forEach(function (x) { if (seen[x.id]) errors.push('התנגשות מזהה שאלה אחרי קידומת: ' + x.id); seen[x.id] = true; });
    var seenR = {}; cfg.rules.forEach(function (r) { if (seenR[r.id]) errors.push('התנגשות מזהה כלל אחרי קידומת: ' + r.id); seenR[r.id] = true; });
    // every question id inside a condition exists
    cfg.questions.forEach(function (x) { E.condQs(x.showIf, function (id) { if (!q[id]) errors.push('הסתעפות בשאלה ' + x.id + ' מתייחסת לשאלה לא קיימת ' + id); }); });
    cfg.rules.forEach(function (r) { E.condQs(r.when, function (id) { if (!q[id]) errors.push('כלל ' + r.id + ' מתייחס לשאלה לא קיימת ' + id); }); });

    // ---- (iv) facts ----
    cfg.derive.forEach(function (d) {
      var from = q[d.from];
      Object.keys(d.map).forEach(function (o) {
        Object.keys(d.map[o]).forEach(function (t) {
          if (!q[t]) { errors.push('עובדה ' + d.id + ': שאלת יעד לא קיימת ' + t); return; }
          arr(d.map[o][t]).forEach(function (v) { if (!opt(q[t], v)) errors.push('עובדה ' + d.id + ': תשובת יעד לא קיימת ' + v + ' בשאלה ' + t); });
        });
      });
      if (from && from.sensitive) {
        var pn = from.options.filter(function (o) { return o.pna; })[0];
        if (!pn || !d.map[pn.id]) errors.push('עובדה ' + d.id + ': שאלת המקור רגישה ו״מעדיפ/ה לא לענות״ אינה ממופה ליעד');
      }
      // exhaustive over the source question: every complete valid answer must give a valid target answer or none
      if (from) allChoices(from).forEach(function (c) {
        var a = {}; a[d.from] = c;
        var der = E.deriveAnswers(cfg, a);
        d.targets.forEach(function (t) {
          if (!(t in der)) return;
          var tq = q[t], v = der[t];
          if (tq.multi ? (!Array.isArray(v) || !v.length || (v.length > 1 && v.some(function (id) { return opt(tq, id).exclusive; }))) : !opt(tq, v)) errors.push('עובדה ' + d.id + ': ערך לא תקין ליעד ' + t + ' עבור ' + JSON.stringify(c));
        });
      });
      var unmapped = from ? from.options.filter(function (o) { return !(o.id in d.map); }).map(function (o) { return o.id; }) : [];
      if (unmapped.length) warnings.push('עובדה ' + d.id + ': תשובות שאינן ממופות (היעד יישאל כרגיל): ' + unmapped.join(', '));
    });

    // ---- (i) minimal collection ----
    var used = {};
    cfg.rules.forEach(function (r) { if (r.status !== 'inactive') E.condQs(r.when, function (id) { used[id] = true; }); });
    var changed = true;
    while (changed) {
      changed = false;
      cfg.questions.forEach(function (x) { if (used[x.id]) E.condQs(x.showIf, function (id) { if (!used[id]) { used[id] = true; changed = true; } }); });
      cfg.derive.forEach(function (d) { if (!used[d.from] && d.targets.some(function (t) { return used[t]; })) { used[d.from] = true; changed = true; } });
    }
    cfg.questions.forEach(function (x) {
      if (used[x.id]) return;
      if (x.topicId === 'profile') errors.push('שאלת פרופיל ' + x.id + ' אינה משמשת אף כלל פעיל (איסוף מינימלי)');
      else if (x.derivedBy) errors.push('שאלה נגזרת ' + x.id + ' אינה משמשת אף כלל פעיל');
      else if (x.gatedBy) errors.push('שאלה מסוננת ' + x.id + ' אינה משמשת אף כלל פעיל');
      else warnings.push('שאלה ' + x.id + ' של התחום עצמו אינה משמשת אף כלל פעיל');
    });

    // ---- (ii) sensitive ----
    var gateRefs = {}; (route.gates || []).forEach(function (g) { E.condQs(g.show, function (id) { gateRefs[id] = true; }); });
    cfg.questions.forEach(function (x) {
      if (!x.sensitive) return;
      var pn = x.options.filter(function (o) { return o.pna; })[0];
      if (!pn || !pn.unknown) errors.push('שאלה רגישה ' + x.id + ' ללא אפשרות ״מעדיפ/ה לא לענות״');
      else if (x.multi && !pn.exclusive) errors.push('שאלה רגישה ' + x.id + ': אפשרות ״מעדיפ/ה לא לענות״ חייבת להיות בלעדית');
      if (!x.sensitiveWhy || !String(x.sensitiveWhy).trim()) errors.push('שאלה רגישה ' + x.id + ' ללא משפט הסבר קצר');
      if (!used[x.id]) errors.push('שאלה רגישה ' + x.id + ' אינה משמשת אף כלל פעיל');
      if (gateRefs[x.id]) errors.push('שער מסתמך על שאלה רגישה ' + x.id);
      cfg.questions.forEach(function (y) { if (y.topicId === 'profile') E.condQs(y.showIf, function (id) { if (id === x.id) errors.push('שאלת פרופיל ' + y.id + ' תלויה בשאלה רגישה ' + x.id); }); });
    });
    // a weak rule never fires without its base rule's question set; a weak rule must say why it is weak
    (route.weak || []).forEach(function (w) { if (!w.note) warnings.push('כלל חלש ' + w.id + ' ללא הערה'); });

    // ---- (v) path length ----
    var stats = null;
    if (!opts.noStats) {
      stats = pathStats(cfg, opts.samples || 3000, opts.seed);
      if (stats.exactMax > maxPath) errors.push('אורך מסלול מרבי ' + stats.exactMax + ' חורג מ־' + maxPath + ' שאלות');
    }
    return { errors: errors, warnings: warnings, skipped: skipped, cfg: cfg, stats: stats, used: used };
  }

  return { lintDeep: lintDeep, pathBounds: pathBounds, pathStats: pathStats, samplePath: samplePath, samplePaths: samplePaths, allChoices: allChoices, rng: rng };
});
