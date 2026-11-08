'use strict';

// Bot-Hosting's Node runtime defaults to /home/container/index.js.
// Keep that entry point stable while the TypeScript application lives in dist/.
require('./dist/index.js');
