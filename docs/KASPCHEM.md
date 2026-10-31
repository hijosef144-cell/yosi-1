# כספכם (Kaspchem)

Standalone product inside matzpenkalkali.com. Static pages + Netlify Functions + a dedicated Neon Postgres.

| Path | What |
|---|---|
| `/kaspchem` | public landing (10 tiles) |
| `/kaspchem/check/<topic>` | questionnaire → result → lead form (all on one screen) |
| `/admin/kaspchem/` | admin dashboard (Netlify Identity, role `admin`) |
| `/api/kaspchem/{config,lead,admin/*}` | functions in `netlify/functions/kaspchem-*.js` |

## Local development & tests (no real DB, no production)
- `node tests/dev-server.js` serves everything on :4173 with an in-memory Postgres (PGlite). Admin locally: `/admin/kaspchem/?test=yosi@example.test|admin`.
- `node --test tests/backend.test.js` and `npx playwright test` (4 widths: 360/390/768/1440; uses system Edge, set `PW_CHANNEL=chrome` to change). Screenshots land in `tests/shots/`.
- Questionnaire seed: edit `scripts/gen-kaspchem-seed.js`, run it, it rewrites `kaspchem/content/topics.json`.

## Environment variables (Netlify → Site settings; never commit)
`KASPCHEM_DATABASE_URL` (dedicated Neon DB), `KASPCHEM_ADMIN_EMAILS` (comma list: you + your father), `KASPCHEM_HASH_SALT` (random string), optional `KASPCHEM_NOTIFY_EMAILS` (+ existing `GMAIL_USER`/`GMAIL_APP_PASSWORD`; notification mail contains no personal data).

## Launch checklist
1. Create a NEW Neon project/database for Kaspchem only; set `KASPCHEM_DATABASE_URL`; run `node scripts/kaspchem-migrate.js` (it refuses to run against a DB holding non-Kaspchem tables).
2. Netlify Identity: registration = **Invite only**; invite two users; set each user's role `admin` (Identity → user → app_metadata roles).
3. Node 24 is set in `netlify.toml` (Neon driver needs >=19, Node 18) — verify the existing site still deploys on a deploy preview first.
4. Have a lawyer finalize `privacy.html` / `terms.html` (marked DRAFT) and the consent wording; if the wording changes, bump `CONSENT_VERSION` in `kaspchem-lead.js`.
5. Settings → charity name (only with the organization's approval).
6. Deploy preview → test → production. Rollback: Netlify "Publish deploy" on the previous deploy; questionnaires roll back from the admin (versions list).

## Rules baked in
- Outcome is recomputed on the server from stored rules; the browser's claim is ignored.
- No prices are seeded. A price is public only if approved + public (DB CHECK constraint); editing resets approval.
- Revenue counts only after approval. Audit log on every admin write.
