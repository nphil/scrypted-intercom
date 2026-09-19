// Same override the Kibble plugin needs against this @scrypted/sdk version: the published
// production config enables webpack module concatenation ("scope hoisting"), which fails to
// bundle the SDK's own `dist/src/index.js` with "Cannot get final name for export
// 'MixinDeviceBase'". Disabling that one optimization avoids it; bundle size is irrelevant here.
const base = require('./node_modules/@scrypted/sdk/webpack.nodejs.config.js');
base.optimization = base.optimization || {};
base.optimization.concatenateModules = false;
module.exports = base;
