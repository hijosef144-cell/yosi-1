'use strict';
// The migration files as they stood after migration 002 (001-base, 002-provider-catalog): the real files, nothing else. Many tests describe THAT state (a database right after 002, the grant step that is applied then); migration 003
// has its own tests (tests/migrate-003.test.js). The files are copied into a temporary folder with a manifest made for them, and loaded the way the runner loads the real folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../scripts/kaspchem-migrate.js');
function upTo002() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-002-'));
  fs.copyFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '002-provider-catalog.sql'), path.join(dir, '002-provider-catalog.sql'));
  const first = M.loadMigrations({ dir });   // no manifest yet: only to compute the fingerprint of the real file
  fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), M.manifestText(first.migrations));
  const lm = M.loadMigrations({ dir });
  if (lm.problems.length) throw new Error('the 002 state is not loadable: ' + lm.problems.join('; '));
  return lm;
}
module.exports = { upTo002 };
