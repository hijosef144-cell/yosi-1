'use strict';
// Internal catalog domains (owner decision 2026-11-11): the sheet of the owners has two domains that are NOT topics of the public check ("עסקים" and "חיסכון והשקעות").
// They are kept as domains of the CATALOG only, so the services of the sheet keep their domain instead of losing it, and nothing else:
//   * they are not in kaspchem/content/topics.json and therefore not in the questionnaires, the routes or any public page;
//   * they publish nothing: a price becomes visible to the public only by an approved AND public price row, which no import ever creates (the import creates no row of the older pricing table at all);
//   * the ids are plain ASCII (the topic of a service is stored as an id, like the ids of the system's own topics).
// Used by the import (R13: a domain NAME in the sheet becomes the id of a system topic or of an internal domain) and by the admin screens (the domain of a service). Pure: no database, no file, no clock.
const INTERNAL_TOPICS = Object.freeze([
  Object.freeze({ id: 'business', name: 'עסקים', internal: true }),
  Object.freeze({ id: 'savings-investments', name: 'חיסכון והשקעות', internal: true }),
]);
const isInternal = (id) => INTERNAL_TOPICS.some((t) => t.id === id);
module.exports = { INTERNAL_TOPICS, isInternal };
