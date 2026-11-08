'use strict';
// G2 stage A2 launcher: runs the three read-only stages of scripts/kaspchem-g2.js (identity, headers, lock-probe) WITHOUT the connection string ever being typed, pasted into a command, put in a file or
// put in an environment variable. The owner copies it in the Neon console ("Copy snippet"), exactly once, when this script says so; the script
//   1. waits for text on the Windows clipboard that contains a postgres:// connection string (anything else on the clipboard is left alone and never shown);
//   2. checks it BEFORE using it: the role must be kaspchem_app, the host a Neon endpoint equal to --expect-endpoint (direct, not a pooler), one database. A connection string that fails is cleared
//      from the clipboard at once and the reason (never the string) is shown, so a wrong one cannot stay around;
//   3. clears the clipboard immediately after reading it and reads it back to prove it is gone (if it cannot be cleared the script stops before connecting);
//   4. keeps the string in memory only and hands it to the G2 tool's own main() for the three stages, in order, stopping at the first one that does not pass (no retry, no repair);
//   5. forgets it. It is never in process.env (the tool receives a copy of the environment object with the string added), never printed, never written to the state file (the tool redacts it).
// The tool itself is unchanged: all its identity checks (role, endpoint, database, environment, marker, forbidden endpoints, HTTP guard) still apply.
// WHAT CAN BE RUN FROM HERE: the three read-only stages (identity, headers, lock-probe), and exactly THREE stages that write: atomic-control (C1: one inactive synthetic service and its audit row on the
// child branch), atomic-rollback (C2: three batches DESIGNED TO FAIL, nothing is kept) and atomic-guard (C3: three import batches that the import guard must stop before any write, nothing is kept, then ONE ordinary
// write: one inactive service and its audit row). A write stage runs only when it is named in --stages ALONE and approved by its own name with
// --allow-writes=<that stage> (a bare --allow-writes is refused, and so is approving a stage that was not named, an approval for another name, or a write stage together with others), and only ONCE per
// endpoint and marker: a write stage that has already passed is refused. No other stage that writes (atomic-import) and none of the locked stages can be named at all: unlocking one is a
// change to this file that needs its own review and approval. The tool still requires the stage before to have passed on the same endpoint and marker, and this launcher checks that BEFORE it asks anyone to copy the string.
// atomic-rollback and atomic-guard PAUSE BEFORE EVERY send, the first included, until an independent check releases that one. A release is bound to that very pause: each pause prints a fresh random code and is released
// only by the file docs/research/raw/g2-release.txt holding exactly "go <code>" (anything else stops the stage; a file that existed before the pause is deleted and never honoured; a code from an earlier
// pause, an old file, or a file left behind cannot release another pause; no release within 15 minutes = stop). The file is deleted as soon as it has been read.
//
//   node scripts/kaspchem-g2-clipboard.js --expect-endpoint=ep-... --expect-env=test --marker=<token> [--stages=identity,headers,lock-probe] [--wait-seconds=600] [--state=<file>]
//   node scripts/kaspchem-g2-clipboard.js --expect-endpoint=ep-... --expect-env=test --marker=<token> --stages=atomic-control --allow-writes=atomic-control
//   node scripts/kaspchem-g2-clipboard.js --expect-endpoint=ep-... --expect-env=test --marker=<token> --stages=atomic-rollback --allow-writes=atomic-rollback
//   node scripts/kaspchem-g2-clipboard.js --expect-endpoint=ep-... --expect-env=test --marker=<token> --stages=atomic-guard --allow-writes=atomic-guard
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const G = require('./kaspchem-g2.js');

