'use strict';
// Impact counter, simple model: the owners type ONE starting point (families, shekels) and a switch; completed treatments with an amount are added automatically.
// ALL figures are clearly fake round TEST DATA (1000 / 2000 / 300 ...), except the one test that reproduces the owner's real preview state (C-state), which
// proves that state is only ever READ.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./dev-server');
const db = require('../netlify/functions/_kaspchem/db');
const impact = require('../netlify/functions/_kaspchem/impact');

let srv, base, phoneSeq = 0, realDriver;
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const STRANGER = { 'x-test-user': 'stranger@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: j, headers: r.headers, text };
};
const adm = (m, u, b) => call(m, A + u, b, ADMIN);
const pub = () => call('GET', '/api/kaspchem/impact');
const lead = (phone, name) => ({ topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: name || 'נבדק פיקטיבי', phone, email: '', consentContact: true, consentMarketing: false });
const nextPhone = () => '05299' + String(10000 + ++phoneSeq);
async function request(phone, status) {
  const r = await call('POST', '/api/kaspchem/lead', lead(phone || nextPhone())); assert.equal(r.status, 200, 'lead created');
  if (status !== 'new') assert.equal((await adm('PATCH', '/requests/' + r.body.ref, { status: status || 'done' })).status, 200);
  return r.body.ref;
}
const TODAY = () => impact.todayIL();
const shift = (n) => { const d = new Date(TODAY() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const q = async (sql, p) => (await srv.pg.query(sql, p)).rows;
const KEYS = "('public.counter_enabled','private.impact_baseline_cutoff','private.impact_baseline_approval','private.impact_reference_at')";
// put the tables and settings into an exact state
async function seed(o) {
  o = o || {};
  await srv.pg.exec('DELETE FROM outcomes; DELETE FROM settings WHERE key IN ' + KEYS + "; DELETE FROM audit_log WHERE action LIKE 'impact.%'");
  for (const b of o.baseline || []) await srv.pg.query("INSERT INTO outcomes (source, kind, amount, amount_basis, family_count, evidence_note, entered_by) VALUES ('baseline',$1,$2,$3,$4,$5,'test')", [b.kind || 'located_funds', b.amount, b.basis || 'documented', b.family_count, b.note === undefined ? 'test' : b.note]);
  const put = (k, v) => srv.pg.query("INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,'test')", [k, JSON.stringify(v)]);
  if (o.cutoff) await put('private.impact_baseline_cutoff', o.cutoff);
  if (typeof o.flag === 'boolean') await put('public.counter_enabled', o.flag);
  if (o.approval) await put('private.impact_baseline_approval', { at: '2026-11-03T10:00:00.000Z', by: 'test', fp: 'x', rows: 1 });
}
const setOutcome = (id, amount) => adm('PUT', `/requests/${id}/outcome`, { amount });
const snapshot = async () => JSON.stringify([await q('SELECT * FROM outcomes ORDER BY id'), await q('SELECT * FROM settings ORDER BY key'), await q('SELECT * FROM audit_log ORDER BY id')]);

test.before(async () => {
  process.env.KASPCHEM_RATE_MAX = '1000'; process.env.KASPCHEM_RATE_GLOBAL = '1000';
  srv = await start(0); base = 'http://localhost:' + srv.server.address().port;
  realDriver = (t, p) => srv.pg.query(t, p).then((r) => r.rows);
});
test.after(async () => { srv.server.close(); delete process.env.KASPCHEM_RATE_MAX; delete process.env.KASPCHEM_RATE_GLOBAL; });
test.beforeEach(async () => { await seed(); });

test("the owner's existing state is shown as it is and loading it writes NOTHING (baseline ongoing_saving 201653 / 6 families, cutoff, approval, switch on)", async () => {
  await seed({ baseline: [{ kind: 'ongoing_saving', amount: '201653.00', family_count: 6 }], cutoff: '2026-11-03', flag: true, approval: true });
  // deploying this code over that state: the (idempotent) schema is applied again and nothing in the owner's data changes
  const before = await snapshot();
  await srv.pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'kaspchem-schema.sql'), 'utf8'));
  const a = await adm('GET', '/impact');
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.start, { families: 6, amount: 201653, split: false });
  assert.deepEqual(a.body.total, { families: 6, amount: 201653 });
  assert.deepEqual(a.body.auto, { families: 0, amount: 0 });
  assert.equal(a.body.enabled, true); assert.equal(a.body.shown, true);
  const p = await pub();
  assert.equal(p.status, 200); assert.equal(p.body.enabled, true);
  assert.equal(p.body.families, 6); assert.equal(p.body.amount, 201653);   // a plain total across kinds: the old "active / verified date" logic does not zero it any more
  assert.ok(!isNaN(Date.parse(p.body.as_of)));
  await adm('GET', '/impact'); await pub(); await adm('GET', '/settings');
  assert.equal(await snapshot(), before, 'every outcome row, setting and audit entry is exactly as it was (including updated_at)');
  assert.equal((await q("SELECT count(*)::int n FROM audit_log WHERE action LIKE 'impact.%'"))[0].n, 0);
  // the old approval no longer gates anything: without it the counter is shown just the same
  await srv.pg.exec("DELETE FROM settings WHERE key = 'private.impact_baseline_approval'");
  assert.equal((await pub()).body.families, 6);
});

