'use strict';
// The legal clearance of a service is a REPORT by an owner that a written approval was received; the system verifies nothing. Every event (a registration, a cancellation, a registration again) must leave its own
// record in the append-only audit journal, with the structured facts that were given, so that "what was reported, by whom and when" can be rebuilt even after the row of the service was overwritten by a later event.
// In-memory Postgres (PGlite) with the real tables and the real grants, running as kaspchem_app; synthetic data; no network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { world, closeAll, YOSI, AVI, STRANGER } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const j = (b) => ({ body: b });
const CLEARANCE = (id) => '/catalog/services/' + id + '/clearance';
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/;
async function ready(id, code) { const w = await world(); await w.open(); assert.equal((await w.call('PUT', '/catalog/services/' + id + '/settings', YOSI, j({ code: code || 'journal-' + id }))).status, 200); return w; }
const events = (w, id) => w.audits("action = 'catalog.service.clearance' AND entity_id = '" + id + "'");
const row = async (w, id) => (await w.owner('SELECT legal_cleared, legal_cleared_by, legal_cleared_at IS NOT NULL AS has_time, legal_note, offered FROM service_settings WHERE service_id = ' + id))[0];

test('the sequence first approval, cancellation, second approval, another cancellation: four append-only journal rows, each with what was given in it; a later event never changes or hides an earlier one', async () => {
  const w = await ready(12, 'mortgage-advice'); const url = CLEARANCE(12), post = (who, body) => w.call('POST', url, who, j(body));
  const first = { cleared: true, expected_cleared: false, source_kind: 'written_opinion', source: 'חוות דעת של משרד עורכי דין, מתאריך 05.11.2026', approved_on: '2026-11-05', note: 'הערה פנימית ראשונה' };
  assert.equal((await post(YOSI, first)).status, 200);
  assert.deepEqual(await row(w, 12), { legal_cleared: true, legal_cleared_by: YOSI, has_time: true, legal_note: 'הערה פנימית ראשונה', offered: false });
  const afterFirst = await events(w, 12); assert.equal(afterFirst.length, 1);
  assert.deepEqual(afterFirst[0].detail, { cleared: true, was_cleared: false, basis: 'reported', source_kind: 'written_opinion', source: 'חוות דעת של משרד עורכי דין, מתאריך 05.11.2026', approved_on: '2026-11-05' });
  assert.equal(afterFirst[0].actor, YOSI);
  assert.equal((await post(AVI, { cleared: false, expected_cleared: true, reason: 'נמצא פגם בנוסח', note: 'ביטול הרישום: נמצא פגם בנוסח' })).status, 200);
  assert.deepEqual(await row(w, 12), { legal_cleared: false, legal_cleared_by: null, has_time: false, legal_note: 'ביטול הרישום: נמצא פגם בנוסח', offered: false });
  assert.equal((await post(AVI, { cleared: true, expected_cleared: false, source_kind: 'email', source: 'אישור בדוא״ל מהיועץ המשפטי', approved_on: '2026-11-09', note: 'הערה שנייה' })).status, 200);
  assert.deepEqual(await row(w, 12), { legal_cleared: true, legal_cleared_by: AVI, has_time: true, legal_note: 'הערה שנייה', offered: false }, 'the row is only the current state: the first note is gone from it');
  assert.equal((await post(YOSI, { cleared: false, expected_cleared: true, reason: 'הושהה לבקשת היועץ' })).status, 200);
  assert.deepEqual(await row(w, 12), { legal_cleared: false, legal_cleared_by: null, has_time: false, legal_note: null, offered: false });
  const all = await events(w, 12);
  assert.deepEqual(all.map((e) => [e.actor, e.detail]), [
    [YOSI, { cleared: true, was_cleared: false, basis: 'reported', source_kind: 'written_opinion', source: 'חוות דעת של משרד עורכי דין, מתאריך 05.11.2026', approved_on: '2026-11-05' }],
    [AVI, { cleared: false, was_cleared: true, reason: 'נמצא פגם בנוסח' }],
    [AVI, { cleared: true, was_cleared: false, basis: 'reported', source_kind: 'email', source: 'אישור בדוא״ל מהיועץ המשפטי', approved_on: '2026-11-09' }],
    [YOSI, { cleared: false, was_cleared: true, reason: 'הושהה לבקשת היועץ' }]]);
  assert.deepEqual(all[0], afterFirst[0], 'the first event is exactly what it was, after three more events');
  const times = (await w.owner("SELECT created_at FROM audit_log WHERE action = 'catalog.service.clearance' ORDER BY id")).map((r) => new Date(r.created_at).getTime());
  assert.equal(times.length, 4); assert.ok(times.every((t, i) => !Number.isNaN(t) && (i === 0 || t >= times[i - 1])), 'every event has its own time, in order');
  // the history the screens read: all four, newest first, each with its facts, for both owners
  for (const who of [YOSI, AVI]) {
    const h = await w.call('GET', '/catalog/history?entity=service&entity_id=12&limit=200', who); assert.equal(h.status, 200);
    const clr = h.body.history.filter((x) => x.action === 'catalog.service.clearance'); assert.deepEqual(clr.map((x) => [x.actor, x.detail.cleared]), [[YOSI, false], [AVI, true], [AVI, false], [YOSI, true]]);
    assert.equal(clr[3].detail.source, 'חוות דעת של משרד עורכי דין, מתאריך 05.11.2026'); assert.equal(clr[3].detail.approved_on, '2026-11-05'); assert.ok(clr.every((x) => x.created_at));
  }
  await w.pg.close();
});

