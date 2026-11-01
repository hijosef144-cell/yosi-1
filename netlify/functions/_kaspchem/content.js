'use strict';
const db = require('./db');
let seed = require('../../../kaspchem/content/topics.json');
const setSeed = (s) => { seed = s; module.exports.seed = s; }; // used ONLY by the local test server to preview drafts

const seedTopic = (id) => seed.topics.find((t) => t.id === id);

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
  return seed.topics.map((s) => {
    const r = byTopic[s.id];
    if (!r) return Object.assign({}, s, { versionLabel: 'seed:' + seed.version, questionnaireId: null });
    return Object.assign({}, s, r.content, { id: s.id, slug: s.slug, icon: s.icon, order: s.order, versionLabel: 'v' + r.version, questionnaireId: Number(r.id) });
  });
}

async function loadTopic(id) {
  return (await loadTopics()).find((t) => t.id === id) || null;
}

module.exports = { loadTopics, loadTopic, seed, seedTopic, setSeed };