test('the counter is OFF by default and never cached; on with nothing to show is still off (no zeros)', async () => {
  let r = await pub();
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, enabled: false }); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await adm('GET', '/impact')).body.enabled, false);
  await adm('POST', '/impact/counter', { enabled: true });
  r = await pub(); assert.deepEqual(r.body, { ok: true, enabled: false }); // nothing typed yet
  assert.equal((await adm('GET', '/impact')).body.shown, false);
});

test('the first save of the starting numbers creates the one hidden row, fixes the reference point (cutoff today) and is audited', async () => {
  const r = await adm('PUT', '/impact', { families: 12, amount: 3000 });
  assert.equal(r.status, 200);
  const rows = await q('SELECT source, kind, amount::text AS amount, amount_basis, family_count, evidence_note, voided_at, request_id FROM outcomes');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { source: 'baseline', kind: 'located_funds', amount: '3000.00', amount_basis: 'documented', family_count: 12, evidence_note: impact.START_NOTE, voided_at: null, request_id: null });
  assert.equal((await q("SELECT value FROM settings WHERE key = 'private.impact_baseline_cutoff'"))[0].value, TODAY());
  const g = (await adm('GET', '/impact')).body;
  assert.deepEqual(g.start, { families: 12, amount: 3000, split: false });
  const log = await q("SELECT actor, action, detail FROM audit_log WHERE action = 'impact.start.save'");
  assert.equal(log.length, 1); assert.equal(log[0].actor, 'yosi@example.test');
  assert.deepEqual([log[0].detail.families, log[0].detail.amount, log[0].detail.created, log[0].detail.cutoff, log[0].detail.cutoff_set, log[0].detail.from], [12, 3000, true, TODAY(), true, null]);
});

test('saving again updates the same row (its kind and note stay), an empty note gets the neutral default, a typed format with commas is understood', async () => {
  await seed({ baseline: [{ kind: 'ongoing_saving', amount: '201653.00', family_count: 6, note: 'הערה פנימית של הבעלים' }], cutoff: '2026-11-03', flag: true, approval: true });
  assert.equal((await adm('PUT', '/impact', { families: '7', amount: '202,000.50' })).status, 200);
  let rows = await q('SELECT kind, amount::text AS amount, family_count, evidence_note, amount_basis FROM outcomes');
  assert.deepEqual(rows, [{ kind: 'ongoing_saving', amount: '202000.50', family_count: 7, evidence_note: 'הערה פנימית של הבעלים', amount_basis: 'documented' }]);
  assert.equal((await q("SELECT value FROM settings WHERE key = 'public.counter_enabled'"))[0].value, true, 'the switch is untouched by saving numbers');
  assert.equal((await q("SELECT value FROM settings WHERE key = 'private.impact_baseline_cutoff'"))[0].value, '2026-11-03', 'the reference point is not moved');
  await seed({ baseline: [{ kind: 'one_time_refund', amount: '5', family_count: 1, note: '' }], flag: false });
  assert.equal((await adm('PUT', '/impact', { families: 0, amount: '₪ 12.5' })).status, 200);   // zero families is allowed, and a ₪ sign is understood
  rows = await q('SELECT kind, amount::text AS amount, family_count, evidence_note FROM outcomes');
  assert.deepEqual(rows, [{ kind: 'one_time_refund', amount: '12.50', family_count: 0, evidence_note: impact.START_NOTE }]);
  const log = await q("SELECT detail FROM audit_log WHERE action = 'impact.start.save'");
  assert.deepEqual(log[0].detail.from, { families: 1, amount: 5 });
});