test('a registration with nothing but the confirmation, and a cancellation without a reason, are recorded as they are: what was not given is not made up', async () => {
  const w = await ready(13); const post = (body) => w.call('POST', CLEARANCE(13), AVI, j(body));
  assert.equal((await post({ cleared: true, expected_cleared: false })).status, 200);
  assert.equal((await post({ cleared: false, expected_cleared: true })).status, 200);
  assert.deepEqual((await events(w, 13)).map((e) => e.detail), [{ cleared: true, was_cleared: false, basis: 'reported' }, { cleared: false, was_cleared: true }]);
  assert.deepEqual(await row(w, 13), { legal_cleared: false, legal_cleared_by: null, has_time: false, legal_note: null, offered: false });
  // empty, blank or null values are "not given", and leave no key at all
  assert.equal((await post({ cleared: true, expected_cleared: false, source_kind: null, source: '   ', approved_on: '', note: '' })).status, 200);
  assert.deepEqual((await events(w, 13)).pop().detail, { cleared: true, was_cleared: false, basis: 'reported' });
  await w.pg.close();
});

test('limits and odd data: lengths at the limit and one over, dates that do not exist, wrong types, fields that do not belong to the event; a refused request writes nothing at all', async () => {
  const w = await ready(14); const post = (body) => w.call('POST', CLEARANCE(14), YOSI, j(body)); const DATA = ['service_settings', 'audit_log'];
  const refused = async (body, code, label) => { const before = await w.fingerprint(DATA), r = await post(body); assert.deepEqual([r.status, r.body.error], [400, code], label || JSON.stringify(body).slice(0, 80)); assert.deepEqual(await w.fingerprint(DATA), before, 'nothing written: ' + (label || code)); };
  const reg = { cleared: true, expected_cleared: false };
  // lengths
  await refused({ ...reg, source: 'א'.repeat(201) }, 'bad_source', 'source 201'); await refused({ ...reg, note: 'א'.repeat(601) }, 'bad_note', 'note 601');
  await refused({ cleared: false, expected_cleared: true, reason: 'א'.repeat(301) }, 'bad_clearance_reason', 'reason 301');
  // wrong types and unknown values
  for (const v of [123, true, {}, [], ['x']]) { await refused({ ...reg, source: v }, 'bad_source', 'source ' + JSON.stringify(v)); await refused({ cleared: false, expected_cleared: true, reason: v }, 'bad_clearance_reason', 'reason ' + JSON.stringify(v)); }
  for (const v of ['legal', 7, {}, '', 'WRITTEN_OPINION', 'written_opinion ']) await refused({ ...reg, source_kind: v }, 'bad_source_kind', 'kind ' + JSON.stringify(v));
  // dates that do not exist, are written the wrong way, are in the future or long ago
  for (const v of ['2026-02-30', '2026-13-01', '05.11.2026', '2026/11/05', '20261105', 20261105, '2999-01-01', '1999-12-31', 'yesterday', {}, [], '2026-11-05T00:00:00Z', ' 2026-11-05']) await refused({ ...reg, approved_on: v }, 'bad_approved_on', 'date ' + JSON.stringify(v));
  // fields that belong to the other event, and fields nobody may send
  await refused({ ...reg, reason: 'סיבה' }, 'field_not_for_registration'); for (const f of [{ source: 'x' }, { source_kind: 'email' }, { approved_on: '2026-11-05' }]) await refused({ cleared: false, expected_cleared: true, ...f }, 'field_not_for_cancellation', JSON.stringify(f));
  for (const f of [{ legal_cleared_by: 'someone-else' }, { actor: 'x' }, { basis: 'verified' }, { created_at: '2020-01-01' }, { offered: true }, { was_cleared: true }]) await refused({ ...reg, ...f }, 'unknown_field', JSON.stringify(f));
  await refused({ cleared: 'true', expected_cleared: false }, 'bad_cleared'); await refused({ cleared: true }, 'expected_required'); await refused({ cleared: true, expected_cleared: 0 }, 'expected_required'); await refused('nope', 'bad_body'); await refused([], 'bad_body');
  // exactly at the limits is fine
  const edge = { ...reg, source: 'א'.repeat(200), note: 'ב'.repeat(600), approved_on: '2000-01-01' }; assert.equal((await post(edge)).status, 200);
  const e1 = (await events(w, 14)).pop(); assert.equal(e1.detail.source.length, 200); assert.equal(e1.detail.approved_on, '2000-01-01'); assert.equal((await row(w, 14)).legal_note.length, 600, 'the long remark is in the row, in full');
  assert.equal((await post({ cleared: false, expected_cleared: true, reason: 'ג'.repeat(300) })).status, 200); assert.equal((await events(w, 14)).pop().detail.reason.length, 300);
  const today = new Date().toISOString().slice(0, 10); assert.equal((await post({ ...reg, approved_on: today })).status, 200, 'today is allowed');
  await w.pg.close();
});

