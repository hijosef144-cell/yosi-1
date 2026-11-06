'use strict';
const { HttpError } = require('./http');

// Authorization for the admin API. `user` comes from Netlify Identity (verified by the platform), shape { email, roles }.
// Fail closed: the allow-list (set only in Netlify's environment) is mandatory. A role check is added when KASPCHEM_REQUIRE_ROLE=1.
function authorizeAdmin(user) {
  if (!user || !user.email) throw new HttpError(401, 'unauthenticated');
  const allow = (process.env.KASPCHEM_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length || allow.indexOf(String(user.email).toLowerCase()) === -1) throw new HttpError(403, 'forbidden');
  if (process.env.KASPCHEM_REQUIRE_ROLE === '1' && (user.roles || []).indexOf('admin') === -1) throw new HttpError(403, 'forbidden');
  return { email: String(user.email).toLowerCase() };
}

module.exports = { authorizeAdmin };
