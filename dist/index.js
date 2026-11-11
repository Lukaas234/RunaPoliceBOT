"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const db_1 = require("./db");
const discord_1 = require("./discord");
const web_1 = require("./web");
const audit_1 = require("./audit");
async function main() {
    console.log(`Persistent SQLite database: ${db_1.DATABASE_FILE}`);
    if (config_1.config.bootstrapAdminRoleIds.length)
        (0, db_1.setSetting)('bootstrapAdminRoleIds', config_1.config.bootstrapAdminRoleIds);
    await (0, discord_1.startDiscord)();
    await (0, discord_1.ensureTicketResponderRoleAccess)(discord_1.client);
    await (0, discord_1.registerCommands)();
    void (0, discord_1.refreshPanel)(discord_1.client).catch(error => (0, audit_1.recordSystemError)(discord_1.client, error, 'Default ticket panel setup'));
    const app = (0, web_1.createWebApp)(discord_1.client);
    const server = app.listen(config_1.config.PORT, config_1.config.HOST, () => console.log(`Web panel listening on ${config_1.config.HOST}:${config_1.config.PORT}`));
    const stop = async (signal) => {
        console.log(`Received ${signal}; shutting down cleanly.`);
        server.close();
        await discord_1.client.destroy();
        try {
            db_1.db.pragma('wal_checkpoint(TRUNCATE)');
            db_1.db.close();
        }
        catch (e) {
            console.error('Database shutdown issue', e);
        }
        process.exit(0);
    };
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
    process.on('unhandledRejection', e => (0, audit_1.recordSystemError)(discord_1.client, e, 'Unhandled rejection'));
    process.on('uncaughtException', e => { (0, audit_1.recordSystemError)(discord_1.client, e, 'Uncaught exception'); process.exit(1); });
}
main().catch(error => { console.error('Application startup failed', error); process.exit(1); });
