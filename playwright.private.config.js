// Runs the PRIVATE launch tests that live in the gitignored research folder (docs/research/private-tests). Same browsers and widths as the public suite.
// The folder is never committed; scripts/run-launch-tests.js runs this config only when the folder exists in the checkout.
const base = require('./playwright.config.js');
module.exports = Object.assign({}, base, { testDir: './docs/research/private-tests', webServer: undefined });