test('plain validation: bad numbers are refused with a code and change nothing', async () => {
  await seed({ baseline: [{ amount: '100', family_count: 2 }], cutoff: '2026-05-05', flag: true });
  const before = await snapshot();
  for (const f of ['', 'abc', '-1', '1.5', '1234567', null]) { const r = await adm('PUT', '/impact', { families: f, amount: '10' }); assert.equal(r.status, 400, 'families ' + f); assert.equal(r.body.error, 'bad_families'); }
  for (const a of ['', 'abc', '-5', '10.123', '9999999999', null, '1e5']) { const r = await adm('PUT', '/impact', { families: 1, amount: a }); assert.equal(r.status, 400, 'amount ' + a); assert.equal(r.body.error, 'bad_amount'); }
  assert.equal((await adm('POST', '/impact/counter', { enabled: 'yes' })).body.error, 'bad_value');
  assert.equal(await snapshot(), before);
});

test('old data split over several starting rows: shown as their sum, read-only, and saving is refused (nothing is merged or voided silently)', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }, { kind: 'one_time_refund', amount: '500.50', family_count: 3 }], cutoff: '2026-05-05', flag: true });
  const before = await snapshot();
  const g = (await adm('GET', '/impact')).body;
  assert.deepEqual(g.start, { families: 5, amount: 1500.5, split: true });
  assert.deepEqual(g.total, { families: 5, amount: 1500.5 });
  const r = await adm('PUT', '/impact', { families: 1, amount: '1' });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'split_baseline');
  assert.equal(await snapshot(), before);
  assert.equal((await adm('POST', '/impact/counter', { enabled: false })).status, 200); // the switch still works
});

test('totals are plain sums across kinds: the starting point plus completed treatments with an amount; families count each applicant once', async () => {
  await seed({ baseline: [{ kind: 'ongoing_saving', amount: '1000', family_count: 2 }], cutoff: '2026-01-01', flag: true });
  const a = await request(), b = await request(), phone = nextPhone(), c = await request(phone), d = await request(phone); // c and d: the same family
  await setOutcome(a, 300); await setOutcome(b, '200.25'); await setOutcome(c, 100); await setOutcome(d, 50);
  // the kind column is internal: make the rows different kinds to prove they are simply added
  await srv.pg.query("UPDATE outcomes SET kind = 'ongoing_saving' WHERE request_id = $1", [a]);
  await srv.pg.query("UPDATE outcomes SET kind = 'one_time_refund' WHERE request_id = $1", [b]);
  const p = (await pub()).body;
  assert.equal(p.families, 2 + 3);                    // 2 starting + applicants of a, b and (c, d together)
  assert.equal(p.amount, 1000 + 300 + 200.25 + 100 + 50);
  const g = (await adm('GET', '/impact')).body;
  assert.deepEqual(g.auto, { families: 3, amount: 650.25 }); assert.deepEqual(g.total, { families: 5, amount: 1650.25 });
  assert.deepEqual(Object.keys(p).sort(), ['amount', 'as_of', 'enabled', 'families', 'ok']);
});

test('marking done and recording an amount adds it automatically; the server fills the hidden defaults', async () => {
  const id = await request(null, 'new');
  assert.equal((await setOutcome(id, 500)).body.error, 'request_not_done');   // only a completed treatment can carry an amount
  assert.equal((await setOutcome(999999, 500)).status, 404);
  await adm('PATCH', '/requests/' + id, { status: 'done' });
  assert.equal((await setOutcome(id, 500)).status, 200);
  const [o] = await q("SELECT source, kind, amount::text AS amount, amount_basis, to_char(completed_on,'YYYY-MM-DD') AS completed_on, evidence_note, starts_on, ends_on, last_verified_at, family_count FROM outcomes WHERE request_id = $1", [id]);
  assert.deepEqual(o, { source: 'system', kind: 'located_funds', amount: '500.00', amount_basis: 'documented', completed_on: TODAY(), evidence_note: impact.AUTO_NOTE, starts_on: null, ends_on: null, last_verified_at: null, family_count: null });
  for (const bad of ['', '0', '-3', 'abc', '1.234', null]) assert.equal((await setOutcome(id, bad)).body.error, 'bad_amount', String(bad));
  const d = (await adm('GET', '/requests/' + id)).body;
  assert.equal(d.outcome.amount, 500); assert.equal(d.outcome.count, 1); assert.ok(d.outcome.id > 0);
  assert.deepEqual((await adm('GET', '/requests/' + (await request(null, 'new')))).body.outcome, { any: 0, count: 0, id: null, amount: 0 });
});

