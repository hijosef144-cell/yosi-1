// Builds the "publish-ready" variant: only rules the owner can publish today stay active; everything on list B (needs a manual check)
// and list C (inactive drafts) is switched to status "inactive". Usage: node scripts/make-publishable.js
const fs = require('fs'); const path = require('path');
const d = path.join(__dirname, '..', 'docs', 'research', 'drafts-v3');
const V = process.argv[2] || 'v3';
const B3 = ['lf-inherit-open', 'lf-inherit-search', 'tx-retire', 'hs-empty', 'hs-damaged', 'hs-daycare', 'mg-variable', 'mg-indexed', 'ps-bal', 'ni-disability', 'ni-supplement', 'ed-haredi-employment', 'hh-ins-old', 'hh-ins-two'];
const B4 = ['lf-inherit-open', 'lf-inherit-search', 'hs-empty', 'hs-damaged', 'hs-daycare', 'ps-bal', 'ni-disability', 'ni-supplement', 'ni-survivors', 'hh-ins-two', 'hh-ins-none', 'hh-ins-mortgage', 'ed-haredi-employment'];
// v5 onward: the list-B ids live in docs/research/drafts-<V>/listB.json (a JSON array of rule ids; kept in sync with raw/READINESS-<V>.md)
const listFile = path.join(__dirname, '..', 'docs', 'research', 'drafts-' + V, 'listB.json');
const B = fs.existsSync(listFile) ? JSON.parse(fs.readFileSync(listFile, 'utf8')) : (V === 'v4' ? B4 : B3);
const dd = path.join(__dirname, '..', 'docs', 'research', 'drafts-' + V);
const all = JSON.parse(fs.readFileSync(path.join(dd, 'ALL-' + V + '.draft.json'), 'utf8'));
let flipped = 0;
all.topics.forEach((t) => t.rules.forEach((r) => { if (B.includes(r.id) && r.status !== 'inactive') { r.status = 'inactive'; r.readiness = 'needs-verification'; r.heldBy = 'manual check before publishing (READINESS-' + V.toUpperCase() + ' list B)'; flipped++; } }));
all.status = 'DRAFT - publish-ready variant: only list A rules active';
fs.writeFileSync(path.join(dd, 'PUBLISHABLE-' + V + '.draft.json'), JSON.stringify(all, null, 2));
console.log('inactive added:', flipped);
