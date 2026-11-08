"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReactionRolePanels = getReactionRolePanels;
exports.saveReactionRolePanels = saveReactionRolePanels;
const db_1 = require("./db");
function getReactionRolePanels() {
    const current = (0, db_1.getSetting)('reactionRolePanels', null);
    if (Array.isArray(current))
        return current;
    const legacy = (0, db_1.getSetting)('reactionRolePanel', null);
    return legacy?.messageId ? [legacy] : [];
}
function saveReactionRolePanels(panels) {
    (0, db_1.setSetting)('reactionRolePanels', panels);
}