// two kinds on one request is legitimate legacy data (stage 3 allowed one outcome per kind): both are summed, none is ever dropped
async function legacyTwo(id) {
  await srv.pg.query("INSERT INTO outcomes (source, kind, amount, amount_basis, request_id, completed_on, entered_by) VALUES ('system','one_time_refund',900,'documented',$1,$2,'old'), ('system','ongoing_saving',250.5,'documented',$1,$2,'old')", [id, shift(0)]);
}

test('no double counting: one outcome per request through the dashboard (a second set corrects the same one); a duplicate kind is refused by the database', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-01-01', flag: true });
  const id = await request();
  await setOutcome(id, 300); await setOutcome(id, 400);
  assert.equal((await q('SELECT count(*)::int n FROM outcomes WHERE request_id = $1 AND voided_at IS NULL', [id]))[0].n, 1);
  assert.equal((await pub()).body.amount, 1400);
  await assert.rejects(srv.pg.query("INSERT INTO outcomes (source, kind, amount, amount_basis, request_id, completed_on, entered_by) VALUES ('system','located_funds',5,'documented',$1,'2026-03-01','x')", [id]));
});

test('legacy data with two amounts on one request (two kinds): both are summed and the family is counted once; editing from here is refused with a readable error and changes nothing; removing voids all of them, with one audit entry per row', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-01-01', flag: true });
  const id = await request(); await legacyTwo(id);
  let p = (await pub()).body; assert.deepEqual([p.families, p.amount], [3, 1000 + 900 + 250.5]);
  const d = (await adm('GET', '/requests/' + id)).body.outcome;
  assert.deepEqual(d, { any: 2, count: 2, id: null, amount: 1150.5 });                    // the drawer shows the total, no single id to edit
  const before = await snapshot();
  const e = await setOutcome(id, 5);
  assert.equal(e.status, 409); assert.equal(e.body.error, 'several_outcomes');
  assert.equal(await snapshot(), before, 'nothing was overwritten or lost');
  assert.equal((await adm('POST', `/requests/${id}/outcome/remove`, {})).status, 200);
  p = (await pub()).body; assert.deepEqual([p.families, p.amount], [2, 1000]);
  assert.equal((await q('SELECT count(*)::int n FROM outcomes WHERE request_id = $1 AND voided_at IS NULL', [id]))[0].n, 0);
  assert.equal((await q('SELECT count(*)::int n FROM outcomes WHERE request_id = $1 AND voided_at IS NOT NULL', [id]))[0].n, 2, 'the rows are voided, not deleted');
  const log = await q("SELECT entity, entity_id, detail FROM audit_log WHERE action = 'impact.outcome.remove' ORDER BY id");
  assert.deepEqual(log.map((l) => l.detail.amount).sort((a, b) => a - b), [250.5, 900]);
  assert.ok(log.every((l) => String(l.entity_id) === String(id)));
  assert.equal((await adm('GET', '/requests/' + id)).body.outcome.any, 0);
});

test('a correction, a removal or moving the request out of done changes the totals immediately', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-01-01', flag: true });
  const id = await request();
  const now = async () => { const b = (await pub()).body; return [b.families, b.amount]; };
  await setOutcome(id, 300);
  assert.deepEqual(await now(), [3, 1300]);
  await setOutcome(id, 450); assert.deepEqual(await now(), [3, 1450]);
  await adm('PATCH', '/requests/' + id, { status: 'in_progress' });
  assert.deepEqual(await now(), [2, 1000]);
  await adm('PATCH', '/requests/' + id, { status: 'done' });
  assert.deepEqual(await now(), [3, 1450]);
  assert.equal((await adm('POST', `/requests/${id}/outcome/remove`, {})).status, 200);
  assert.deepEqual(await now(), [2, 1000]);
  assert.equal((await adm('POST', `/requests/${id}/outcome/remove`, {})).body.error, 'no_outcome');
  assert.deepEqual((await adm('GET', '/requests/' + id)).body.outcome, { any: 0, count: 0, id: null, amount: 0 });
  assert.equal((await setOutcome(id, 700)).status, 200);        // after a removal the amount can be entered again
  assert.deepEqual(await now(), [3, 1700]);
});

