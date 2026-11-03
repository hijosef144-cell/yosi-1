'use strict';
const db = require('./db');
let seed = require('../../../kaspchem/content/topics.json');
// Entry routes (stage 4: the quick check; later the deep check) live in their own file, never in topics.json: topics.json is the ten check topics and may be
// replaced wholesale (e.g. by a V6 publish); routes.json is separate so nothing that regenerates topics.json can drop a route.
const routes = require('../../../kaspchem/content/routes.json');
const setSeed = (s) => { seed = s; module.exports.seed = s; }; // used ONLY by the local test server to preview drafts

const allSeed = () => seed.topics.concat(routes.topics);
const seedTopic = (id) => allSeed().find((t) => t.id === id);

// A route points at topics by id (finding.topic). Returns the list of problems (empty = fine) for a topics file and a routes file.
// A mismatch (e.g. a topics file that no longer has a topic a route points at) must be reported loudly by whoever replaces one of the files.
function routeProblems(topicsFile, routesFile) {
  const ids = new Set((topicsFile.topics || []).map((t) => t.id)), out = [];
  (routesFile.topics || []).forEach((r) => {
    if (ids.has(r.id)) out.push('route ' + r.id + ' has the same id as a topic');
    (r.rules || []).forEach((rule) => { const t = rule.finding && rule.finding.topic; if (!t) out.push(r.id + '.' + rule.id + ' has no finding.topic'); else if (!ids.has(t)) out.push(r.id + '.' + rule.id + ' points at topic "' + t + '" which is not in the topics file'); });
  });
  return out;
}

routeProblems(seed, routes).forEach((p) => console.error('[kaspchem] ROUTE PROBLEM: ' + p)); // loud in the function log; the tests fail on any problem

// Published questionnaire per topic: DB version when one is published, otherwise the bundled seed.
// A DB outage must never take down the public questionnaires.
async function loadTopics() {
  let rows = [];
  if (db.configured()) {
    try { rows = await db.query("SELECT id, topic, version, content FROM questionnaire_versions WHERE status = 'published'"); }
    catch (e) { console.error('[kaspchem] content fallback to seed'); }
  }
  const byTopic = {};
  rows.forEach((r) => { byTopic[r.topic] = r; });
  return allSeed().map((s) => {
    const r = byTopic[s.id];
    if (!r) return Object.assign({}, s, { versionLabel: 'seed:' + seed.version, questionnaireId: null });
    return Object.assign({}, s, r.content, { id: s.id, slug: s.slug, icon: s.icon, order: s.order, versionLabel: 'v' + r.version, questionnaireId: Number(r.id) });
  });
}

async function loadTopic(id) {
  return (await loadTopics()).find((t) => t.id === id) || null;
}

module.exports = { loadTopics, loadTopic, seed, routes, seedTopic, setSeed, routeProblems };
