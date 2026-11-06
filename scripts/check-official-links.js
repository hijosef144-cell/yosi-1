#!/usr/bin/env node
'use strict';
// Re-checks the official links shown to families (kaspchem/content/topics.json: finding.official.url). Needs the network; it is NOT part of the test suite.
//   node scripts/check-official-links.js            list every link with its HTTP status, final address and page title
//   node scripts/check-official-links.js --strict   exit 1 when any link does not answer 2xx (government sites sometimes answer 403 to scripts: those are
//                                                   reported as BLOCKED, not as broken, and need a look in a normal browser)
// Run it before each release and whenever a link is edited; update `official.checked` (YYYY-MM-DD) only after the page was really opened.
const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict');
const topics = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'), 'utf8')).topics;
const links = new Map();
topics.forEach((t) => t.rules.forEach((r) => {
  [r.finding.official, r.finding.officialMore].concat(r.finding.official && r.finding.official.alternative ? [r.finding.official.alternative] : []).forEach((o) => {
    if (o && o.url) { if (!links.has(o.url)) links.set(o.url, []); links.get(o.url).push(r.id); }
  });
}));

async function probe(url) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; KaspchemLinkCheck/1.0)', 'accept-language': 'he,en;q=0.8' } });
    const html = res.ok ? await res.text() : '';
    const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    return { status: res.status, finalUrl: res.url, title: m ? m[1].replace(/&#x([0-9a-f]+);/gi, (x, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\s+/g, ' ').trim().slice(0, 90) : '' };
  } catch (e) { return { status: 0, finalUrl: '', title: String(e && e.message || e).slice(0, 90) }; } finally { clearTimeout(timer); }
}

(async () => {
  let bad = 0, blocked = 0;
  for (const [url, ids] of links) {
    const r = await probe(url);
    const kind = r.status >= 200 && r.status < 300 ? 'OK     ' : (r.status === 403 || r.status === 429 || r.status === 503 ? 'BLOCKED' : 'BROKEN ');
    if (kind === 'BROKEN ') bad++; else if (kind === 'BLOCKED') blocked++;
    console.log(kind + ' ' + r.status + ' ' + url + '  [' + ids.join(',') + ']' + (r.finalUrl && r.finalUrl !== url ? '\n         -> ' + r.finalUrl : '') + (r.title ? '\n         "' + r.title + '"' : ''));
  }
  console.log('\n' + links.size + ' distinct links; broken: ' + bad + '; blocked for scripts (check in a browser): ' + blocked);
  process.exit(strict && (bad || blocked) ? 1 : 0);
})();