test('the journal never receives a contact detail, an identity number or a link; look-alikes that are only dates or short numbers are accepted; invisible and markup characters are removed', async () => {
  const w = await ready(13);
  const reg = (extra) => w.call('POST', CLEARANCE(13), YOSI, j({ cleared: true, expected_cleared: false, ...extra }));
  const can = (extra) => w.call('POST', CLEARANCE(13), YOSI, j({ cleared: false, expected_cleared: true, ...extra }));
  const bad = ['dana@example.test', 'ראו דנה dana@example.test', '0501234567', '050-123-4567', '050 123 4567', '03-1234567', '03 123 4567', '+972 50 123 4567', '+97250-123-4567', '123456789', 'ת״ז 123456789', '1234567', 'https://drive.example.test/doc/abc', 'HTTP://x.test', 'www.example.test/file', 'ftp-less www.x.test', '0 5 0 1 2 3 4 5 6 7', '050 12 34 567', '٠٥٠١٢٣٤٥٦٧', '０５０１２３４５６７', 'dana＠example.test', '٠٥٠-١٢٣-٤٥٦٧', '1 2 3 4 5 6 7 8 9'];
  for (const text of bad) {
    const before = await w.fingerprint(['service_settings', 'audit_log']);
    assert.equal((await reg({ source: text })).body.error, 'source_has_contact_detail', 'source: ' + text);
    assert.equal((await can({ reason: text })).body.error, 'reason_has_contact_detail', 'reason: ' + text);
    assert.deepEqual(await w.fingerprint(['service_settings', 'audit_log']), before, 'nothing written: ' + text);
  }
  // a refused text is refused even when it hides inside a longer sentence, in the middle of invisible characters, or in another letter case
  assert.equal((await reg({ source: 'מכתב מ​-dana@​example.test בדוא״ל' })).body.error, 'source_has_contact_detail', 'invisible characters do not hide it');
  assert.equal((await reg({ source: 'מכתב. ' + 'א'.repeat(120) + ' 0501234567' })).body.error, 'source_has_contact_detail');
  // what is only a date or a short number is fine
  for (const text of ['מכתב מיום 05.11.2026', '2026-11-05', 'מכתב מספר 1234', 'סעיף 12(ב), 12/03/2026', '1.1.2026–31.12.2026', 'חוות דעת 2026/14', 'עמוד 3 מתוך 12']) {
    assert.equal((await reg({ source: text })).status, 200, text); assert.equal((await events(w, 13)).pop().detail.source, text);
    assert.equal((await can({ reason: text })).status, 200, text); assert.equal((await events(w, 13)).pop().detail.reason, text);
  }
  // markup, control and invisible characters
  assert.equal((await reg({ source: 'מכתב‮​‍אישור⁦ <b>x</b>\u0007 \n\t סוף' })).status, 200);
  const stored = (await events(w, 13)).pop().detail.source; assert.equal(INVISIBLE.test(stored), false); assert.doesNotMatch(stored, /[<>\u0000-\u001f]/); assert.equal(stored, 'מכתבאישור b x /b סוף', 'invisible characters are removed, not turned into spaces');
  assert.equal((await can({ reason: '​‮  ‏' })).status, 200, 'only invisible characters is "not given"'); assert.deepEqual((await events(w, 13)).pop().detail, { cleared: false, was_cleared: true });
  await w.pg.close();
});

