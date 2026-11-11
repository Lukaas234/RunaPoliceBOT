"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAudit = sendAudit;
exports.sendCommunityAudit = sendCommunityAudit;
exports.recordSystemError = recordSystemError;
const db_1 = require("./db");
const db_2 = require("./db");
const server_defaults_1 = require("./server-defaults");
async function sendAudit(client, message, locale = 'en') {
    const fallback = locale === 'es' ? server_defaults_1.DEFAULT_ES_LOG_CHANNEL_ID : server_defaults_1.DEFAULT_LOG_CHANNEL_ID;
    const channelId = (0, db_1.getLocalizedSetting)('logChannelId', locale, fallback) || fallback;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased() && 'send' in channel)
            await channel.send({ content: message.slice(0, 1900), allowedMentions: { parse: [] } });
    }
    catch (error) {
        console.error('Could not send Discord audit log', error);
    }
}
async function sendCommunityAudit(client, message) {
    try {
        const channel = await client.channels.fetch(server_defaults_1.DEFAULT_COMMUNITY_LOG_CHANNEL_ID);
        if (channel?.isTextBased() && 'send' in channel)
            await channel.send({ content: message.slice(0, 1900), allowedMentions: { parse: [] } });
        else
            console.error(`Community audit channel ${server_defaults_1.DEFAULT_COMMUNITY_LOG_CHANNEL_ID} is not a text channel.`);
    }
    catch (error) {
        console.error('Could not send community audit log', error);
    }
}
function recordSystemError(client, error, context) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(context, error);
    try {
        db_2.db.prepare('INSERT INTO admin_events(actor_id,type,detail,created_at) VALUES(?,?,?,?)').run('system', 'system_error', `${context}: ${message}`.slice(0, 2000), new Date().toISOString());
    }
    catch (logError) {
        console.error('Could not persist system error', logError);
    }
    void sendAudit(client, `**system_error** · ${context}: ${message}`);
}
