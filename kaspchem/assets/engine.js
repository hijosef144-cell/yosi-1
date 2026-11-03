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

  /*DEEP-START*/
  /* =====================================================================================================================
   * Stage 5: the deep check. ADDITIVE ONLY: nothing above this line is changed, and none of the functions above calls anything below.
   * The deep check is the same rules engine over a COMPOSED config (several topics + a short shared profile), with:
   *   - profile  : questions asked once, in their own namespace (`profile.<id>`);
   *   - facts    : explicit declarations "this profile answer IS that answer of a topic question" (never by name similarity); such a topic question
   *                is pre-filled and not asked again;
   *   - gates    : a condition on profile answers under which a topic (or single questions) is shown at all;
   *   - tune     : display-only extras (option `group`, option `hint`) and `sensitive` questions (they get a "prefer not to answer" option);
   *   - weak     : rules authored with `weak: true` (the only source of the "low" tier), each reusing the finding of an existing rule.
   * Evaluation is THREE-VALUED (Kleene): a condition is true, false or unknown. An unanswered question, an `unknown: true` option and "prefer not to
   * answer" are unknown. Tiers: HIGH = the rule is true; MISSING = not false, but depends on an unknown answer (the questions are named); LOW = a
   * weak rule that is true. A false rule yields nothing. Whenever every relevant answer is known this agrees exactly with `evaluate` of each topic.
   * ===================================================================================================================== */
  var PNA_ID = 'pna', PNA_LABEL = 'מעדיפ/ה לא לענות';

  function dClone(o) { return JSON.parse(JSON.stringify(o)); }
  function dArr(v) { return v == null ? [] : [].concat(v); }
  function dUniq(a) { var s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = true; o.push(x); } }); return o; }
  function dById(cfg) { var m = {}; (cfg.questions || []).forEach(function (q) { m[q.id] = q; }); return m; }
  function dOpt(q, id) { for (var i = 0; i < q.options.length; i++) if (q.options[i].id === id) return q.options[i]; return null; }

  /* ---------- composing ---------- */

  // A guard entry is "topic.question", "topic.question#option" (the option must exist) or the same with a leading "!" (must NOT exist).
  function guardOk(byId, g) {
    var neg = g.charAt(0) === '!'; if (neg) g = g.slice(1);
    var p = g.split('#'), q = byId[p[0]], ok = !!q && (p.length < 2 || !!dOpt(q, p[1]));
    return neg ? !ok : ok;
  }
  function guardsOk(byId, list) { return (list || []).every(function (g) { return guardOk(byId, g); }); }

  /**
   * route (the `deep` route: profile, facts, gates, tune, weak) + the served topics (an array; routes among them are ignored) → one config.
   * Whatever the route declares about a topic, question or option that the served content does not have is SKIPPED (listed in `skipped`, never an error):
   * the same route works against the ten published topics and against a newer content set.
   */
  function buildDeep(route, topics, opts) {
    opts = opts || {};
    var served = {};
    (topics || []).forEach(function (t) { if (t && t.questions && t.kind !== 'router' && t.kind !== 'deep') served[t.id || t.topic] = t; });
    var included = (route.topics || []).filter(function (id) { return served[id]; });
    var cfg = { id: route.id || 'deep', topic: route.id || 'deep', kind: 'deep', title: route.name, name: route.name, icon: route.icon, intro: route.intro, messages: route.messages || {},
      phases: route.phases || [], topics: included, questions: [], rules: [], derive: [], gates: [], personGroups: [], subjects: {}, skipped: [], profileIds: [], unavailable: false, requiresMissing: [] };
    var parts = [qualifyTopic({ id: 'profile', name: 'profile', questions: (route.profile && route.profile.questions) || [], rules: [] })];
    included.forEach(function (id) { parts.push(qualifyTopic(served[id])); });
    parts.forEach(function (p) { cfg.questions = cfg.questions.concat(p.questions); cfg.rules = cfg.rules.concat(p.rules); });
    var byId = dById(cfg);
    cfg.questions.forEach(function (q) { q.phase = q.topicId === 'profile' ? 'profile' : 'topics'; if (q.topicId === 'profile') cfg.profileIds.push(q.id); });

    // tune: sensitive questions and display extras
    var tune = route.tune || {};
    Object.keys(tune).forEach(function (qid) {
      var q = byId[qid], t = tune[qid];
      if (!q || !guardsOk(byId, t.needs)) { cfg.skipped.push({ kind: 'tune', id: qid, reason: 'question-missing' }); return; }
      if (t.sensitive) {
        q.sensitive = true; q.sensitiveWhy = typeof t.sensitive === 'string' ? t.sensitive : (t.sensitive.why || '');
        if (!q.options.some(function (o) { return o.pna; })) q.options.push({ id: PNA_ID, label: PNA_LABEL, unknown: true, pna: true, exclusive: !!q.multi });
      }
      ['groups:group', 'hints:hint'].forEach(function (pair) {
        var key = pair.split(':')[0], field = pair.split(':')[1];
        Object.keys(t[key] || {}).forEach(function (oid) {
          var o = dOpt(q, oid); if (!o) { cfg.skipped.push({ kind: 'tune', id: qid + '#' + oid, reason: 'option-missing' }); return; }
          o[field] = t[key][oid];
        });
      });
    });

    // persons: per-person copies of questions and rules (see expandPersons). Done before the gates: a copy is about someone else and is not gated by the respondent's own status.
    cfg.unverified = (route.unverified || []).slice(); cfg.approved = route.approved === true;
    expandPersons(cfg, route);
    byId = dById(cfg);

    // gates: a topic (or single questions) is shown only when a condition on profile answers holds
    (route.gates || []).forEach(function (g) {
      var targets = [];
      if (g.topic) cfg.questions.forEach(function (q) { if (q.topicId === g.topic && !q.noGate) targets.push(q); });
      (g.questions || []).forEach(function (qid) { if (byId[qid] && !byId[qid].noGate && targets.indexOf(byId[qid]) === -1) targets.push(byId[qid]); });
      if (!targets.length || !guardsOk(byId, g.needs)) { cfg.skipped.push({ kind: 'gate', id: g.id, reason: 'no-target' }); return; }
      targets.forEach(function (q) { var s = dClone(g.show); q.showIf = q.showIf ? { all: [s, q.showIf] } : s; (q.gatedBy = q.gatedBy || []).push(g.id); });
      cfg.gates.push({ id: g.id, targets: targets.map(function (q) { return q.id; }), show: g.show, why: g.why });
    });

    // requires: the content the route was written for. A topic id, or a shape guard ("topic.question#option"). If any is missing the check is NOT AVAILABLE: it is never run in a
    // degraded form in production (the only degraded mode is a test-only one: the test server serves the route without `requires`). opts.ignoreRequires is for reading old requests.
    (route.requires || []).forEach(function (r) {
      var ok = r.indexOf('.') === -1 ? !!served[r] : guardOk(byId, r);
      if (!ok) cfg.requiresMissing.push(r);
    });
    if (cfg.requiresMissing.length && !opts.ignoreRequires) cfg.unavailable = true;

    // facts: profile answer → equivalent answer(s) of topic questions. Applies only when every target question exists and the guards hold.
    (route.facts || []).forEach(function (f) {
      var targets = {}; Object.keys(f.map || {}).forEach(function (o) { Object.keys(f.map[o]).forEach(function (t) { targets[t] = true; }); });
      var tIds = Object.keys(targets);
      if (!byId[f.from] || !guardsOk(byId, f.needs) || !tIds.length || !tIds.every(function (t) { return byId[t]; })) { cfg.skipped.push({ kind: 'fact', id: f.id, reason: 'target-missing' }); return; }
      cfg.derive.push({ id: f.id, from: f.from, map: dClone(f.map), targets: tIds });
      tIds.forEach(function (t) { (byId[t].derivedBy = byId[t].derivedBy || []).push(f.id); });
    });

    // weak rules: a looser trigger for the finding of an existing rule. Only these can land in the low tier.
    var rulesById = {}; cfg.rules.forEach(function (r) { rulesById[r.id] = r; });
    (route.weak || []).forEach(function (w) {
      var base = rulesById[w.like];
      if (!base || !guardsOk(byId, w.needs) || !condRefsExist(w.when, byId)) { cfg.skipped.push({ kind: 'weak', id: w.id, reason: 'target-missing' }); return; }
      var wf = dClone(base.finding); if (w.note) wf.weakNote = w.note; // the card says why the sign is weak
      cfg.rules.push({ id: 'weak.' + w.id, localId: w.id, topicId: base.topicId, weak: true, like: w.like, when: dClone(w.when), finding: wf, serviceTag: base.serviceTag, status: w.status });
    });

    // A profile question that nothing uses (no live fact, no live gate) is not asked: minimal collection, also when the served topics are an older set.
    var usedProfile = {};
    cfg.derive.forEach(function (d) { usedProfile[d.from] = true; });
    cfg.questions.forEach(function (q) { if (q.topicId !== 'profile') condQs(q.showIf, function (id) { usedProfile[id] = true; }); });
    cfg.rules.forEach(function (r) { condQs(r.when, function (id) { usedProfile[id] = true; }); }); // a person follow-up is used by the rules it guards
    // a profile question is also "used" when a later profile question depends on a used one
    var again = true;
    while (again) { again = false; cfg.questions.forEach(function (q) { if (q.topicId === 'profile' && usedProfile[q.id]) condQs(q.showIf, function (id) { if (!usedProfile[id]) { usedProfile[id] = true; again = true; } }); }); }
    cfg.questions = cfg.questions.filter(function (q) {
      if (q.topicId !== 'profile' || usedProfile[q.id]) return true;
      cfg.skipped.push({ kind: 'profile', id: q.id, reason: 'unused' }); return false;
    });
    cfg.profileIds = cfg.profileIds.filter(function (id) { return usedProfile[id]; });
    return cfg;
  }

  /**
   * PER-PERSON EXPANSION. The family question's options say that something happened to "someone in the family"; the follow-up question `who` says to whom (me / spouse /
   * child / parent, several allowed). For every group the route declares:
   *   - the rules that are about "the person who had the event" (g.rules) are evaluated once PER SUBJECT, with that subject's own facts: the respondent keeps the original
   *     questions and rules (the event atom is guarded by "who includes me"); every other subject gets COPIES with qualified ids (`topic.question@spouse`, `topic.rule@spouse`),
   *     whose texts name the person, whose showIf requires that person among the `who` answers, and whose conditions refer only to the copies of the questions;
   *   - g.factQuestions are the follow-up questions of the event (asked per subject, the respondent's original asked only when "me" was chosen);
   *   - g.copyOnly are further questions of a rule that exist only as copies (the respondent's original flow is unchanged);
   *   - g.implies says which options of another question the event itself makes true (e.g. serving in the reserves is the answer "reserve" of the tax events question).
   * No condition is added or invented: a copy's conditions are the original rule's conditions, rewritten to the copies. Anything the copy would need from the respondent's
   * own answers makes the copy invalid (personUnsafe, a lint error). The engine core is untouched: copies are ordinary questions and rules.
   */
  function expandPersons(cfg, route) {
    var P = route.persons; if (!P) return;
    cfg.subjects = P.subjects || {};
    // split a rule whose condition is an "any" into one rule per branch (same finding), so each branch can be classified and expanded on its own
    (P.split || []).forEach(function (id) {
      var i = -1; cfg.rules.forEach(function (r, k) { if (r.id === id && !r.weak) i = k; });
      if (i < 0 || !cfg.rules[i].when || !cfg.rules[i].when.any) return;
      var r = cfg.rules[i], parts = r.when.any.map(function (c, k) { var p = dClone(r); p.id = id + '#' + (k + 1); p.localId = r.localId + '#' + (k + 1); p.baseId = r.baseId || r.id; p.when = c; return p; });
      cfg.rules.splice.apply(cfg.rules, [i, 1].concat(parts));
    });
    (P.groups || []).forEach(function (g) {
      var byId = dById(cfg), skip = function (why) { cfg.skipped.push({ kind: 'person', id: g.id, reason: why }); };
      var qIds = (g.factQuestions || []).concat(g.copyOnly || []);
      if (!byId[g.question] || !dOpt(byId[g.question], g.option) || !byId[g.who] || !guardsOk(byId, g.needs) || !qIds.every(function (id) { return byId[id]; })) return skip('target-missing');
      var rules = []; var ruleMissing = false;
      (g.rules || []).forEach(function (id) { var r = null; cfg.rules.forEach(function (x) { if (x.id === id && !x.weak) r = x; }); if (r) rules.push(r); else ruleMissing = true; });
      if (ruleMissing) return skip('rule-missing');
      var ev = { q: g.question, in: [g.option] }, subs = (g.subjects || []).filter(function (s) { return dOpt(byId[g.who], s); });
      var copiesAfter = {}, newRules = [], nCopyQ = 0;
      // copies for every subject but the respondent (made from the pristine originals)
      subs.filter(function (s) { return s !== 'me'; }).forEach(function (S) {
        var meta = (cfg.subjects || {})[S] || { label: S, prefix: '', note: '' }, map = {}, w = { q: g.who, in: [S] };
        qIds.forEach(function (id) { map[id] = id + '@' + S; });
        qIds.forEach(function (id) {
          var o = byId[id], c = dClone(o), unsafe = false;
          c.id = map[id]; c.localId = o.localId + '@' + S; c.subject = S; c.copyOf = o.id; c.noGate = true; delete c.gatedBy; delete c.derivedBy;
          c.text = (meta.prefix || '') + o.text; c.help = [meta.note, o.help].filter(Boolean).join(' ');
          c.showIf = andC(rewriteCond(o.showIf, map, g.implies, ev, function () { unsafe = true; }), w);
          if (unsafe) c.personUnsafe = true;
          (copiesAfter[o.id] = copiesAfter[o.id] || []).push(c); nCopyQ++;
        });
        rules.forEach(function (r) {
          var c = dClone(r), unsafe = false;
          c.id = r.id + '@' + S; c.localId = r.localId + '@' + S; c.baseId = r.baseId || r.id; c.subject = S; delete c.personGuards;
          c.when = { all: [w, rewriteCond(r.when, map, g.implies, ev, function () { unsafe = true; })] };
          if (unsafe) c.personUnsafe = true;
          newRules.push(c);
        });
      });
      // the respondent: the follow-up questions are asked only when "me" was chosen, and the rules that are about the event person need "me" among the persons
      var me = subs.indexOf('me') !== -1, wMe = { q: g.who, in: ['me'] };
      if (me) {
        (g.factQuestions || []).forEach(function (id) { var q = byId[id]; q.showIf = andC(q.showIf, wMe); q.subject = 'me'; });
        rules.forEach(function (r) {
          var touched = false;
          r.when = guardAtoms(r.when, { question: g.question, option: g.option, who: g.who, as: ['me'] }, false, function (unsafe) { if (unsafe) r.personUnsafe = true; else touched = true; });
          if (touched) { r.subject = 'me'; (r.personGuards = r.personGuards || []).push(g.id); }
        });
      }
      // insert the copies right after their originals
      var out = []; cfg.questions.forEach(function (q) { out.push(q); (copiesAfter[q.id] || []).forEach(function (c) { out.push(c); }); });
      cfg.questions = out;
      cfg.rules = cfg.rules.concat(newRules);
      cfg.personGroups.push({ id: g.id, option: g.option, subjects: subs, questions: nCopyQ, rules: newRules.length });
    });
  }
  function andC(a, b) { return a ? { all: [a, b] } : b; }
  // the condition of a rule or question rewritten for one subject: atoms on questions that have a copy point at the copy; atoms on a question the event itself answers are
  // true (when the implied options meet the atom) or false; the event atom stays; any other question would be the respondent's own answer: not allowed (reported by unsafe()).
  function rewriteCond(cond, map, implies, ev, unsafe) {
    if (!cond) return cond;
    if (cond.all) return { all: cond.all.map(function (c) { return rewriteCond(c, map, implies, ev, unsafe); }) };
    if (cond.any) return { any: cond.any.map(function (c) { return rewriteCond(c, map, implies, ev, unsafe); }) };
    if (cond.not) return { not: rewriteCond(cond.not, map, implies, ev, unsafe) };
    if (cond.q) {
      if (map[cond.q]) return { q: map[cond.q], in: cond.in };
      if (cond.q === ev.q) return cond;
      if (implies && implies[cond.q]) return (cond.in || []).some(function (x) { return implies[cond.q].indexOf(x) !== -1; }) ? { all: [] } : { any: [] };
      unsafe(); return cond;
    }
    return cond;
  }

  function guardAtoms(cond, g, neg, note) {
    if (!cond) return cond;
    if (cond.all) return { all: cond.all.map(function (c) { return guardAtoms(c, g, neg, note); }) };
    if (cond.any) return { any: cond.any.map(function (c) { return guardAtoms(c, g, neg, note); }) };
    if (cond.not) return { not: guardAtoms(cond.not, g, !neg, note) };
    if (cond.q === g.question && Array.isArray(cond.in) && cond.in.indexOf(g.option) !== -1) {
      if (neg) { note(true); return cond; }
      note(false);
      var rest = cond.in.filter(function (x) { return x !== g.option; }), guarded = { all: [{ q: cond.q, in: [g.option] }, { q: g.who, in: g.as || ['me'] }] };
      return rest.length ? { any: [{ q: cond.q, in: rest }, guarded] } : guarded;
    }
    return cond;
  }

  function condQs(cond, fn) {
    if (!cond) return;
    if (cond.all) cond.all.forEach(function (c) { condQs(c, fn); });
    else if (cond.any) cond.any.forEach(function (c) { condQs(c, fn); });
    else if (cond.not) condQs(cond.not, fn);
    else if (cond.q) fn(cond.q);
  }
  function condRefsExist(cond, byId) { var ok = true; condQs(cond, function (id) { if (!byId[id]) ok = false; }); return ok; }

  /* ---------- facts: profile answers → topic answers ---------- */

  /** The answers that the profile determines. First matching fact wins per target. A multi profile answer fills a multi target only when EVERY picked option maps it. */
  function deriveAnswers(cfg, answers) {
    var out = {}, byId = null;
    (cfg.derive || []).forEach(function (d) {
      var a = answers[d.from]; if (!isAnswered(a)) return;
      if (!byId) byId = dById(cfg);
      var picked = dArr(a);
      d.targets.forEach(function (t) {
        if (t in out) return;
        var vals = [], ok = true;
        picked.forEach(function (oid) { var m = d.map[oid]; if (!m || !(t in m)) ok = false; else vals.push(m[t]); });
        if (!ok || !vals.length) return;
        var tq = byId[t], flat = [];
        vals.forEach(function (v) { dArr(v).forEach(function (x) { if (flat.indexOf(x) === -1) flat.push(x); }); });
        if (tq.multi) {
          // keep the target's own option order; an exclusive option never combines with others (the mapping is then not usable)
          var ordered = tq.options.filter(function (o) { return flat.indexOf(o.id) !== -1; }).map(function (o) { return o.id; });
          if (ordered.length !== flat.length) return;
          if (ordered.length > 1 && ordered.some(function (id) { return dOpt(tq, id).exclusive; })) return;
          out[t] = ordered;
        } else {
          if (flat.length !== 1 || !dOpt(tq, flat[0])) return;
          out[t] = flat[0];
        }
      });
    });
    return out;
  }

  /**
   * answers = what the visitor typed (profile + the topic questions that were asked). Returns { answers (cleaned: hidden, derived-over-typed and stale answers dropped),
   * merged (cleaned + derived: what every rule and every condition sees), derived (ids), visible (id → true, derived included) }.
   */
  function deepEffective(cfg, answers) {
    var cur = {}; Object.keys(answers || {}).forEach(function (k) { cur[k] = answers[k]; });
    for (var guard = 0; guard < 30; guard++) {
      var der = deriveAnswers(cfg, cur), merged = {}, k;
      for (k in cur) merged[k] = cur[k];
      for (k in der) merged[k] = der[k];
      var vis = {}; cfg.questions.forEach(function (q) { if (check(q.showIf, merged)) vis[q.id] = true; });
      var next = {}, changed = false;
      Object.keys(cur).forEach(function (key) { if (vis[key] && !(key in der)) next[key] = cur[key]; else changed = true; });
      if (!changed) {
        var m2 = {}, d2 = {};
        Object.keys(merged).forEach(function (key) { if (vis[key]) m2[key] = merged[key]; });
        Object.keys(der).forEach(function (key) { if (vis[key]) d2[key] = true; });
        return { answers: cur, merged: m2, derived: d2, visible: vis };
      }
      cur = next;
    }
    return { answers: {}, merged: {}, derived: {}, visible: {} };
  }

  /** The question to show next (visible, not derived, not answered), or null. */
  function deepNext(cfg, answers) {
    var e = deepEffective(cfg, answers);
    for (var i = 0; i < cfg.questions.length; i++) { var q = cfg.questions[i]; if (e.visible[q.id] && !isAnswered(e.merged[q.id])) return q; }
    return null;
  }

  /** { done, total } of the questions the visitor answers (derived ones are not counted), per phase, and a 0..1 fraction (profile 0.2, topics 0.75; the rest is the result). */
  function deepProgress(cfg, answers) {
    var e = deepEffective(cfg, answers), ph = { profile: { done: 0, total: 0 }, topics: { done: 0, total: 0 } };
    cfg.questions.forEach(function (q) {
      if (!e.visible[q.id] || e.derived[q.id]) return;
      var p = ph[q.phase || 'topics']; p.total++; if (isAnswered(e.merged[q.id])) p.done++;
    });
    var pf = ph.profile.total ? ph.profile.done / ph.profile.total : 1, tf = ph.topics.total ? ph.topics.done / ph.topics.total : 1;
    var hasProfile = ph.profile.total > 0, wP = hasProfile ? 0.2 : 0, wT = hasProfile ? 0.75 : 0.95;
    return { done: ph.profile.done + ph.topics.done, total: ph.profile.total + ph.topics.total, phases: ph, fraction: Math.min(1, wP * pf + wT * tf) };
  }

  function deepPrune(cfg, answers) { return deepEffective(cfg, answers).answers; }

  function valueOk(q, val) {
    if (q.multi) {
      if (!Array.isArray(val) || !val.length || val.length > q.options.length) return false;
      var seen = {};
      for (var k = 0; k < val.length; k++) {
        var o = dOpt(q, val[k]);
        if (!o || seen[val[k]]) return false;
        seen[val[k]] = true;
        if (o.exclusive && val.length > 1) return false;
      }
      return true;
    }
    return !Array.isArray(val) && !!dOpt(q, val);
  }

  /** Only what the visitor must answer: every visible non-derived question answered with a valid value, and nothing else. */
  function deepValidate(cfg, answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
    var e = deepEffective(cfg, answers), keys = Object.keys(answers);
    if (keys.length !== Object.keys(e.answers).length) return false;
    var byId = dById(cfg);
    for (var i = 0; i < keys.length; i++) if (!byId[keys[i]] || !valueOk(byId[keys[i]], answers[keys[i]])) return false;
    return cfg.questions.every(function (q) { return !e.visible[q.id] || e.derived[q.id] || isAnswered(e.merged[q.id]); });
  }

  /* ---------- three-valued evaluation ---------- */

  function mk(v, miss) { return { v: v, miss: miss || [] }; }
  function makeCtx(cfg, merged) {
    var byId = dById(cfg), memo = {};
    var ctx = { byId: byId, merged: merged };
    // is the question shown? (true / false / null = depends on an unknown answer, with the questions that decide it)
    ctx.shown = function (qid) {
      if (memo[qid]) return memo[qid];
      var q = byId[qid]; if (!q) return (memo[qid] = mk(false));
      memo[qid] = mk(null, [qid]); // cycle guard
      return (memo[qid] = q.showIf ? ev3(q.showIf, ctx) : mk(true));
    };
    return ctx;
  }
  function ev3(cond, ctx) {
    if (!cond) return mk(true);
    var i, r, miss, unk;
    if (cond.all) {
      miss = []; unk = false;
      for (i = 0; i < cond.all.length; i++) { r = ev3(cond.all[i], ctx); if (r.v === false) return mk(false); if (r.v === null) { unk = true; miss = miss.concat(r.miss); } }
      return unk ? mk(null, dUniq(miss)) : mk(true);
    }
    if (cond.any) {
      miss = []; unk = false;
      for (i = 0; i < cond.any.length; i++) { r = ev3(cond.any[i], ctx); if (r.v === true) return mk(true); if (r.v === null) { unk = true; miss = miss.concat(r.miss); } }
      return unk ? mk(null, dUniq(miss)) : mk(false);
    }
    if (cond.not) { r = ev3(cond.not, ctx); return r.v === null ? mk(null, r.miss) : mk(!r.v); }
    if (cond.q) {
      if (!Array.isArray(cond.in)) return mk(false);
      var q = ctx.byId[cond.q]; if (!q) return mk(false);
      var a = ctx.merged[cond.q];
      if (!isAnswered(a)) { // not answered: either not asked at all (hidden), or asked and still open, or open because of an unknown earlier answer
        var s = ctx.shown(cond.q);
        if (s.v === false) return mk(false);
        if (s.v === null) return mk(null, s.miss.length ? s.miss : [cond.q]);
        return mk(null, [cond.q]);
      }
      var picked = dArr(a);
      if (picked.some(function (x) { return cond.in.indexOf(x) !== -1; })) return mk(true);
      var unknown = picked.some(function (x) { var o = dOpt(q, x); return !!(o && o.unknown); });
      return unknown ? mk(null, [cond.q]) : mk(false);
    }
    return mk(false);
  }
  /** One condition, three values: true / false / null. Exposed for the truth-table tests. */
  function check3(cond, cfgOrQuestions, answers) {
    var cfg = Array.isArray(cfgOrQuestions) ? { questions: cfgOrQuestions } : cfgOrQuestions;
    var r = ev3(cond, makeCtx(cfg, answers || {}));
    return { value: r.v, missing: r.miss };
  }

  function findingOf(r) {
    var f = r.finding || {};
    var o = { id: r.id, localId: r.localId, topicId: r.topicId, title: f.title, why: f.why, step: f.step, official: f.official, officialMore: f.officialMore, refer: f.refer, serviceTag: r.serviceTag,
      group: f.group, groupTitle: f.groupTitle, groupIntro: f.groupIntro, groupStep: f.groupStep, section: f.section };
    if (r.weak) o.weak = true;
    if (f.weakNote) o.weakNote = f.weakNote;
    o.base = r.baseId || r.id; if (r.subject) o.subject = r.subject;
    return o;
  }
  function dCards(list) {
    var out = [], by = {};
    list.forEach(function (f) {
      if (!f.group) { out.push(f); return; }
      var key = f.topicId + '/' + f.group;
      if (!by[key]) { by[key] = { group: f.group, topicId: f.topicId, title: f.groupTitle || f.title, intro: f.groupIntro, step: f.groupStep, official: f.official, refer: f.refer, parts: [], missing: [] }; out.push(by[key]); }
      by[key].parts.push(f);
      (f.missing || []).forEach(function (m) { if (!by[key].missing.some(function (x) { return x.id === m.id; })) by[key].missing.push(m); });
    });
    return out;
  }

  /**
   * The missing-information cards as the result shows them: items that wait for the SAME unanswered question(s) are folded into one item once there are `min` or
   * more of them (a visitor who declined one personal question would otherwise see a wall of cards that all say the same thing). Nothing is dropped: the folded
   * item lists every card. Returns [{ folded: false, card } | { folded: true, missing: [...], cards: [...] }] in the order of first appearance.
   */
  function groupMissing(cards, min) {
    min = min || 3;
    var by = {}, order = [];
    cards.forEach(function (c) {
      var ids = [], info = {};
      (c.parts || [c]).forEach(function (f) { (f.missing || []).forEach(function (m) { var k = m.ask || m.id; if (!info[k]) { info[k] = m; ids.push(k); } }); });
      var key = ids.slice().sort().join('|');
      if (!by[key]) { by[key] = { cards: [], missing: ids.map(function (id) { return info[id]; }) }; order.push(key); }
      by[key].cards.push(c);
    });
    var out = [];
    order.forEach(function (k) {
      var g = by[k];
      if (g.cards.length >= min) out.push({ folded: true, missing: g.missing, cards: g.cards });
      else g.cards.forEach(function (c) { out.push({ folded: false, card: c }); });
    });
    return out;
  }

  /**
   * The deep result. { outcome, high, missing, low (findings), highCards, missingCards, missingItems, lowCards, counts }.
   * `missing` findings carry `missing: [{ id, text, topicId }]`: the questions whose (unknown) answer decides them.
   * `answers` may be partial (the running count): unanswered visible questions are simply unknown.
   */
  function evaluateDeep(cfg, answers, opts) {
    var includeInactive = !!(opts && opts.includeInactive);
    var e = deepEffective(cfg, answers), ctx = makeCtx(cfg, e.merged), byId = ctx.byId;
    var high = [], missing = [], low = [], unv = {}; (cfg.unverified || []).forEach(function (u) { unv[u.id || u] = true; });
    function dec(f) { var m = (cfg.subjects || {})[f.subject]; if (m) f.subjectLabel = m.label; if (unv[f.base]) f.unverified = true; return f; }
    (cfg.rules || []).forEach(function (r) {
      if (r.status === 'inactive' && !includeInactive) return;
      var res = ev3(r.when, ctx);
      if (r.weak) { if (res.v === true) low.push(dec(findingOf(r))); return; }
      if (res.v === true) high.push(dec(findingOf(r)));
      else if (res.v === null) {
        var f = dec(findingOf(r));
        var askSeen = {};
        f.missing = dUniq(res.miss).map(function (id) { var q = byId[id], ask = id; (cfg.derive || []).forEach(function (d) { if (ask === id && d.targets.indexOf(id) !== -1 && isAnswered(e.answers[d.from])) ask = d.from; }); return { id: id, ask: ask, text: q ? q.text : id, topicId: q ? q.topicId : null, sensitive: !!(q && q.sensitive) }; }).filter(function (m) { if (askSeen[m.ask]) return false; askSeen[m.ask] = true; return true; }); // one entry per question the visitor would have to answer
        missing.push(f);
      }
    });
    var highCards = dCards(high), hg = {}; highCards.forEach(function (c) { if (c.group) hg[c.topicId + '/' + c.group] = true; });
    var missingCards = dCards(missing).filter(function (c) { return !(c.group && hg[c.topicId + '/' + c.group]); });
    var lowCards = dCards(low).filter(function (c) { return !(c.group && hg[c.topicId + '/' + c.group]); });
    var missingItems = groupMissing(missingCards, 3);
    return { outcome: high.length ? 'found' : (missing.length ? 'insufficient' : 'none'), high: high, missing: missing, low: low,
      highCards: highCards, missingCards: missingCards, missingItems: missingItems, lowCards: lowCards,
      counts: { high: high.length, missing: missing.length, low: low.length, highCards: highCards.length, missingCards: missingCards.length, missingItems: missingItems.length, lowCards: lowCards.length } };
  }
  /** The stored form: "tier:ruleId". */
  function deepFindingIds(res) {
    return res.high.map(function (f) { return 'high:' + f.id; }).concat(res.missing.map(function (f) { return 'missing:' + f.id; })).concat(res.low.map(function (f) { return 'low:' + f.id; }));
  }
  /*DEEP-END*/

  return {
    check: check, visibleQuestions: visibleQuestions, nextQuestion: nextQuestion, progress: progress,
    pruneAnswers: pruneAnswers, validateAnswers: validateAnswers, evaluate: evaluate, lint: lint,
    qualifyId: qualifyId, qualifyTopic: qualifyTopic, composeTopics: composeTopics, idCollisions: idCollisions,
    // stage 5: the deep check (additive; none of the functions above uses any of these)
    buildDeep: buildDeep, deriveAnswers: deriveAnswers, deepEffective: deepEffective, deepNext: deepNext, deepProgress: deepProgress, deepPrune: deepPrune,
    deepValidate: deepValidate, evaluateDeep: evaluateDeep, deepFindingIds: deepFindingIds, groupMissing: groupMissing, check3: check3, guardOk: guardOk, condQs: condQs
  };
});