test('the journal holds structured facts, never the remark: the long note stays in the row, and no contact detail, remark or markup is in any journal row of the clearance', async () => {
  const w = await ready(12); const remark = 'הערה פנימית ארוכה מאוד על המסמך, ' + 'ט'.repeat(400);
  assert.equal((await w.call('POST', CLEARANCE(12), YOSI, j({ cleared: true, expected_cleared: false, source_kind: 'meeting_summary', source: 'סיכום פגישה', approved_on: '2026-11-01', note: remark }))).status, 200);
  assert.equal((await row(w, 12)).legal_note, remark, 'the remark is in the row, as before');
  const log = JSON.stringify(await w.audits("action = 'catalog.service.clearance'")); assert.equal(log.includes('הערה פנימית ארוכה'), false, 'the remark is not in the journal'); assert.equal(log.includes('טטטטט'), false);
  assert.equal(Object.prototype.hasOwnProperty.call((await events(w, 12))[0].detail, 'note'), false, 'there is no remark key in the journal');
  for (const e of await events(w, 12)) { const d = JSON.stringify(e.detail); assert.doesNotMatch(d, /@|\d{7,}|https?:|www\./, 'no contact shape in the facts'); assert.deepEqual(Object.keys(e.detail).filter((k) => !['cleared', 'was_cleared', 'basis', 'source_kind', 'source', 'approved_on', 'reason'].includes(k)), [], 'only the documented keys'); }
  await w.pg.close();
});

test('who can read these facts: only the owners, through the catalog routes; the older audit list gives no detail to anyone; the application cannot change or delete a journal row', async () => {
  const w = await ready(12); await w.call('POST', CLEARANCE(12), YOSI, j({ cleared: true, expected_cleared: false, source_kind: 'written_opinion', source: 'מכתב מיום 05.11.2026', approved_on: '2026-11-05' }));
  const hist = '/catalog/history?entity=service&entity_id=12', card = '/catalog/services/12';
  // not signed in, signed in but not an owner, switch closed: no facts at all
  for (const p of [hist, card, '/catalog/history']) {
    assert.equal((await w.call('GET', p, null)).status, 401, p + ' anonymous'); const out = await w.call('GET', p, STRANGER); assert.deepEqual([out.status, out.body.error], [403, 'forbidden'], p + ' not an owner'); assert.equal(JSON.stringify(out.body).includes('05.11.2026'), false);
  }
  await w.setSetting('private.catalog_enabled', false); for (const who of [YOSI, AVI]) { const r = await w.call('GET', hist, who); assert.deepEqual([r.status, r.body.error], [403, 'catalog_disabled']); assert.equal(JSON.stringify(r.body).includes('05.11.2026'), false); } await w.open();
  assert.equal((await w.call('GET', hist, YOSI)).body.history.some((x) => x.detail && x.detail.source === 'מכתב מיום 05.11.2026'), true, 'an owner reads it');
  // the older audit list (owners only as well) has columns without the detail
  assert.equal((await w.call('GET', '/audit', STRANGER)).status, 403, 'and it is not open to someone who is not an owner either');
  for (const who of [YOSI, AVI]) { const r = await w.call('GET', '/audit', who); assert.equal(r.status, 200); assert.ok(r.body.audit.length > 0); for (const x of r.body.audit) assert.deepEqual(Object.keys(x).sort(), ['action', 'actor', 'created_at', 'entity', 'entity_id']); assert.equal(JSON.stringify(r.body).includes('05.11.2026'), false, 'no source in the older list'); }
  // the journal is append-only for the application: grants and a real attempt
  await assert.rejects(w.pg.query("UPDATE audit_log SET detail = '{}'::jsonb"), /permission denied/); await assert.rejects(w.pg.query('DELETE FROM audit_log'), /permission denied/); await assert.rejects(w.pg.query('TRUNCATE audit_log'), /permission denied/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'kaspchem-grants.js'), 'utf8'), /audit_log: 'INSERT,SELECT'/);
  assert.equal((await events(w, 12)).length, 1, 'the event is still there');
  await w.pg.close();
});

