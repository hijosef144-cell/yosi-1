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
 *
 * Multi-select question: { multi: true, options: [..., { id, label, exclusive: true }] }. Its answer is an array of option ids
 * (an "exclusive" option such as "none of these" / "not sure" must be selected alone). A condition { q, in: [...] } on a multi
 * question is true when ANY selected option is in the list. A family can therefore match several tracks at once.
 * A rule with status "inactive" is kept as a draft and never fires.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KaspchemEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isAnswered(v) { return v != null && !(Array.isArray(v) && v.length === 0); }

  function check(cond, answers) {
    if (!cond) return true;
    if (cond.all) return cond.all.every(function (c) { return check(c, answers); });
    if (cond.any) return cond.any.some(function (c) { return check(c, answers); });
    if (cond.not) return !check(cond.not, answers);
    if (cond.q) {
      if (!Array.isArray(cond.in)) return false;
      var v = answers[cond.q];
      if (Array.isArray(v)) return v.some(function (x) { return cond.in.indexOf(x) !== -1; });
      return cond.in.indexOf(v) !== -1;
    }
    return false;
  }

  /** Questions the user will actually see, given answers so far (branching). */
  function visibleQuestions(cfg, answers) {
    return cfg.questions.filter(function (q) { return check(q.showIf, answers); });
  }

  /** The next unanswered visible question, or null when the flow is complete. */
  function nextQuestion(cfg, answers) {
    var v = visibleQuestions(cfg, answers);
    for (var i = 0; i < v.length; i++) if (!isAnswered(answers[v[i].id])) return v[i];
    return null;
  }

  function progress(cfg, answers) {
    var v = visibleQuestions(cfg, answers);
    var done = v.filter(function (q) { return isAnswered(answers[q.id]); }).length;
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
      var val = answers[keys[i]];
      if (q.multi) {
        if (!Array.isArray(val) || !val.length || val.length > q.options.length) return false;
        var seen = {};
        for (var k = 0; k < val.length; k++) {
          var opt = q.options.filter(function (o) { return o.id === val[k]; })[0];
          if (!opt || seen[val[k]]) return false;
          seen[val[k]] = true;
          if (opt.exclusive && val.length > 1) return false;
        }
      } else if (Array.isArray(val) || !q.options.some(function (o) { return o.id === val; })) return false;
    }
    return vis.every(function (q) { return isAnswered(answers[q.id]); });
  }

  /**
   * outcome:
   *  'found'        — at least one firm rule matched → "identified topics worth checking"
   *  'insufficient' — no firm rule matched, but a needs-info rule matched or at least one answer was "don't know" → not enough information
   *  'none'         — nothing matched and every answer was definite → no focused topic identified
   */
  function evaluate(cfg, answers, opts) {
    var includeInactive = !!(opts && opts.includeInactive);
    var findings = (cfg.rules || []).filter(function (r) { return (includeInactive || r.status !== 'inactive') && check(r.when, answers); })
      .map(function (r) {
        var f = r.finding || {};
        // `finding.topic` (set only by the quick check: the topic to open next) is carried through when present; for every other topic nothing is added.
        var o = { id: r.id, title: f.title, why: f.why, step: f.step, official: f.official, refer: f.refer, serviceTag: r.serviceTag,
          group: f.group, groupTitle: f.groupTitle, groupIntro: f.groupIntro, groupStep: f.groupStep, section: f.section };
        if (f.topic) o.topic = f.topic;
        // `finding.needsInfo` (set only by quick-check rules) marks a second tier: "not enough information, worth continuing to the full check". Never set on the ten topics.
        if (f.needsInfo) o.needsInfo = true;
        return o;
      });
    // Display cards: findings that share a `group` (e.g. the same benefit for different tax years) are shown as ONE card with a section each.
    // Matching stays per rule; `findings`/`count` are unchanged, `cards`/`cardCount` are what the result screen counts.
    // Needs-info findings (second tier) never count and never make the outcome 'found': `count`/`cardCount`/`cards` are the firm findings only; `infoCards` holds the
    // needs-info ones, grouped the same way, and leaves out a group that already has a firm card (the topic is already recommended). `findings` lists both, in rule order.
    function toCards(list) {
      var out = [], by = {};
      list.forEach(function (f) {
        if (!f.group) { out.push(f); return; }
        if (!by[f.group]) { by[f.group] = { group: f.group, title: f.groupTitle || f.title, intro: f.groupIntro, step: f.groupStep, official: f.official, refer: f.refer, parts: [] }; if (f.topic) by[f.group].topic = f.topic; out.push(by[f.group]); }
        by[f.group].parts.push(f);
      });
      return out;
    }
    var firm = findings.filter(function (f) { return !f.needsInfo; });
    var info = findings.filter(function (f) { return f.needsInfo; });
    var cards = toCards(firm);
    var firmGroups = {}; cards.forEach(function (c) { if (c.group) firmGroups[c.group] = true; });
    var infoCards = toCards(info).filter(function (c) { return !(c.group && firmGroups[c.group]); });
    var unknownIds = [];
    visibleQuestions(cfg, answers).forEach(function (q) {
      var picked = [].concat(answers[q.id]);
      var hit = q.options.some(function (o) { return picked.indexOf(o.id) !== -1 && o.unknown; });
      if (hit) unknownIds.push(q.id);
    });
    var outcome = firm.length ? 'found' : ((info.length || unknownIds.length) ? 'insufficient' : 'none');
    return { outcome: outcome, findings: findings, count: firm.length, cards: cards, cardCount: cards.length, infoCards: infoCards, infoCardCount: infoCards.length, unknown: unknownIds };
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
        if (q.multi && !q.options.some(function (o) { return o.exclusive; })) errs.push('שאלה ' + (i + 1) + ': בחירה מרובה דורשת תשובה בלעדית כמו "אף אחד מאלה"');
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

  /*
   * Question identity across topics.
   * Inside one topic a question id is local to that topic (this is what saved answers and every single-topic check use, and it never changes).
   * Two topics may legitimately use the same local id for DIFFERENT questions (e.g. `work`, `fees`, `events`). Whenever several topics are used
   * together (the quick and deep checks), a question is identified by topic id + local id, written `topic.id`; nothing is merged by name.
   */
  function qualifyId(topicId, id) { return String(topicId) + '.' + String(id); }

  function qualifyCond(cond, topicId) {
    if (!cond) return cond;
    if (cond.all) return { all: cond.all.map(function (c) { return qualifyCond(c, topicId); }) };
    if (cond.any) return { any: cond.any.map(function (c) { return qualifyCond(c, topicId); }) };
    if (cond.not) return { not: qualifyCond(cond.not, topicId) };
    if (cond.q) return { q: qualifyId(topicId, cond.q), in: cond.in };
    return cond;
  }

  /** The same topic with every question id and every reference to one rewritten to topic.id. Pure: the input is not modified. */
  function qualifyTopic(topic) {
    var tid = topic.id || topic.topic;
    if (!tid || String(tid).indexOf('.') !== -1) throw new Error('topic id missing or contains a dot: ' + tid);
    var copy = JSON.parse(JSON.stringify({ questions: topic.questions || [], rules: topic.rules || [] }));
    copy.questions.forEach(function (q) { q.localId = q.id; q.topicId = tid; q.id = qualifyId(tid, q.id); if (q.showIf) q.showIf = qualifyCond(q.showIf, tid); });
    copy.rules.forEach(function (r) { r.localId = r.id; r.topicId = tid; r.id = qualifyId(tid, r.id); if (r.when) r.when = qualifyCond(r.when, tid); });
    return { id: tid, topic: tid, title: topic.title || topic.name, questions: copy.questions, rules: copy.rules };
  }

  /** Several topics as one config. Ids are unique by construction; two topics with the same id are refused. */
  function composeTopics(topics) {
    var seen = {}, out = { topic: 'composed', title: 'composed', topics: [], questions: [], rules: [] };
    topics.forEach(function (t) {
      var tid = t.id || t.topic;
      if (seen[tid]) throw new Error('topic used twice: ' + tid);
      seen[tid] = true;
      var q = qualifyTopic(t);
      out.topics.push(tid);
      out.questions = out.questions.concat(q.questions);
      out.rules = out.rules.concat(q.rules);
    });
    return out;
  }

  /** Local question ids used by more than one topic, and whether the questions are the same (same wording and answers) or different. Report only. */
  function idCollisions(topics) {
    var by = {};
    topics.forEach(function (t) {
      (t.questions || []).forEach(function (q) {
        (by[q.id] = by[q.id] || []).push({ topic: t.id || t.topic, text: q.text, sig: JSON.stringify([q.text, !!q.multi, (q.options || []).map(function (o) { return [o.id, o.label]; })]) });
      });
    });
    return Object.keys(by).filter(function (id) { return by[id].length > 1; }).map(function (id) {
      var sigs = {}; by[id].forEach(function (x) { sigs[x.sig] = true; });
      return { id: id, topics: by[id].map(function (x) { return x.topic; }), same: Object.keys(sigs).length === 1, texts: by[id].map(function (x) { return x.text; }) };
    });
  }

  return {
    check: check, visibleQuestions: visibleQuestions, nextQuestion: nextQuestion, progress: progress,
    pruneAnswers: pruneAnswers, validateAnswers: validateAnswers, evaluate: evaluate, lint: lint,
    qualifyId: qualifyId, qualifyTopic: qualifyTopic, composeTopics: composeTopics, idCollisions: idCollisions
  };
});