test('the reference point is FIXED: written once at the first save (today, plus the exact moment), never moved by later saves; the automatic part does not depend on the starting numbers', async () => {
  assert.equal((await q("SELECT count(*)::int n FROM settings WHERE key LIKE 'private.impact_%'"))[0].n, 0);
  assert.equal((await adm('PUT', '/impact', { families: 12, amount: 3000 })).status, 200);
  const cut = async () => (await q("SELECT value FROM settings WHERE key = 'private.impact_baseline_cutoff'"))[0].value;
  const ref = async () => (await q("SELECT value, updated_at FROM settings WHERE key = 'private.impact_reference_at'"))[0];
  assert.equal(await cut(), TODAY());
  const r1 = await ref(); assert.ok(Math.abs(Date.parse(r1.value) - Date.now()) < 60000);
  await new Promise((r) => setTimeout(r, 30));
  const c1 = (await q("SELECT updated_at FROM settings WHERE key = 'private.impact_baseline_cutoff'"))[0].updated_at.toISOString();
  await adm('PUT', '/impact', { families: 13, amount: 3500 }); await adm('PUT', '/impact', { families: 14, amount: 4000.5 });
  assert.equal(await cut(), TODAY()); assert.deepEqual(await ref(), r1);
  assert.equal((await q("SELECT updated_at FROM settings WHERE key = 'private.impact_baseline_cutoff'"))[0].updated_at.toISOString(), c1, 'the cutoff row is not even rewritten');
  const log = await q("SELECT detail FROM audit_log WHERE action = 'impact.start.save' ORDER BY id");
  assert.deepEqual(log.map((l) => [l.detail.cutoff_set, l.detail.cutoff]), [[true, TODAY()], [false, TODAY()], [false, TODAY()]]);
  assert.ok(log.every((l) => !('previous_cutoff' in l.detail)));
});

test("saving over the owner's existing state does not touch the reference point (no cutoff rewrite, no reference key, switch untouched)", async () => {
  await seed({ baseline: [{ kind: 'ongoing_saving', amount: '201653.00', family_count: 6 }], cutoff: '2026-11-03', flag: true, approval: true });
  const settingsBefore = JSON.stringify(await q("SELECT * FROM settings WHERE key <> 'public.legal_approved' ORDER BY key"));
  assert.equal((await adm('PUT', '/impact', { families: 7, amount: '200000' })).status, 200);
  const rows = await q("SELECT * FROM settings WHERE key <> 'public.legal_approved' ORDER BY key");
  assert.equal(JSON.stringify(rows), settingsBefore, 'every setting, including updated_at, is exactly as it was');
  assert.equal(rows.some((r) => r.key === 'private.impact_reference_at'), false);
  assert.equal(rows.find((r) => r.key === 'private.impact_baseline_cutoff').value, '2026-11-03');
  assert.deepEqual((await q('SELECT kind, amount::text AS amount, family_count FROM outcomes')), [{ kind: 'ongoing_saving', amount: '200000.00', family_count: 7 }]);
});

test('same-day refinement: with a reference moment, an outcome completed on the cutoff day counts only if it was recorded after the starting numbers were first saved; without one the plain strictly-after rule applies', async () => {
  const early = await request(); await setOutcome(early, 100);              // recorded today, before the first save
  await adm('PUT', '/impact', { families: 2, amount: 1000 });               // first save: cutoff = today, reference moment = now
  await adm('POST', '/impact/counter', { enabled: true });
  const now = async () => { const b = (await pub()).body; return [b.families, b.amount]; };
  assert.deepEqual(await now(), [2, 1000], 'recorded before the first save: inside the starting numbers');
  await new Promise((r) => setTimeout(r, 40));
  const late = await request(); await setOutcome(late, 300);                // completed on the cutoff day, but after the first save
  assert.deepEqual(await now(), [3, 1300]);
  await adm('PUT', '/impact', { families: 5, amount: 2000 });               // editing the numbers later changes only the starting part
  assert.deepEqual(await now(), [6, 2300]);
  // owner's data has a cutoff but no reference moment: strictly after the date
  await srv.pg.exec("DELETE FROM settings WHERE key = 'private.impact_reference_at'");
  assert.deepEqual(await now(), [5, 2000]);
  await srv.pg.query('UPDATE outcomes SET completed_on = $1 WHERE request_id = $2', [shift(1), late]);
  assert.deepEqual(await now(), [6, 2300]);
});

