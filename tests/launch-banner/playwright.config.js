// Launch-banner e2e. Everything is local: a static server for the repo, a fake CRM that speaks the waitlist contract,
// and (separately) the real CRM app on in-memory Postgres. Nothing here touches production or a real database.
const { defineConfig } = require('@playwright/test');
const channel = process.env.PW_CHANNEL || 'msedge'; // system Edge/Chrome: no browser download needed

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  timeout: 90000,
  workers: Number(process.env.PW_WORKERS) || 3,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4190', channel, locale: 'he-IL', trace: 'retain-on-failure',
    // Google Fonts never load in tests (deterministic timing); system fonts are used.
    launchOptions: { args: ['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND', '--disable-quic', '--disable-http2'] }
  },
  webServer: [
    { command: 'node server.js', cwd: __dirname, env: { PORT: '4190' }, url: 'http://127.0.0.1:4190/privacy', reuseExistingServer: true, timeout: 30000 },
    { command: 'node fake-crm.js', cwd: __dirname, env: { PORT: '4191' }, url: 'http://127.0.0.1:4191/__health', reuseExistingServer: true, timeout: 30000 }
  ]
});
