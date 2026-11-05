// End-to-end: the real banner on the real pages, talking to the REAL CRM app on in-memory Postgres (see real-crm.js).
// The page is served by the static server on 4190; real-crm.js rebuilds the CRM app with that origin allowed in CORS (test-only env).
// Local only. No production database, no real mail.
const { defineConfig } = require('@playwright/test');
const channel = process.env.PW_CHANNEL || 'msedge';

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /real-crm\.spec\.js/,
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4190', channel, locale: 'he-IL', trace: 'retain-on-failure',
    launchOptions: { args: ['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND', '--disable-quic', '--disable-http2'] }
  },
  webServer: [
    { command: 'node server.js', cwd: __dirname, env: { PORT: '4190' }, url: 'http://127.0.0.1:4190/privacy', reuseExistingServer: true, timeout: 30000 },
    { command: 'node real-crm.js', cwd: __dirname, url: 'http://127.0.0.1:4193/__health', reuseExistingServer: true, timeout: 120000 }
  ]
});
