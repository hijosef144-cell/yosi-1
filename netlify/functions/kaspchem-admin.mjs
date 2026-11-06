// Admin API entry (Netlify Functions v2). Auth happens first, before any routing or database access.
import { createRequire } from 'node:module';
import { getUser } from '@netlify/identity';

const require = createRequire(import.meta.url);
const { run } = require('./_kaspchem/admin-entry.js');

export const config = { path: '/api/kaspchem/admin/*' };

export default async (req) => run(req, getUser);