test('returning families: an applicant with an earlier done request is not counted as a new family (her new amount still counts); a new applicant counts once however many treatments; a family with no record in the system is counted (documented limit)', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-06-01', flag: true });
  const post = async (id, amount) => { await setOutcome(id, amount); await srv.pg.query('UPDATE outcomes SET completed_on = $1 WHERE request_id = $2', ['2026-07-01', id]); };
  const now = async () => { const b = (await pub()).body; return [b.families, b.amount]; };
  // returning applicant: an older done request, created before the cutoff, with no amount recorded
  const phone = nextPhone(); const old = await request(phone);
  await srv.pg.query("UPDATE treatment_requests SET created_at = '2026-02-01T10:00:00Z' WHERE id = $1", [old]);
  const again = await request(phone); await post(again, 400);
  assert.deepEqual(await now(), [2, 1400], 'not a new family, but the amount is counted');
  // a second returning applicant recognised by an old OUTCOME that predates the cutoff
  const phone2 = nextPhone(); const old2 = await request(phone2); await setOutcome(old2, 50);
  await srv.pg.query("UPDATE outcomes SET completed_on = '2026-03-01' WHERE request_id = $1", [old2]);
  const again2 = await request(phone2); await post(again2, 100);
  assert.deepEqual(await now(), [2, 1500]);
  // a brand-new applicant with three treatments: one family, all amounts
  const phone3 = nextPhone(); for (const amt of [10, 20, 30]) await post(await request(phone3), amt);
  assert.deepEqual(await now(), [3, 1560]);
  // not evidence: an old request that is not done, or a done request created after the cutoff
  const phone4 = nextPhone(); await request(phone4, 'closed'); const x4 = await request(phone4); await post(x4, 5);
  assert.deepEqual(await now(), [4, 1565]);
  // a returning family that is inside the starting number but has no record here cannot be recognised: counted again (documented limitation)
  const ghost = await request(); await post(ghost, 7);
  assert.deepEqual(await now(), [5, 1572]);
  // the same rules in the dashboard answer
  const g = (await adm('GET', '/impact')).body; assert.deepEqual(g.auto, { families: 3, amount: 572 }); assert.deepEqual(g.total, { families: 5, amount: 1572 });
});

test('SCENARIO from the owner\'s state: two new families complete treatments, the owner edits the starting numbers, an amount is corrected, the switch goes off', async () => {
  await seed({ baseline: [{ kind: 'ongoing_saving', amount: '201653.00', family_count: 6 }], cutoff: '2026-11-03', flag: true, approval: true });
  const cutoff = async () => (await q("SELECT value FROM settings WHERE key = 'private.impact_baseline_cutoff'"))[0].value;
  const now = async () => { const b = (await pub()).body; return b.enabled === false ? b : [b.families, b.amount]; };
  assert.deepEqual(await now(), [6, 201653]);
  const a = await request(), b = await request();                          // two different new applicants
  await setOutcome(a, 1000); await setOutcome(b, 2500);                     // fake amounts
  await srv.pg.query("UPDATE outcomes SET completed_on = '2026-12-01' WHERE source = 'system'");   // completed after the cutoff (the API stamps today)
  assert.deepEqual(await now(), [8, 201653 + 3500]);
  assert.equal(await cutoff(), '2026-11-03');
  assert.equal((await adm('PUT', '/impact', { families: 7, amount: 200000 })).status, 200);
  assert.equal(await cutoff(), '2026-11-03');
  assert.deepEqual(await now(), [9, 203500], 'only the starting part changed; the automatic part is untouched and nothing is counted twice');
  assert.equal((await setOutcome(a, 1200)).status, 200);
  assert.equal(await cutoff(), '2026-11-03');
  assert.deepEqual(await now(), [9, 203700]);
  assert.equal((await adm('POST', '/impact/counter', { enabled: false })).status, 200);
  assert.deepEqual(await now(), { ok: true, enabled: false });             // the very next request
  assert.equal((await q("SELECT count(*)::int n FROM settings WHERE key = 'private.impact_reference_at'"))[0].n, 0);
});

test('outcomes completed on or before the cutoff are not counted (they are inside the typed numbers); a starting row without any saved cutoff makes the automatic part wait; with no starting row everything counts', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-06-01', flag: true });
  const a = await request(), b = await request(), c = await request();
  await setOutcome(a, 10); await setOutcome(b, 20); await setOutcome(c, 30);
  await srv.pg.query("UPDATE outcomes SET completed_on = '2026-05-31' WHERE request_id = $1", [a]);
  await srv.pg.query("UPDATE outcomes SET completed_on = '2026-06-01' WHERE request_id = $1", [b]);   // the cutoff day itself (no reference moment): inside the typed numbers
  await srv.pg.query("UPDATE outcomes SET completed_on = '2026-06-02' WHERE request_id = $1", [c]);
  const now = async () => { const x = (await pub()).body; return [x.families, x.amount]; };
  assert.deepEqual(await now(), [3, 1030]);
  await srv.pg.exec("DELETE FROM settings WHERE key = 'private.impact_baseline_cutoff'");
  assert.deepEqual(await now(), [2, 1000]);
  await srv.pg.exec("DELETE FROM outcomes WHERE source = 'baseline'");
  assert.deepEqual(await now(), [3, 60]);
});

