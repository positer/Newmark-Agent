// A foreground responsiveness gate must not measure Chromium's 1s occlusion
// timer clamp when the reviewer switches to the test logs in another window.
// These switches apply only to this isolated development test process.
const { app } = require('electron');
const path = require('node:path');
for (const name of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(name);
}
process.argv[1] = path.resolve(__dirname, '../dist/main.js');
require('../dist/main.js');
