// Assembles docs/research/drafts-v3/R*.json into ALL-v3.draft.json (10 topics, published identity fields filled in) and writes
// a rules-stripped copy for blind scenario authors. Usage: node scripts/assemble-v3.js
const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '..', 'docs', 'research');
const cur = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'), 'utf8'));
const all = [];
fs.readdirSync(path.join(dir, 'drafts-v3')).filter((f) => /^R\d.*\.json$/.test(f)).sort().forEach((f) => {
  JSON.parse(fs.readFileSync(path.join(dir, 'drafts-v3', f), 'utf8')).topics.forEach((t) => {
    const b = cur.topics.find((x) => x.id === t.id); if (!b) throw new Error('unknown topic ' + t.id);
    all.push(Object.assign({ icon: b.icon, order: b.order, slug: b.slug, name: b.name, tagline: b.tagline, messages: b.messages }, t));
  });
});
all.sort((a, b) => a.order - b.order);
if (all.length !== 10) throw new Error('expected 10 topics, got ' + all.length);
fs.writeFileSync(path.join(dir, 'drafts-v3', 'ALL-v3.draft.json'), JSON.stringify({ version: 3, status: 'DRAFT - not published', topics: all }, null, 2));
fs.mkdirSync(path.join(dir, 'blind'), { recursive: true });
const blind = all.map((t) => ({ id: t.id, name: t.name, intro: t.intro, questions: t.questions }));
fs.writeFileSync(path.join(dir, 'blind', 'questions-only.json'), JSON.stringify(blind, null, 2));
console.log('assembled', all.length, 'topics; rules:', all.reduce((s, t) => s + t.rules.length, 0));