test('estimates, voided rows and zero amounts never count', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-01-01', flag: true });
  const a = await request(), b = await request(), c = await request();
  for (const id of [a, b, c]) await setOutcome(id, 100);
  await srv.pg.query("UPDATE outcomes SET amount_basis = 'estimate' WHERE request_id = $1", [a]);
  await srv.pg.query("UPDATE outcomes SET voided_at = now(), voided_by = 'x' WHERE request_id = $1", [b]);
  await srv.pg.query('UPDATE outcomes SET amount = 0 WHERE request_id = $1', [c]);
  const p = (await pub()).body; assert.deepEqual([p.families, p.amount], [2, 1000]);
});

test('the switch: on and off take effect for the very next request, nothing is cached, and it is audited', async () => {
  await seed({ baseline: [{ amount: '1000', family_count: 2 }], cutoff: '2026-01-01' });
  assert.deepEqual((await pub()).body, { ok: true, enabled: false });
  assert.deepEqual((await adm('POST', '/impact/counter', { enabled: true })).body, { ok: true, enabled: true });
  let r = await pub(); assert.equal(r.body.enabled, true); assert.equal(r.headers.get('cache-control'), 'no-store');
  await adm('POST', '/impact/counter', { enabled: false });
  r = await pub(); assert.deepEqual(r.body, { ok: true, enabled: false }); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await q("SELECT action FROM audit_log WHERE action LIKE 'impact.counter.%' ORDER BY id")).map((x) => x.action), ['impact.counter.enable', 'impact.counter.disable']);
});

test('the public endpoint leaks nothing personal and nothing per kind or per record', async () => {
  const phone = nextPhone(); await seed({ baseline: [{ kind: 'ongoing_saving', amount: '1000', family_count: 2, note: 'הערת פתיחה פנימית' }], cutoff: '2026-01-01', flag: true });
  const id = await request(phone, 'done'); await setOutcome(id, 300);
  const r = await pub();
  assert.deepEqual(Object.keys(r.body).sort(), ['amount', 'as_of', 'enabled', 'families', 'ok']);
  for (const bad of ['נבדק פיקטיבי', phone, 'הערת', 'yosi@', 'request', 'applicant', 'evidence', 'outcome', 'baseline', 'kind', 'ongoing', 'located', 'refund', 'active_now', 'amounts', 'families_helped', 'verified']) assert.ok(!r.text.includes(bad), 'leaks: ' + bad);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call('POST', '/api/kaspchem/impact', {})).status, 405);
  assert.equal((await call('GET', A + '/impact')).status, 401);
});

test('a database failure gives a minimal failure with no detail and nothing is cached', async () => {
  await adm('POST', '/impact/counter', { enabled: true });
  db.setDriver(async () => { throw new Error('secret connection string postgres://user:pw@host/db'); });
  const orig = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' '));
  let r; try { r = await pub(); } finally { console.error = orig; db.setDriver(realDriver); }
  assert.equal(r.status, 503); assert.deepEqual(r.body, { ok: false }); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(!r.text.includes('secret') && !r.text.includes('postgres'));
  assert.ok(logged.some((l) => l.includes('impact')) && logged.every((l) => !l.includes('postgres://')));
  assert.equal((await pub()).status, 200);
});

