// E2E + visual tests run against the local test server (in-memory Postgres). They never touch production or any real database.
const { defineConfig } = require('@playwright/test');

const channel = process.env.PW_CHANNEL || 'msedge'; // system Edge/Chrome: no browser download needed
const sizes = { 'mobile-360': [360, 740], 'mobile-390': [390, 844], 'tablet-768': [768, 1024], 'desktop-1440': [1440, 900] };

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // The pages load Google Fonts. A stalled request to those hosts (seen in a kept trace: the stylesheet answered after 2.8 s, the font files never did, and page.goto waited 60 s for the load event)
  // made tests fail at random, so tests never talk to them: the names do not resolve, the request fails at once and the system fonts are used.
  use: { baseURL: 'http://localhost:4180', channel, locale: 'he-IL', trace: 'retain-on-failure', launchOptions: { args: ['--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND'] } },
  webServer: { command: 'node tests/dev-server.js', env: { PORT: '4180' }, url: 'http://localhost:4180/kaspchem', reuseExistingServer: false, timeout: 60000 },
  projects: Object.entries(sizes).map(([name, [width, height]]) => ({ name, use: { viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700 } }))
});
