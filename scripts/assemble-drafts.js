// Assembles the five research draft files into one questionnaire file (read-only on everything except the output).
// Usage: node scripts/assemble-drafts.js [--md docs/research/QUESTIONNAIRES-V2.md]
//   input : docs/research/drafts/B1..B5-*.json  + kaspchem/content/topics.json (published identity fields)
//   output: docs/research/drafts/ALL-v2.draft.json  {"version":2,"status":"DRAFT - not published","topics":[...sorted by published order]}
// Identity fields icon/order/slug/name/tagline/messages are taken from the draft when it has them, otherwise from topics.json.
// With --md it also runs scripts/render-questionnaires-md.js and appends "officialMore" links (which the renderer does not know) under each rule.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const draftsDir = path.join(root, 'docs', 'research', 'drafts');
const files = fs.readdirSync(draftsDir).filter((f) => /^B[1-5]-.*\.json$/.test(f)).sort();
if (files.length !== 5) throw new Error('expected 5 draft files, found ' + files.length);
const published = JSON.parse(fs.readFileSync(path.join(root, 'kaspchem', 'content', 'topics.json'), 'utf8')).topics;
const pub = Object.fromEntries(published.map((t) => [t.id, t]));
const ID_FIELDS = ['icon', 'order', 'slug', 'name', 'tagline', 'messages'];

const topics = [];
files.forEach((f) => {
  JSON.parse(fs.readFileSync(path.join(draftsDir, f), 'utf8')).topics.forEach((t) => {
    const p = pub[t.id];
    if (!p) throw new Error('topic not in published topics.json: ' + t.id);
    const out = Object.assign({}, t);
    ID_FIELDS.forEach((k) => { if (out[k] == null) out[k] = p[k]; });
    topics.push(out);
  });
});
topics.sort((a, b) => a.order - b.order);
if (topics.length !== published.length) throw new Error('expected ' + published.length + ' topics, got ' + topics.length);

const outFile = path.join(draftsDir, 'ALL-v2.draft.json');
fs.writeFileSync(outFile, JSON.stringify({ version: 2, status: 'DRAFT - not published', topics }, null, 1) + '\n');
console.log('wrote', path.relative(root, outFile), topics.length, 'topics,', topics.reduce((n, t) => n + t.rules.length, 0), 'rules');

const mdIdx = process.argv.indexOf('--md');
if (mdIdx > -1) {
  const mdFile = path.resolve(root, process.argv[mdIdx + 1]);
  require('child_process').execFileSync('node', [path.join(__dirname, 'render-questionnaires-md.js'), outFile, mdFile], { stdio: 'inherit' });
  const lines = fs.readFileSync(mdFile, 'utf8').split('\n');
  const extra = {};
  topics.forEach((t) => t.rules.forEach((r) => {
    const f = r.finding || {};
    const rows = [];
    (f.officialMore || []).forEach((m) => rows.push(`  - מסלול רשמי נוסף: [${m.label}](${m.url})`));
    if (f.officialCandidate) rows.push(`  - קישור מועמד (לא אומת, לא מוצג כרשמי): [${f.officialCandidate.label}](${f.officialCandidate.url})`);
    if (r.adminNote) rows.push(`  - הערה פנימית (לא למשתמש): ${r.adminNote}`);
    if (rows.length) extra[r.id] = rows;
  }));
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && extra[cur]) {
      const blanks = []; while (out.length && out[out.length - 1] === '') blanks.push(out.pop());
      extra[cur].forEach((x) => out.push(x)); blanks.forEach((b) => out.push(b)); delete extra[cur];
    }
    cur = null;
  };
  lines.forEach((ln) => {
    const m = ln.match(/^- \*\*.*\*\* `([^`]+)`$/);
    if (m || ln.startsWith('### ') || ln.startsWith('## ')) flush();
    if (m) cur = m[1];
    out.push(ln);
  });
  flush();
  const left = Object.keys(extra);
  if (left.length) throw new Error('could not place extra rows for: ' + left.join(','));
  fs.writeFileSync(mdFile, out.join('\n'));
  console.log('appended officialMore/adminNote rows to', path.relative(root, mdFile));
}
