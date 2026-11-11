'use strict';
// The build checks of the M1 release, offline and read-only (nothing is written outside a temporary folder, no network, no database):
//   1. every function file and every module under netlify/functions loads under this Node version with NO environment (no database, no mail), the way a cold start would load it;
//   2. every function bundles (esbuild, the way a bundler follows its requires), so a missing file or package is found here and not in production;
//   3. every browser file of the administration parses, and each file the admin page names exists;
//   4. the migration files, their numbering, the manifest and every statement are acceptable (scripts/kaspchem-migrate.js --verify-files);
//   5. the SWITCHES ARE CLOSED by default: nothing in the shipped code turns a catalog switch on, nothing reads or writes the lead gate or the public prices, and the catalog sends no mail to anyone outside the two owners;
//   6. no connection string, password or token is in any file that is tracked by git.
// node scripts/check-m1-release.js        exit code 0 only when every check passes
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const results = []; const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log((pass ? 'ok    ' : 'FAIL  ') + name + (pass ? '' : ' -> ' + detail)); };
const walk = (dir, filter, out) => { out = out || []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (!['node_modules', '.git', 'tests', 'docs'].includes(e.name)) walk(full, filter, out); } else if (filter(full)) out.push(full); } return out; };
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

// 1. every server module loads cold
{
  const files = walk(path.join(ROOT, 'netlify', 'functions'), (f) => /\.(js|cjs)$/.test(f)), mjs = walk(path.join(ROOT, 'netlify', 'functions'), (f) => /\.mjs$/.test(f)), bad = [];
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP };   // no database, no mail, nothing of Netlify
  for (const f of files) { const r = spawnSync(process.execPath, ['-e', "require(process.argv[1])", f], { cwd: ROOT, env, encoding: 'utf8' }); if (r.status !== 0) bad.push(rel(f) + ': ' + String(r.stderr).split('\n').find((l) => /Error/.test(l))); }
  for (const f of mjs) { const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import(process.argv[1])", pathToUrl(f)], { cwd: ROOT, env, encoding: 'utf8' }); if (r.status !== 0) bad.push(rel(f) + ': ' + String(r.stderr).split('\n').find((l) => /Error/.test(l))); }
  ok('1. ' + (files.length + mjs.length) + ' server files load cold, with no environment', bad.length === 0, bad.join(' | '));
}
function pathToUrl(f) { return require('url').pathToFileURL(f).href; }

// 2. every function bundles
{
  let esbuild = null; try { esbuild = require('esbuild'); } catch (e) { /* not installed */ }
  if (!esbuild) ok('2. the functions bundle (esbuild is installed: npm ci)', false, 'esbuild is not installed');
  else {
    const entries = walk(path.join(ROOT, 'netlify', 'functions'), (f) => /\.(js|mjs)$/.test(f) && !/_kaspchem/.test(f)), out = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-bundle-')), bad = [];
    for (const e of entries) { try { esbuild.buildSync({ entryPoints: [e], bundle: true, platform: 'node', outfile: path.join(out, path.basename(e) + '.out.js'), logLevel: 'silent', external: [] }); } catch (err) { bad.push(rel(e) + ': ' + String(err.message).split('\n')[0]); } }
    ok('2. ' + entries.length + ' functions bundle with everything they require (' + entries.map((e) => path.basename(e)).join(', ') + ')', bad.length === 0, bad.join(' | '));
  }
}

// 3. the browser files of the administration
{
  const dir = path.join(ROOT, 'admin', 'kaspchem'), js = fs.readdirSync(dir).filter((f) => f.endsWith('.js')), bad = [];
  let modules = 0; for (const f of js) { const t = fs.readFileSync(path.join(dir, f), 'utf8'); if (/^\s*(import|export)\s/m.test(t)) { modules++; continue; } try { new Function(t); } catch (e) { bad.push(f + ': ' + e.message); } }   // an ES module (the source of a bundle) is not parsed as a plain script
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), named = [...html.matchAll(/(?:src|href)="([^"#?]+\.(?:js|css))"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u)), missing = named.filter((u) => !fs.existsSync(u.startsWith('/') ? path.join(ROOT, u) : path.join(dir, u)));
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((m) => m[1].trim()).length;
  ok('3. ' + (js.length - modules) + ' administration scripts parse (' + modules + ' module source skipped); the ' + named.length + ' files the page names exist; the page holds no inline script', bad.length === 0 && missing.length === 0 && inline === 0, bad.concat(missing.map((m) => 'missing ' + m)).concat(inline ? ['inline script'] : []).join(' | '));
  const catalogNamed = ['catalog.js', 'catalog-edit.js', 'catalog-import.js', 'catalog-prices.js', 'catalog.css'].filter((f) => !html.includes(f)); ok('3b. the page loads all five catalog files', catalogNamed.length === 0, 'not named: ' + catalogNamed.join(', '));
}

// 4. the migration files
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'kaspchem-migrate.js'), '--verify-files'], { cwd: ROOT, encoding: 'utf8' });
  ok('4. migration files: ' + String(r.stdout).split('\n')[0].replace(/^Migration files /, ''), r.status === 0, r.stdout + r.stderr);
}

