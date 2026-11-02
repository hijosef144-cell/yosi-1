// Golden master for the rules engine: records, and later re-checks, what the engine answers for every reachable answer path of every topic
// in a content file. Run before and after any engine change; any difference means the change altered an existing result.
//
//   node scripts/golden-master.js record <content.json> <snapshot.json> [--engine <engine.js>] [--scenarios <file-or-dir>]...
//   node scripts/golden-master.js check  <content.json> <snapshot.json> [--engine <engine.js>]
//
// Per topic: every complete, valid answer path is enumerated (multi-select = every allowed subset). A topic whose path count exceeds
// CAP is covered by a fixed number of paths drawn with a seeded generator instead (the snapshot says which mode was used). Each path yields a
// one-line result (outcome, finding ids, card groups, unknown questions); the snapshot keeps the count, a SHA-256 over all lines, the outcome
// histogram and how often each rule fires, so a difference can be localised. Nothing here touches the network, the database or the engine itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAP = 300000, SAMPLE = 30000, SEED = 20261102;

function args() {
  const a = process.argv.slice(2), o = { _: [], scenarios: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--engine') o.engine = a[++i];
    else if (a[i] === '--scenarios') o.scenarios.push(a[++i]);
    else o._.push(a[i]);
  }
  return o;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// All answers allowed for a question: single = each option; multi = every non-empty subset where an exclusive option stands alone.
function choices(q) {
  if (!q.multi) return q.options.map((o) => o.id);
  const ex = q.options.filter((o) => o.exclusive).map((o) => [o.id]);
  const free = q.options.filter((o) => !o.exclusive).map((o) => o.id), out = ex.slice();
  for (let m = 1; m < (1 << free.length); m++) out.push(free.filter((_, i) => m & (1 << i)));
  return out;
}

function line(E, t, answers) {
  const r = E.evaluate(t, answers);
  const cards = r.cards.map((c) => (c.group ? 'g:' + c.group + '[' + c.parts.map((p) => p.id).sort().join(',') + ']' : c.id)).sort();
  return r.outcome + '|' + r.findings.map((f) => f.id).sort().join(',') + '|' + cards.join(',') + '|' + r.unknown.join(',');
}

function topicSnapshot(E, t) {
  const hash = crypto.createHash('sha256'), fires = {}, outcomes = {};
  let paths = 0, invalid = 0;
  function emit(answers) {
    if (!E.validateAnswers(t, answers)) { invalid++; return; }
    const l = line(E, t, answers); paths++;
    hash.update(JSON.stringify(answers) + '=>' + l + '\n');
    outcomes[l.split('|')[0]] = (outcomes[l.split('|')[0]] || 0) + 1;
    E.evaluate(t, answers).findings.forEach((f) => { fires[f.id] = (fires[f.id] || 0) + 1; });
  }
  // count first, with an early stop
  let count = 0;
  (function walk(ans) {
    if (count > CAP) return;
    const q = E.nextQuestion(t, ans);
    if (!q) { count++; return; }
    choices(q).forEach((c) => walk(Object.assign({}, ans, { [q.id]: c })));
  })({});
  let mode = 'exhaustive';
  if (count <= CAP) {
    (function walk(ans) {
      const q = E.nextQuestion(t, ans);
      if (!q) { emit(ans); return; }
      choices(q).forEach((c) => walk(Object.assign({}, ans, { [q.id]: c })));
    })({});
  } else {
    mode = 'sampled:' + SAMPLE + ':seed' + SEED;
    const rand = rng(SEED);
    for (let i = 0; i < SAMPLE; i++) {
      let ans = {}, q;
      while ((q = E.nextQuestion(t, ans))) { const cs = choices(q); ans = Object.assign({}, ans, { [q.id]: cs[Math.floor(rand() * cs.length)] }); }
      emit(ans);
    }
  }
  return { mode: mode, paths: paths, invalid: invalid, digest: hash.digest('hex'), outcomes: outcomes, fires: Object.fromEntries(Object.keys(fires).sort().map((k) => [k, fires[k]])) };
}

function scenarioResults(E, topics, spec) {
  const files = fs.statSync(spec).isDirectory() ? fs.readdirSync(spec).filter((f) => f.endsWith('.json')).map((f) => path.join(spec, f)) : [spec];
  const out = {};
  files.forEach((f) => {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    arr.forEach((s, i) => {
      const t = topics[s.topic], answers = s.answers;
      const key = path.basename(f) + '#' + (s.id || s.name || i) + '@' + s.topic;
      out[key] = !t || !answers ? 'n/a' : (E.validateAnswers(t, answers) ? line(E, t, answers) : 'invalid-path');
    });
  });
  return out;
}

function build(engineFile, contentFile, scenarioSpecs) {
  const E = require(path.resolve(engineFile));
  const raw = fs.readFileSync(contentFile);
  const topics = JSON.parse(raw.toString('utf8')).topics;
  const byId = Object.fromEntries(topics.map((t) => [t.id, t]));
  const snap = { content: path.basename(contentFile), contentSha256: crypto.createHash('sha256').update(raw).digest('hex'), cap: CAP, topics: {}, scenarios: {} };
  topics.forEach((t) => { snap.topics[t.id] = topicSnapshot(E, t); });
  scenarioSpecs.forEach((s) => { Object.assign(snap.scenarios, scenarioResults(E, byId, s)); });
  return snap;
}

function main() {
  const o = args(), cmd = o._[0], content = o._[1], snapFile = o._[2];
  const engineFile = o.engine || path.join(__dirname, '..', 'kaspchem', 'assets', 'engine.js');
  if (!['record', 'check'].includes(cmd) || !content || !snapFile) { console.error('usage: golden-master.js record|check <content.json> <snapshot.json> [--engine file] [--scenarios file-or-dir]'); process.exit(2); }
  if (cmd === 'record') {
    const snap = build(engineFile, content, o.scenarios);
    fs.mkdirSync(path.dirname(snapFile), { recursive: true });
    fs.writeFileSync(snapFile, JSON.stringify(snap, null, 1) + '\n');
    const tot = Object.values(snap.topics).reduce((n, x) => n + x.paths, 0);
    console.log('recorded ' + Object.keys(snap.topics).length + ' topics, ' + tot + ' paths, ' + Object.keys(snap.scenarios).length + ' scenarios -> ' + snapFile);
    return;
  }
  const want = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const specs = o.scenarios.length ? o.scenarios : [];
  const got = build(engineFile, content, specs);
  let bad = 0;
  if (got.contentSha256 !== want.contentSha256) { console.log('CONTENT DIFFERS from the recorded one (' + want.content + ') - the comparison below is not like for like'); bad++; }
  Object.keys(want.topics).forEach((id) => {
    const a = want.topics[id], b = got.topics[id];
    if (!b) { console.log('MISSING topic ' + id); bad++; return; }
    if (a.digest !== b.digest || a.paths !== b.paths) {
      bad++; console.log('DIFFERENT ' + id + ': paths ' + a.paths + ' -> ' + b.paths + '; outcomes ' + JSON.stringify(a.outcomes) + ' -> ' + JSON.stringify(b.outcomes));
      Object.keys(Object.assign({}, a.fires, b.fires)).forEach((r) => { if ((a.fires[r] || 0) !== (b.fires[r] || 0)) console.log('   rule ' + r + ' fires ' + (a.fires[r] || 0) + ' -> ' + (b.fires[r] || 0)); });
    }
  });
  Object.keys(want.scenarios).forEach((k) => { if (k in got.scenarios && got.scenarios[k] !== want.scenarios[k]) { bad++; console.log('SCENARIO CHANGED ' + k + ': ' + want.scenarios[k] + ' -> ' + got.scenarios[k]); } });
  const nTopics = Object.keys(want.topics).length, nPaths = Object.values(want.topics).reduce((n, x) => n + x.paths, 0);
  console.log(bad ? 'GOLDEN MASTER FAILED (' + bad + ' difference(s))' : 'golden master identical: ' + nTopics + ' topics, ' + nPaths + ' paths' + (specs.length ? ', ' + Object.keys(got.scenarios).length + ' scenarios' : ''));
  process.exit(bad ? 1 : 0);
}
if (require.main === module) main();
module.exports = { choices: choices, line: line, topicSnapshot: topicSnapshot, CAP: CAP };