const ALLOWED_STAGES = ['identity', 'headers', 'lock-probe'];   // read-only, or rolled back by design
const WRITE_STAGES = ['atomic-control', 'atomic-rollback', 'atomic-guard'];      // each: alone, with --allow-writes=<its own name>, once (see parseArgs and run)
const WRITE_NOTES = {
  'atomic-control': 'THIS RUN WRITES synthetic data on the child branch: one inactive service named g2-<run>-control and one audit row',
  'atomic-rollback': 'THIS RUN SENDS three write batches that are DESIGNED TO FAIL and be rolled back whole: no row should be kept. Reserved ids are used up (services_id_seq +33, audit_log_id_seq +2). It pauses BEFORE each of the three scenarios until the independent check has compared the database and releases that one',
  'atomic-guard': 'THIS RUN SENDS three import batches with a WRONG or an OLD fingerprint that the import guard must STOP before any write (no row should be kept), and then ONE ordinary write: one inactive synthetic service and its audit row, the only change of rows. Reserved ids are used up (services_id_seq +5, professionals_id_seq +2, audit_log_id_seq +1). It pauses BEFORE each of the four sends until the independent check has compared the database and releases that one',
};
const RELEASE_FILE = path.join(__dirname, '..', 'docs', 'research', 'raw', 'g2-release.txt');

// The pause before each send of atomic-rollback and atomic-guard: an outside check creates the release file once it has compared the database. Any file that exists when a pause begins is deleted first, and the release
// must carry the random code of THIS pause ("go <code>"): a stale or reused file cannot match it, even if it were created after the deletion and before the code was shown.
function filePause(o) {
  return async (label) => {
    try { fs.unlinkSync(o.file); } catch (e) { /* none */ }
    const code = crypto.randomBytes(4).toString('hex');
    o.out('PAUSE ' + label + ': waiting for the independent check. It releases this one by creating ' + path.basename(o.file) + ' with exactly this text: go ' + code + ' (anything else stops the stage). Waiting up to ' + o.seconds + ' seconds.');
    const start = o.clock();
    while (o.clock() - start <= o.seconds * 1000) {
      if (fs.existsSync(o.file)) { const v = String(fs.readFileSync(o.file, 'utf8')).trim(); try { fs.unlinkSync(o.file); } catch (e) { /* gone */ } return v === 'go ' + code; }
      await o.sleep(o.pollMs);
    }
    return false;
  };
}
const URL_IN_TEXT = /postgres(?:ql)?:\/\/[^\s'"`<>]+/i;
const extractUrl = (text) => { const m = URL_IN_TEXT.exec(String(text || '')); return m ? m[0].replace(/[;,.)]+$/, '') : null; };

// ---- the real Windows clipboard (PowerShell 5.1 is part of Windows). Nothing is ever put on a command line: the commands are constants and the text only travels through the pipe. -------------------
function windowsClipboard() {
  const ps = (script) => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', '$ErrorActionPreference = "Stop"; ' + script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (r.error || r.status !== 0) throw new Error('clipboard_unavailable');
    return r.stdout;
  };
  return {
    read: async () => ps('$t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }'),
    clear: async () => { ps('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()'); },
    historyEnabled: () => { try { return ps('(Get-ItemProperty "HKCU:\\Software\\Microsoft\\Clipboard" -ErrorAction SilentlyContinue).EnableClipboardHistory').trim() === '1'; } catch (e) { return null; } },
  };
}