test('nothing is recorded by itself, and nothing here is a verification: no clearance appears from creating settings, from a refused request, from an engagement or from a repeat; the signed-in owner is the reporter; a second identical request writes no second event', async () => {
  const w = await ready(13);
  assert.deepEqual(await row(w, 13), { legal_cleared: false, legal_cleared_by: null, has_time: false, legal_note: null, offered: false });
  assert.equal((await events(w, 13)).length, 0, 'creating the settings is not a registration');
  const url = CLEARANCE(13), post = (who, body) => w.call('POST', url, who, j(body));
  assert.equal((await post(YOSI, { cleared: false, expected_cleared: true })).body.error, 'conflict', 'cancelling what was never reported'); assert.equal((await events(w, 13)).length, 0);
  assert.equal((await post(YOSI, { cleared: true, expected_cleared: false, source_kind: 'email' })).status, 200);
  assert.equal((await post(YOSI, { cleared: true, expected_cleared: false, source_kind: 'email' })).body.error, 'conflict', 'a repeat (a double click, a second tab) is refused'); assert.equal((await events(w, 13)).length, 1, 'no second event');
  // a request that changes nothing is refused: it would only add an empty event, and the first kind would replace the reporter without a cancellation in between
  for (const [who, body] of [[AVI, { cleared: true, expected_cleared: true, source: 'x' }], [AVI, { cleared: false, expected_cleared: false, reason: 'x' }]]) { const before = await w.fingerprint(['service_settings', 'audit_log']); assert.equal((await post(who, body)).body.error, 'nothing_to_change', JSON.stringify(body)); assert.deepEqual(await w.fingerprint(['service_settings', 'audit_log']), before); }
  assert.equal((await row(w, 13)).legal_cleared_by, YOSI, 'the reporter is the one who registered, never a name from the request'); assert.equal((await events(w, 13))[0].actor, YOSI);
  assert.equal((await row(w, 13)).offered, false, 'a reported clearance never offers anything to the public');
  await w.pg.close();
});

test('a cancellation is refused while an engagement of the service is active, and the refusal leaves no event; once nothing is active it is recorded', async () => {
  const w = await world(); await w.open(); const DATA = ['service_settings', 'audit_log'];   // service 11 is seeded as reported-cleared, with an engagement
  await w.owner("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 21 AND service_id = 11");
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE service_id = 11 AND activation = 'active'"))[0].n, 1);
  const before = await w.fingerprint(DATA), r = await w.call('POST', CLEARANCE(11), AVI, j({ cleared: false, expected_cleared: true, reason: 'x' })); assert.deepEqual([r.status, r.body.error], [409, 'active_engagements_exist']); assert.deepEqual(await w.fingerprint(DATA), before);
  await w.owner("UPDATE provider_services SET activation = 'paused' WHERE professional_id = 21 AND service_id = 11");
  assert.equal((await w.call('POST', CLEARANCE(11), AVI, j({ cleared: false, expected_cleared: true, reason: 'הוצא משימוש' }))).status, 200);
  assert.deepEqual((await events(w, 11)).map((e) => [e.actor, e.detail]), [[AVI, { cleared: false, was_cleared: true, reason: 'הוצא משימוש' }]]);
  await w.pg.close();
});
