/*
 * Kaspchem rules engine — deterministic, transparent, no AI.
 * Runs in the browser (for the live result) and on the server (authoritative re-evaluation on submit).
 *
 * Config shape (one per topic):
 * {
 *   topic, title, questions: [{ id, text, help?, encourage?, showIf?, options: [{ id, label, unknown? }] }],
 *   rules:  [{ id, when, finding: { title, why } }]
 * }
 * Condition: { q, in: [optionIds] } | { all: [cond] } | { any: [cond] } | { not: cond }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KaspchemEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function check(cond, answers) {
    if (!cond) return true;
    if (cond.all) return cond.all.every(function (c) { return check(c, answers); });
    if (cond.any) return cond.any.some(function (c) { return check(c, answers); });
    if (cond.not) return !check(cond.not, answers);
    if (cond.q) return Array.isArray(cond.in) && cond.in.indexOf(answers[cond.q]) !== -1;
    return false;
  }

  /** Questions the user will actually see, given answers so far (branching). */
  function visibleQuestions(cfg, answers) {
    return cfg.questions.filter(function (q) { return check(q.showIf, answers); });
  }

  /** The next unanswered visible question, or null when the flow is complete. */
  function nextQuestion(cfg, answers) {
    var v = visibleQuestions(cfg, answers);
    for (var i = 0; i < v.length; i++) if (answers[v[i].id] == null) return v[i];
    return null;
  }

  function progress(cfg, answers) {
    var v = visibleQuestions(cfg, answers);
    var done = v.filter(function (q) { return answers[q.id] != null; }).length;
    return { done: done, total: v.length };
  }

  /** Drop answers to questions that are no longer visible (after the user goes back and changes a branch). */
  function pruneAnswers(cfg, answers) {
    var out = {};
    var changed = true;
    var cur = Object.assign({}, answers);
    while (changed) {
      changed = false;
      var vis = {};
      visibleQuestions(cfg, cur).forEach(function (q) { vis[q.id] = true; });
      Object.keys(cur).forEach(function (k) { if (!vis[k]) { delete cur[k]; changed = true; } });
    }
    Object.keys(cur).forEach(function (k) { out[k] = cur[k]; });
    return out;
  }

  /** Only accept answers that exist as options of visible questions. */
  function validateAnswers(cfg, answers) {
    if (!answers || typeof answers !== 'object') return false;
    var vis = visibleQuestions(cfg, answers);
    var visIds = {};
    vis.forEach(function (q) { visIds[q.id] = q; });
    var keys = Object.keys(answers);
    for (var i = 0; i < keys.length; i++) {
      var q = visIds[keys[i]];
      if (!q) return false;
      if (!q.options.some(function (o) { return o.id === answers[keys[i]]; })) return false;
    }
    return vis.every(function (q) { return answers[q.id] != null; });
  }

  /**
   * outcome:
   *  'found'        — at least one rule matched → "identified topics worth checking"
   *  'insufficient' — nothing matched, but at least one answer was "don't know" → not enough information
   *  'none'         — nothing matched and every answer was definite → no focused topic identified
   */
  function evaluate(cfg, answers) {
    var findings = (cfg.rules || []).filter(function (r) { return check(r.when, answers); })
      .map(function (r) { return { id: r.id, title: r.finding.title, why: r.finding.why }; });
    var unknownIds = [];
    visibleQuestions(cfg, answers).forEach(function (q) {
      var opt = q.options.filter(function (o) { return o.id === answers[q.id]; })[0];
      if (opt && opt.unknown) unknownIds.push(q.id);
    });
    var outcome = findings.length ? 'found' : (unknownIds.length ? 'insufficient' : 'none');
    return { outcome: outcome, findings: findings, count: findings.length, unknown: unknownIds };
  }

  /** Static sanity checks for a config — used by the admin before publishing. Returns array of Hebrew error strings. */
  function lint(cfg) {
    var errs = [];
    if (!cfg || !Array.isArray(cfg.questions) || !cfg.questions.length) return ['אין שאלות בשאלון'];
    var ids = {};
    cfg.questions.forEach(function (q, i) {
      if (!q.id) errs.push('שאלה ' + (i + 1) + ' ללא מזהה');
      if (ids[q.id]) errs.push('מזהה שאלה כפול: ' + q.id);
      ids[q.id] = q;
      if (!q.text || !String(q.text).trim()) errs.push('שאלה ' + (i + 1) + ' ללא נוסח');
      if (!Array.isArray(q.options) || q.options.length < 2) errs.push('שאלה ' + (i + 1) + ' דורשת לפחות שתי תשובות');
      else {
        var oi = {};
        q.options.forEach(function (o) {
          if (!o.id || !o.label) errs.push('שאלה ' + (i + 1) + ': תשובה ללא מזהה או נוסח');
          if (oi[o.id]) errs.push('שאלה ' + (i + 1) + ': מזהה תשובה כפול ' + o.id);
          oi[o.id] = true;
        });
      }
    });
    function refs(cond, where) {
      if (!cond) return;
      if (cond.all) cond.all.forEach(function (c) { refs(c, where); });
      else if (cond.any) cond.any.forEach(function (c) { refs(c, where); });
      else if (cond.not) refs(cond.not, where);
      else if (cond.q) {
        var q = ids[cond.q];
        if (!q) errs.push(where + ': מתייחס לשאלה לא קיימת ' + cond.q);
        else (cond.in || []).forEach(function (a) {
          if (!q.options.some(function (o) { return o.id === a; })) errs.push(where + ': תשובה לא קיימת ' + a + ' בשאלה ' + cond.q);
        });
      }
    }
    cfg.questions.forEach(function (q, i) {
      refs(q.showIf, 'הסתעפות בשאלה ' + (i + 1));
      if (q.showIf && JSON.stringify(q.showIf).indexOf('"q":"' + q.id + '"') !== -1) errs.push('שאלה ' + (i + 1) + ' תלויה בעצמה');
    });
    (cfg.rules || []).forEach(function (r, i) {
      refs(r.when, 'כלל ' + (i + 1));
      if (!r.finding || !r.finding.title) errs.push('כלל ' + (i + 1) + ' ללא כותרת ממצא');
      if (!r.finding || !r.finding.why) errs.push('כלל ' + (i + 1) + ' ללא הסבר');
    });
    return errs;
  }

  return {
    check: check, visibleQuestions: visibleQuestions, nextQuestion: nextQuestion, progress: progress,
    pruneAnswers: pruneAnswers, validateAnswers: validateAnswers, evaluate: evaluate, lint: lint
  };
});