function parseArgs(argv) {
  const a = { stages: ALLOWED_STAGES.slice(), wait: 600 };
  for (const x of argv) {
    let m;
    if (/:\/\/|postgres/i.test(x)) throw new Error('a connection string must never be given on the command line: it is read from the clipboard.');
    if (x === '--allow-writes') throw new Error('--allow-writes must name the one stage it approves: --allow-writes=' + WRITE_STAGES[0] + '.');
    if ((m = /^--(expect-endpoint|expect-env|marker|stages|wait-seconds|state|allow-writes)=(.*)$/.exec(x))) {
      const k = m[1], v = m[2];
      if (k === 'expect-endpoint') a.endpoint = v; else if (k === 'expect-env') a.env = v; else if (k === 'marker') a.marker = v; else if (k === 'state') a.state = v;
      else if (k === 'allow-writes') a.allowWrite = v; else if (k === 'stages') a.stages = v.split(',').map((s) => s.trim()).filter(Boolean); else a.wait = Number(v);
    } else throw new Error('unknown option: ' + x.slice(0, 40));
  }
  if (!a.endpoint || !/^ep-[a-z0-9-]{3,60}$/.test(a.endpoint)) throw new Error('give --expect-endpoint=ep-... (the endpoint of the CHILD branch).');
  if (!a.env || !/^[a-z][a-z0-9_-]{0,30}$/.test(a.env) || a.env === 'production') throw new Error('give --expect-env=<value of meta.environment>; "production" is never accepted.');
  if (!a.marker || !/^[a-z0-9]{12,40}$/.test(a.marker)) throw new Error('give --marker=<the token of the child-branch marker>.');
  if (!a.stages.length || a.stages.some((s) => !ALLOWED_STAGES.includes(s) && !WRITE_STAGES.includes(s))) throw new Error('only these stages can be run from here: ' + ALLOWED_STAGES.concat(WRITE_STAGES).join(', ') + '.');
  const writes = a.stages.filter((s) => WRITE_STAGES.includes(s));
  if (writes.length) {
    if (a.stages.length !== 1) throw new Error('a stage that writes runs alone: --stages=' + writes[0] + '.');
    if (a.allowWrite !== writes[0]) throw new Error('a stage that writes needs its own explicit approval: --allow-writes=' + writes[0] + '.');
  } else if (a.allowWrite !== undefined) throw new Error('--allow-writes approves a stage that writes, and none was named.');
  if (!Number.isFinite(a.wait) || a.wait < 5 || a.wait > 1800) throw new Error('--wait-seconds must be between 5 and 1800.');
  return a;
}

