"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_1 = require("./discord");
(0, discord_1.registerCommands)().then(() => { console.log('Guild commands registered.'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