test('every impact route is admin-only and needs the CSRF header; the generic settings route cannot touch the counter keys; obsolete routes are gone', async () => {
  const id = await request(); await setOutcome(id, 100);
  const routes = [['GET', '/impact'], ['PUT', '/impact', { families: 1, amount: '1' }], ['POST', '/impact/counter', { enabled: true }], ['PUT', `/requests/${id}/outcome`, { amount: '5' }], ['POST', `/requests/${id}/outcome/remove`, {}]];
  const before = await snapshot();
  for (const [m, u, b] of routes) {
    assert.equal((await call(m, A + u, b, { 'x-kaspchem': '1' })).status, 401, 'anonymous ' + m + u);
    assert.equal((await call(m, A + u, b, STRANGER)).status, 403, 'not allow-listed ' + m + u);
    if (m !== 'GET') assert.equal((await call(m, A + u, b, { 'x-test-user': 'yosi@example.test|admin' })).status, 403, 'no CSRF header ' + m + u);
  }
  process.env.KASPCHEM_REQUIRE_ROLE = '1';
  assert.equal((await call('POST', A + '/impact/counter', { enabled: true }, { 'x-test-user': 'yosi@example.test|', 'x-kaspchem': '1' })).status, 403);
  delete process.env.KASPCHEM_REQUIRE_ROLE;
  assert.equal((await snapshot()).replace(/"created_at":"[^"]*"/g, ''), before.replace(/"created_at":"[^"]*"/g, ''), 'every refused call changed nothing (the alert for the stranger is not an audit entry)');
  for (const key of ['public.counter_enabled', 'private.impact_baseline_cutoff', 'private.impact_baseline_approval', 'private.impact_reference_at']) {
    const r = await adm('PUT', '/settings', { key, value: true }); assert.equal(r.status, 400); assert.equal(r.body.error, 'use_impact_api');
  }
  for (const [m, u] of [['POST', '/impact/baseline'], ['PATCH', '/impact/outcomes/1'], ['POST', '/impact/outcomes/1/void'], ['PUT', '/impact/baseline-cutoff'], ['POST', '/impact/approve-baseline'], ['POST', `/requests/${id}/outcomes`], ['POST', `/requests/${id}/outcome-none`]])
    assert.equal((await adm(m, u, {})).status, 404, 'obsolete route still exists: ' + m + ' ' + u);
});

test('every change is in the audit log with figures only (no names, no notes); reading writes nothing', async () => {
  const phone = nextPhone(); const id = await request(phone);
  await adm('PUT', '/impact', { families: 4, amount: '2000' });
  await adm('PUT', '/impact', { families: 5, amount: '2500.50' });
  await adm('POST', '/impact/counter', { enabled: true });
  await setOutcome(id, 100); await setOutcome(id, 150);
  await adm('POST', `/requests/${id}/outcome/remove`, {});
  await adm('POST', '/impact/counter', { enabled: false });
  await adm('GET', '/impact'); await pub();
  const rows = await q("SELECT actor, action, entity, detail FROM audit_log WHERE action LIKE 'impact.%' ORDER BY id");
  assert.deepEqual(rows.map((r) => r.action), ['impact.start.save', 'impact.start.save', 'impact.counter.enable', 'impact.outcome.create', 'impact.outcome.update', 'impact.outcome.remove', 'impact.counter.disable']);
  assert.ok(rows.every((r) => r.actor === 'yosi@example.test'));
  assert.deepEqual(rows[4].detail, { amount: 150, from: 100 });
  const all = JSON.stringify(rows);
  for (const bad of ['נבדק פיקטיבי', phone, impact.START_NOTE, impact.AUTO_NOTE]) assert.ok(!all.includes(bad), 'log contains ' + bad);
});

test('alerts are untouched: the impact routes send no notification', async () => {
  const ops = require('../netlify/functions/_kaspchem/ops-alert'); const sent = []; ops.setSender(async (m) => { sent.push(m); });
  try {
    const id = await request(); sent.length = 0;
    await adm('PUT', '/impact', { families: 1, amount: '1' }); await adm('POST', '/impact/counter', { enabled: true }); await setOutcome(id, 5); await adm('POST', `/requests/${id}/outcome/remove`, {}); await pub();
    assert.deepEqual(sent, []);
  } finally { ops.setSender(null); }
});

test('no real or example figure is shipped; sentence 3 of the headline stays off (impact.js always reports no number)', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['netlify/functions/_kaspchem/impact.js', 'netlify/functions/kaspchem-impact.js', 'kaspchem/assets/impact.js', 'kaspchem/assets/headline.js', 'kaspchem/index.html', 'admin/kaspchem/admin.js', 'db/kaspchem-schema.sql']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/83[,.]?885|201[,.]?653/.test(s), f + ' contains a real or example figure');
    assert.ok(!/setThird\(\s*\d/.test(s) && !/ברגע זה יש \d/.test(s), f + ' types a number into sentence 3');
  }
  const js = fs.readFileSync(path.join(root, 'kaspchem/assets/impact.js'), 'utf8');
  assert.ok(/KaspHeadline\.impact\(null\)/.test(js) && !/active_now/.test(js));
  const html = fs.readFileSync(path.join(root, 'kaspchem/index.html'), 'utf8');
  assert.ok(!/data-kind|ongoing_saving|חיסכון שנתי|החזרים חד/.test(html), 'no kinds on the home page');
});