// deps (tests): { clipboard, fetch, write, env, clock, sleep, pollMs }. Returns { code, lines, results }: 0 = every stage passed, 1 = a stage failed, 2 = nothing was run.
async function run(argv, deps) {
  const d = deps || {}, lines = []; let redact = G.makeRedactor([]);
  const out = (s) => { const t = redact(s); lines.push(t); (d.write || console.log)(t); };
  let url = null;
  try {
    let args; try { args = parseArgs(argv); } catch (e) { out('REFUSED: ' + e.message + ' Nothing was run.'); return { code: 2, lines, results: [] }; }
    // the gate of the tool, checked here first so that nobody is asked to copy a connection string for a run that is certain to be refused: the stage before the first one must have passed on this endpoint and marker
    const writing = args.stages.some((s) => WRITE_STAGES.includes(s)), stateFile = args.state || G.DEFAULT_STATE, gate = G.readState(stateFile);
    for (const need of G.STAGES[args.stages[0]].needs) if (!G.passed(gate, need, args.endpoint, args.marker)) { out('REFUSED: stage "' + args.stages[0] + '" needs stage "' + need + '" to have passed first on this endpoint and marker (state file). Nothing was run.'); return { code: 2, lines, results: [] }; }
    // a stage that writes is approved to run ONCE on an endpoint and marker: if it has already passed, running it again is not approved from here
    if (writing && G.passed(gate, args.stages[0], args.endpoint, args.marker)) { out('REFUSED: stage "' + args.stages[0] + '" has already PASSED on this endpoint and marker; a write stage is approved to run once, so it is not run again. Nothing was run.'); return { code: 2, lines, results: [] }; }
    const clipboard = d.clipboard || windowsClipboard(), clock = d.clock || Date.now, sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), pollMs = d.pollMs || 1500;
    const releaseFile = d.releaseFile || RELEASE_FILE; if (writing) { try { fs.unlinkSync(releaseFile); } catch (e) { /* none: a release file from an earlier time must never release anything */ } }
    const history = clipboard.historyEnabled ? await clipboard.historyEnabled() : null;
    await clipboard.read();   // proves the clipboard can be read before anyone is asked to copy anything
    out('READY. Stages: ' + args.stages.join(' -> ') + ' on endpoint ' + args.endpoint + ' as kaspchem_app. ' + (writing ? WRITE_NOTES[args.stages[0]] + ' (approved by name with --allow-writes=' + args.allowWrite + ').' : 'Nothing is written by these stages.'));
    out('NOW: in the Neon console open the CHILD branch, role kaspchem_app, and press "Copy snippet" for the connection string. Copy nothing else until this script says it has the string. Waiting up to ' + args.wait + ' seconds.');
    if (history === true) out('NOTE: Windows clipboard history is ON, so the copied string will also be kept in Win+V history. This script clears the clipboard but does not delete your other history items: after the run press Win+V and choose "Clear all".');
    const start = clock(); let rejected = 0;
    while (url === null) {
      if (clock() - start > args.wait * 1000) { out('TIMEOUT: no usable connection string was copied. Nothing was run and the clipboard was not touched.'); return { code: 2, lines, results: [] }; }
      const found = extractUrl(await clipboard.read());
      if (found) {
        let reason = null;
        try { const c = G.parseConnection(found); if (c.pooler) reason = 'it is a pooled address (use the direct one)'; else if (c.endpoint !== args.endpoint) reason = 'its endpoint is not ' + args.endpoint; } catch (e) { reason = e.message.replace(/^KASPCHEM_G2_DATABASE_URL /, 'the string '); }
        redact = G.makeRedactor([found]);
        await clipboard.clear();   // whatever it was, a connection string does not stay on the clipboard
        if (extractUrl(await clipboard.read())) { out('STOPPED: the clipboard could not be cleared, so nothing was run. Clear it by hand (and Win+V history), then start again.'); return { code: 2, lines, results: [] }; }
        if (reason) { rejected++; out('REJECTED and cleared from the clipboard: ' + reason + '. Copy the right one (the child branch, role kaspchem_app, direct host).'); redact = G.makeRedactor([]); continue; }
        url = found; out('GOT IT: the string passed the role and endpoint checks and the clipboard is cleared. You can copy other things again. Running the stages now.');
        break;
      }
      await sleep(pollMs);
    }
    const base = d.env || process.env, env = Object.assign({}, base, { KASPCHEM_G2_DATABASE_URL: url }), results = [];   // a COPY with the string in it: process.env itself is never touched
    for (const stage of args.stages) {
      // the tool's own write flag is passed to a stage that writes and to no other stage (parseArgs has already made sure that stage is alone and approved by name)
      const r = await G.main(['--run=' + stage, '--approved-stages=' + stage, '--expect-endpoint=' + args.endpoint, '--expect-env=' + args.env, '--marker=' + args.marker].concat(args.state ? ['--state=' + args.state] : [], WRITE_STAGES.includes(stage) ? ['--allow-writes'] : []), env, { fetch: d.fetch, write: out, now: d.now, pause: d.pause || filePause({ file: releaseFile, seconds: d.pauseSeconds || 900, clock, sleep, pollMs: d.pausePollMs || 1000, out }) });
      results.push([stage, r.code]);
      if (r.code !== 0) { out('STOPPED at stage ' + stage + ' (exit ' + r.code + '). No retry and no repair. The stages after it were not run.'); return { code: r.code === 2 ? 2 : 1, lines, results }; }
    }
    out((writing ? 'WRITE STAGE RESULT: PASS (' : 'A2 RESULT: PASS (') + results.map((x) => x[0]).join(', ') + '). The connection string was held in memory only and is gone.' + (rejected ? ' (' + rejected + ' wrong string(s) were rejected and cleared first.)' : ''));
    return { code: 0, lines, results };
  } catch (e) {
    out('STOPPED: ' + (e && e.message === 'clipboard_unavailable' ? 'the Windows clipboard could not be read.' : 'unexpected error - ' + String((e && e.message) || '').slice(0, 120)));
    return { code: 2, lines, results: [] };
  } finally { url = null; }
}

module.exports = { run, parseArgs, extractUrl, windowsClipboard, filePause, ALLOWED_STAGES, WRITE_STAGES, RELEASE_FILE };
if (require.main === module) run(process.argv.slice(2)).then((r) => process.exit(r.code), () => { console.error('STOPPED: unexpected failure.'); process.exit(2); });
