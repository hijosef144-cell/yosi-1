// Golden master for the deep check (stage 5): records, and later re-checks, what the composed deep check answers on a fixed, seeded sample of complete paths
// (with and without unknown answers) for a content set: a SHA-256 over every path and its three tiers, plus the histogram of tier sizes and rule fire counts.
//   node scripts/golden-deep.js record <topics.json> <snapshot.json>
//   node scripts/golden-deep.js check  <topics.json> <snapshot.json>
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = require('../kaspchem/assets/engine.js');
const L = require('../kaspchem/assets/engine-deep-lint.js');
const N = 20000, SEED = 20261103;

function snapshot(topicsFile) {
  const route = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'routes.json'), 'utf8')).topics.find((t) => t.id === 'deep');
  const topics = JSON.parse(fs.readFileSync(topicsFile, 'utf8')).topics;
  const cfg = E.buildDeep(route, topics), rand = L.rng(SEED), hash = crypto.createHash('sha256'), fires = {}, outcomes = {};
  for (let i = 0; i < N; i++) {
    const a = {}; let q;
    while ((q = E.deepNext(cfg, a))) {
      const unk = q.options.filter((o) => o.unknown), plain = q.options.filter((o) => !o.unknown);
      if (unk.length && rand() < 0.1) a[q.id] = q.multi ? [unk.filter((o) => o.exclusive).concat(unk)[0].id] : unk[0].id;
      else if (!q.multi) a[q.id] = plain[Math.floor(rand() * plain.length)].id;
      else { const c = plain.filter((o) => !o.exclusive && rand() < 0.3).map((o) => o.id); const ex = plain.filter((o) => o.exclusive); a[q.id] = c.length ? c : [(ex.length ? ex : plain)[0].id]; }
    }
    const r = E.evaluateDeep(cfg, a), line = r.outcome + '|' + E.deepFindingIds(r).sort().join(',');
    hash.update(JSON.stringify(a) + '=>' + line + '\n'); outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    E.deepFindingIds(r).forEach((f) => { fires[f] = (fires[f] || 0) + 1; });
  }
  return { content: path.basename(topicsFile), routeSha256: crypto.createHash('sha256').update(JSON.stringify(route)).digest('hex'), paths: N, seed: SEED, digest: hash.digest('hex'), outcomes, fires: Object.fromEntries(Object.keys(fires).sort().map((k) => [k, fires[k]])) };
}
function check(topicsFile, snapFile) {
  const want = JSON.parse(fs.readFileSync(snapFile, 'utf8')), got = snapshot(topicsFile);
  const same = want.digest === got.digest && want.paths === got.paths;
  return { same, want, got };
}
if (require.main === module) {
  const [cmd, content, snap] = process.argv.slice(2);
  if (cmd === 'record') { fs.writeFileSync(snap, JSON.stringify(snapshot(content), null, 1) + '\n'); console.log('recorded', snap); }
  else if (cmd === 'check') { const r = check(content, snap); console.log(r.same ? 'deep golden master identical: ' + r.got.paths + ' paths' : 'DEEP GOLDEN MASTER DIFFERS'); process.exit(r.same ? 0 : 1); }
  else { console.error('usage: golden-deep.js record|check <topics.json> <snapshot.json>'); process.exit(2); }
}
module.exports = { snapshot, check };