// 5. the switches are closed by default, the public side is not touched
{
  const server = walk(path.join(ROOT, 'netlify', 'functions'), (f) => /\.(js|mjs)$/.test(f)), src = Object.fromEntries(server.map((f) => [rel(f), fs.readFileSync(f, 'utf8')]));
  const turnsOn = Object.entries(src).filter(([f, t]) => /private\.catalog_(activation_)?enabled/.test(t) && /(INSERT|UPDATE)\s+(INTO\s+)?settings/i.test(t) && !/OLD_WRITE_CLOSED|SELECT value = /.test(t)).map(([f]) => f);
  ok('5a. no shipped code turns a catalog switch on (the switches change only by the owner\'s own statement)', turnsOn.length === 0, turnsOn.join(', '));
  const touchesGate = Object.entries(src).filter(([f, t]) => /catalog/.test(f) && /legal_approved|counter_enabled|deep_enabled/.test(t)).map(([f]) => f);
  ok('5b. the catalog code never reads or writes the lead gate, the public counter or the deep check', touchesGate.length === 0, touchesGate.join(', '));
  const pricingWriters = Object.entries(src).filter(([f, t]) => /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+pricing\b/i.test(t)).map(([f]) => f);
  ok('5c. only the older pricing screen (admin-router.js) writes the price table: ' + (pricingWriters.join(', ') || 'none'), pricingWriters.length === 1 && pricingWriters[0] === 'netlify/functions/_kaspchem/admin-router.js', pricingWriters.join(', '));
  const mailers = Object.entries(src).filter(([f, t]) => /nodemailer|sendMail|createTransport/.test(t)).map(([f]) => f);
  ok('5d. mail is sent from exactly the places it always was: ' + (mailers.join(', ') || 'none'), mailers.every((f) => /ops-alert\.js|send-results\.js/.test(f)), mailers.join(', '));
  const alerts = Object.entries(src).filter(([f, t]) => /opsAlert\(/.test(t) && /catalog/.test(f)).map(([f, t]) => f + ' x' + (t.match(/opsAlert\(/g) || []).length);
  ok('5e. the catalog can send an alert to the two owners only from its write routes (behind the open switch): ' + alerts.join(', '), alerts.length === 1 && /admin-catalog-writes/.test(alerts[0]), alerts.join(', '));
}

// 6. no secret in a tracked file
{
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }); const tracked = String(r.stdout).split('\n').filter(Boolean), hits = [];
  const PATTERNS = [/postgres(?:ql)?:\/\/[^\s'"`<>@]+:[^\s'"`<>@]+@/i, /\bnpg_[A-Za-z0-9]{8,}/, /\bnapi_[A-Za-z0-9]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/];
  for (const f of tracked) { if (!/\.(js|mjs|cjs|json|html|css|md|txt|sql|toml|yml|yaml|csv)$/i.test(f) || /^(node_modules|package-lock)/.test(f)) continue; let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; } if (t.length > 3000000) continue; for (const re of PATTERNS) if (re.test(t)) { hits.push(f); break; } }
  const exempt = hits.filter((f) => /^tests\//.test(f)), real = hits.filter((f) => !/^tests\//.test(f));
  ok('6. no connection string with a password, token or key is in any tracked file outside the tests (' + exempt.length + ' test files hold made-up ones)' , real.length === 0, real.join(', '));
}
const failed = results.filter((r) => !r.pass); console.log('\nRESULT: ' + (failed.length ? failed.length + ' of ' + results.length + ' checks FAILED' : 'all ' + results.length + ' checks passed')); process.exit(failed.length ? 1 : 0);
