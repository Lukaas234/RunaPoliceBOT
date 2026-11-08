"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebApp = createWebApp;
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_zlib_1 = require("node:zlib");
const discord_js_1 = require("discord.js");
const config_1 = require("./config");
const db_1 = require("./db");
const auth_1 = require("./auth");
const tickets_1 = require("./tickets");
const transcripts_1 = require("./transcripts");
const server_defaults_1 = require("./server-defaults");
const discord_1 = require("./discord");
const audit_1 = require("./audit");
const i18n_1 = require("./i18n");
const zod_1 = require("zod");
const categoriesTable = `SELECT id,name,description,emoji,discord_category_id,support_role_ids,enabled,sort_order FROM categories`;
const mutationRoles = ['support', 'supervisor', 'admin'];
const adminRoles = ['admin'];
const parseIntParam = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const urlsafe = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function createWebApp(client) {
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use((0, helmet_1.default)({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'https://cdn.discordapp.com', 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } } }));
    app.use((req, _res, next) => { const raw = req.headers.cookie || ''; req.cookies = Object.fromEntries(raw.split(';').map((s) => s.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p.length === 2).map((p) => [p[0], decodeURIComponent(p[1])])); next(); });
    app.use(express_1.default.json({ limit: '32mb' }));
    const loginLimit = (0, express_rate_limit_1.default)({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
    const apiLimit = (0, express_rate_limit_1.default)({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
    app.use('/auth', loginLimit);
    app.use('/api', apiLimit);
    app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'run-a-police-tickets' }));
    app.get('/auth/discord', (req, res) => {
        const { url } = (0, auth_1.startOAuth)();
        res.cookie('rap_oauth_state', url.split('state=')[1], { httpOnly: true, secure: config_1.config.secureCookies, sameSite: 'lax', path: '/auth', maxAge: 10 * 60_000 });
        res.redirect(url);
    });
    app.get('/auth/callback', async (req, res) => {
        try {
            const code = String(req.query.code || ''), state = String(req.query.state || ''), cookie = req.cookies?.rap_oauth_state;
            console.info(`[OAuth] callback received: code=${!!code} state=${!!state} stateCookie=${!!cookie}`);
            if (!code || !state || !cookie || !node_crypto_1.default.timingSafeEqual(Buffer.from(state), Buffer.from(cookie)))
                throw new Error('Invalid OAuth state. Please sign in again.');
            const result = await (0, auth_1.finishOAuth)(client, code, state);
            (0, auth_1.setSessionCookie)(res, result.cookie);
            res.clearCookie('rap_oauth_state', { path: '/auth' });
            console.info(`[OAuth] session created: user=${result.user.id} role=${result.user.role}`);
            res.redirect('/');
        }
        catch (e) {
            console.error('[OAuth] callback failed:', e instanceof Error ? e.message : 'Unknown error');
            res.status(403).send(`<!doctype html><meta charset="utf-8"><title>Access error</title><p>${urlsafe(e instanceof Error ? e.message : 'Could not sign in.')}</p><a href="/auth/discord">Try again</a>`);
        }
    });
    app.post('/auth/logout', async (req, res) => { await (0, auth_1.requireAuth)(client, req, res, () => { }); if (!req.authUser)
        return; (0, auth_1.clearSession)(req, res); res.json({ ok: true }); });
    const auth = (req, res, next) => (0, auth_1.requireAuth)(client, req, res, next);
    const guild = () => client.guilds.cache.get(config_1.config.DISCORD_GUILD_ID);
    const hasGuildChannel = async (id, types) => {
        const channel = await client.channels.fetch(id).catch(() => null);
        return !!channel && 'guildId' in channel && channel.guildId === config_1.config.DISCORD_GUILD_ID && types.includes(channel.type);
    };
    const hasGuildRoles = async (ids) => {
        if (!ids.length)
            return true;
        const g = await client.guilds.fetch(config_1.config.DISCORD_GUILD_ID);
        await g.roles.fetch().catch(() => undefined);
        return ids.every(id => g.roles.cache.has(id));
    };
    app.get('/api/me', auth, (req, res) => res.json({ user: { id: req.authUser.id, username: req.authUser.username, avatar: req.authUser.avatar, role: req.authUser.role, csrfToken: req.authUser.csrfToken }, guild: { id: config_1.config.DISCORD_GUILD_ID, name: guild()?.name || 'Run a Police' } }));
    app.get('/api/dashboard', auth, (0, auth_1.requireRole)('readonly'), (_req, res) => {
        const counts = db_1.db.prepare(`SELECT COUNT(*) total,SUM(status='open') open,SUM(status='claimed') claimed,SUM(status='closed') closed FROM tickets`).get();
        const languageCounts = db_1.db.prepare("SELECT language,COUNT(*) total,SUM(status='open') open,SUM(status='claimed') claimed,SUM(status='closed') closed FROM tickets GROUP BY language").all();
        const resolution = db_1.db.prepare("SELECT AVG((julianday(closed_at)-julianday(created_at))*86400) sec FROM tickets WHERE closed_at IS NOT NULL").get();
        const response = db_1.db.prepare("SELECT AVG((julianday(e.created_at)-julianday(t.created_at))*86400) sec FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id WHERE e.type='staff_response'").get();
        const ratings = db_1.db.prepare('SELECT AVG(score) avg,COUNT(*) count FROM ratings').get();
        const categoryCounts = db_1.db.prepare(`SELECT c.name,c.emoji,COUNT(t.id) count FROM categories c LEFT JOIN tickets t ON t.category_id=c.id GROUP BY c.id ORDER BY count DESC`).all();
        const recent = db_1.db.prepare(`SELECT t.public_id,t.status,t.priority,t.owner_id,t.created_at,c.name category FROM tickets t LEFT JOIN categories c ON c.id=t.category_id ORDER BY t.id DESC LIMIT 8`).all();
        res.json({ counts: { ...counts, total: counts.total || 0, open: counts.open || 0, claimed: counts.claimed || 0, closed: counts.closed || 0 }, languageCounts, avgResponseSeconds: response.sec ? Math.round(response.sec) : null, avgResolutionSeconds: resolution.sec ? Math.round(resolution.sec) : null, satisfaction: ratings.avg ? Number(ratings.avg.toFixed(2)) : null, ratingCount: ratings.count, categoryCounts, recent });
    });
    app.get('/api/tickets', auth, (0, auth_1.requireRole)('readonly'), (req, res) => {
        const page = Math.min(parseIntParam(req.query.page) || 1, 10000), limit = 25, offset = (page - 1) * limit;
        const where = [], args = [];
        if (typeof req.query.status === 'string' && ['open', 'claimed', 'closed'].includes(req.query.status)) {
            where.push('t.status=?');
            args.push(req.query.status);
        }
        if (typeof req.query.language === 'string' && ['en', 'es'].includes(req.query.language)) {
            where.push('t.language=?');
            args.push(req.query.language);
        }
        if (typeof req.query.category === 'string' && req.query.category.length < 80) {
            where.push('t.category_id=?');
            args.push(req.query.category);
        }
        if (typeof req.query.user === 'string' && /^\d{17,20}$/.test(req.query.user)) {
            where.push('t.owner_id=?');
            args.push(req.query.user);
        }
        if (typeof req.query.staff === 'string' && /^\d{17,20}$/.test(req.query.staff)) {
            where.push('(t.claimed_by=? OR t.closed_by=?)');
            args.push(req.query.staff, req.query.staff);
        }
        if (typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from))) {
            where.push('t.created_at>=?');
            args.push(new Date(req.query.from).toISOString());
        }
        if (typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to))) {
            where.push('t.created_at<=?');
            args.push(new Date(req.query.to).toISOString());
        }
        if (typeof req.query.q === 'string' && req.query.q.length <= 40) {
            where.push('(t.public_id LIKE ? OR t.owner_id LIKE ?)');
            args.push(`%${req.query.q}%`, `%${req.query.q}%`);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rawRows = db_1.db.prepare(`SELECT t.public_id,t.owner_id,t.category_id,t.language,t.status,t.priority,t.claimed_by,t.created_at,t.closed_at,c.name category,
      EXISTS(SELECT 1 FROM transcripts x WHERE x.ticket_id=t.id) has_transcript FROM tickets t LEFT JOIN categories c ON c.id=t.category_id ${clause} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
        const rows = rawRows.map(row => ({ ...row, priority_label: (0, tickets_1.priorityLabel)(row.priority, row.language) }));
        const total = db_1.db.prepare(`SELECT COUNT(*) n FROM tickets t ${clause}`).get(...args).n;
        res.json({ rows, page, limit, total });
    });
    app.get('/api/tickets/:id', auth, (0, auth_1.requireRole)('readonly'), (req, res) => {
        const ticket = (0, tickets_1.getTicket)(String(req.params.id));
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found.' });
        const events = db_1.db.prepare('SELECT actor_id,type,detail,created_at FROM ticket_events WHERE ticket_id=? ORDER BY id DESC LIMIT 200').all(ticket.id);
        const notes = db_1.db.prepare('SELECT author_id,body,created_at FROM ticket_notes WHERE ticket_id=? ORDER BY id DESC LIMIT 100').all(ticket.id);
        const category = db_1.db.prepare('SELECT name FROM categories WHERE id=?').get(ticket.category_id);
        res.json({ ticket, category, events, notes, priority_label: (0, tickets_1.priorityLabel)(ticket.priority, ticket.language), hasTranscript: !!db_1.db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(ticket.id) });
    });
    app.get('/api/tickets/:id/transcript', auth, (0, auth_1.requireRole)('readonly'), (req, res) => {
        const ticket = (0, tickets_1.getTicket)(String(req.params.id));
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found.' });
        const row = db_1.db.prepare('SELECT html FROM transcripts WHERE ticket_id=?').get(ticket.id);
        if (!row)
            return res.status(404).json({ error: 'No transcript is available yet.' });
        const html = Buffer.isBuffer(row.html) ? (0, node_zlib_1.gunzipSync)(row.html) : row.html;
        res.type('html').set('Content-Disposition', `attachment; filename="${ticket.public_id}.html"`).send(html);
    });
    app.post('/api/tickets/:id/transcript', auth, (0, auth_1.requireRole)(...mutationRoles), async (req, res) => {
        const ticket = (0, tickets_1.getTicket)(String(req.params.id));
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found.' });
        const ch = await client.channels.fetch(ticket.channel_id).catch(() => null);
        if (!ch?.isTextBased() || !('messages' in ch))
            return res.status(409).json({ error: 'The channel is no longer available.' });
        try {
            const html = await (0, transcripts_1.generateTranscript)(ticket, ch, req.authUser.id);
            await (0, transcripts_1.sendTranscriptToDiscord)(client, ticket, html);
            res.json({ ok: true, sentToDiscord: true });
        }
        catch (e) {
            console.error(e);
            res.status(502).json({ error: (0, i18n_1.tr)('El transcript quedó guardado en el panel, pero no se pudo enviar al canal configurado.', 'The transcript was saved in the dashboard but could not be sent to the configured channel.') });
        }
    });
    app.post('/api/tickets/:id/notes', auth, (0, auth_1.requireRole)(...mutationRoles), (req, res) => {
        const ticket = (0, tickets_1.getTicket)(String(req.params.id)), parsed = zod_1.z.object({ body: zod_1.z.string().trim().min(1).max(2000) }).safeParse(req.body);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found.' });
        if (!parsed.success)
            return res.status(400).json({ error: 'Invalid note.' });
        const at = new Date().toISOString();
        db_1.db.prepare('INSERT INTO ticket_notes(ticket_id,author_id,body,created_at) VALUES(?,?,?,?)').run(ticket.id, req.authUser.id, parsed.data.body, at);
        (0, tickets_1.addTicketEvent)(ticket, req.authUser.id, 'internal_note');
        res.json({ ok: true });
    });
    app.post('/api/tickets/:id/action', auth, (0, auth_1.requireRole)(...mutationRoles), async (req, res) => {
        const ticket = (0, tickets_1.getTicket)(String(req.params.id)), parsed = zod_1.z.object({ action: zod_1.z.enum(['claim', 'release', 'priority', 'reopen', 'close', 'transfer']), value: zod_1.z.string().max(500).optional() }).safeParse(req.body);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found.' });
        if (!parsed.success)
            return res.status(400).json({ error: 'Invalid action.' });
        const action = parsed.data.action, actor = req.authUser.id;
        let channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
        if (action === 'claim') {
            const result = (0, tickets_1.toggleClaim)(ticket, actor);
            if (result === 'conflict')
                return res.status(409).json({ error: 'This ticket has already been claimed by another staff member.' });
            if (result === 'closed')
                return res.status(409).json({ error: 'Reopen this ticket before claiming it.' });
        }
        if (action === 'release') {
            if (ticket.claimed_by !== actor)
                return res.status(409).json({ error: 'Only the staff member who claimed this ticket can release it.' });
            (0, tickets_1.updateTicket)(ticket, actor, 'released');
        }
        if (action === 'priority') {
            if (!['low', 'normal', 'high', 'urgent'].includes(parsed.data.value || ''))
                return res.status(400).json({ error: 'Invalid priority.' });
            (0, tickets_1.updateTicket)(ticket, actor, 'priority', parsed.data.value);
        }
        if (action === 'reopen') {
            if (ticket.status !== 'closed')
                return res.status(409).json({ error: 'This ticket is not closed.' });
            if (!channel?.isTextBased() || !('permissionOverwrites' in channel)) {
                try {
                    channel = await (0, tickets_1.recreateTicketChannel)(await client.guilds.fetch(ticket.guild_id), ticket);
                }
                catch (error) {
                    console.error('Could not recreate ticket channel', error);
                    return res.status(502).json({ error: (0, i18n_1.tr)('No se pudo recrear el canal del ticket.', 'Could not recreate the ticket channel.') });
                }
            }
            (0, tickets_1.updateTicket)(ticket, actor, 'reopened');
        }
        if (action === 'close')
            (0, tickets_1.updateTicket)(ticket, actor, 'closed', parsed.data.value || 'Closed from the dashboard');
        if (action === 'transfer') {
            const categoryId = parsed.data.value || '';
            const category = db_1.db.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').get(categoryId);
            if (!category)
                return res.status(400).json({ error: 'Invalid destination category.' });
            const display = (0, tickets_1.categoryText)(category.id, category.name, '', ticket.language);
            const oldRoles = (0, tickets_1.supportRoleIdsForCategory)(ticket.category_id), newRoles = (0, tickets_1.supportRoleIdsForCategory)(categoryId);
            if (channel?.isTextBased() && 'permissionOverwrites' in channel) {
                for (const role of oldRoles.filter(id => !newRoles.includes(id)))
                    await channel.permissionOverwrites.delete(role).catch(() => undefined);
                for (const role of newRoles)
                    await channel.permissionOverwrites.edit(role, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => undefined);
                await channel.setParent(category.discord_category_id || null).catch(() => undefined);
                await channel.setTopic(`Ticket ${ticket.public_id} · ${display.name}`).catch(() => undefined);
            }
            (0, tickets_1.updateTicket)(ticket, actor, 'transferred', categoryId);
        }
        if (channel?.isTextBased() && 'send' in channel)
            await channel.send((0, i18n_1.localized)(ticket.language, `Ticket actualizado desde el panel por <@${actor}>: **${action}**${parsed.data.value ? ` · ${urlsafe(parsed.data.value)}` : ''}`, `Ticket updated from the dashboard by <@${actor}>: **${action}**${parsed.data.value ? ` · ${urlsafe(parsed.data.value)}` : ''}`)).catch(() => undefined);
        if (action === 'close' && channel?.isTextBased() && 'messages' in channel) {
            const closed = db_1.db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id);
            try {
                await (0, transcripts_1.generateTranscript)(closed, channel, actor);
            }
            catch (e) {
                console.error('Panel transcript failed', e);
                return res.status(502).json({ error: 'Transcript could not be saved; the channel was kept.' });
            }
            const transcriptRow = db_1.db.prepare('SELECT html FROM transcripts WHERE ticket_id=?').get(ticket.id);
            try {
                const { gunzipSync } = await Promise.resolve().then(() => __importStar(require('node:zlib')));
                const html = transcriptRow ? (Buffer.isBuffer(transcriptRow.html) ? gunzipSync(transcriptRow.html).toString('utf8') : String(transcriptRow.html)) : '';
                if (!html)
                    throw new Error('Transcript not found after generation.');
                await (0, transcripts_1.sendTranscriptToDiscord)(client, closed, html);
            }
            catch (e) {
                console.error('Transcript forwarding failed', e);
                return res.status(502).json({ error: (0, i18n_1.tr)('El transcript quedó guardado en el panel, pero no se pudo enviar al canal configurado; se conserva el canal del ticket.', 'The transcript was saved in the dashboard but could not be sent to the configured channel; the ticket channel was kept.') });
            }
            await channel.send((0, i18n_1.localized)(ticket.language, `Ticket ${ticket.public_id} cerrado. La transcripción se guardó en el panel.`, `Ticket ${ticket.public_id} closed. The transcript was saved to the dashboard.`)).catch(() => undefined);
            try {
                await channel.delete(`Ticket ${ticket.public_id} closed; transcript saved`);
            }
            catch (e) {
                console.error('Could not delete closed ticket channel', e);
                return res.status(502).json({ error: (0, i18n_1.tr)('El transcript se guardó, pero no se pudo borrar el canal. Verifica que el bot tenga Administrar canales.', 'Transcript saved, but the channel could not be deleted. Check the bot’s Manage Channels permission.') });
            }
        }
        if (action === 'reopen' && channel?.isTextBased() && 'messages' in channel) {
            await channel.permissionOverwrites.edit(ticket.owner_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => undefined);
            await channel.setName(`ticket-${ticket.public_id.toLowerCase()}`).catch(() => undefined);
        }
        void (0, audit_1.sendAudit)(client, `**ticket_${action}** · ${ticket.public_id} · ${actor}${parsed.data.value ? ` · ${parsed.data.value}` : ''}`, ticket.language);
        res.json({ ok: true });
    });
    app.get('/api/categories', auth, (0, auth_1.requireRole)('readonly'), (_req, res) => res.json(db_1.db.prepare(`${categoriesTable} ORDER BY sort_order,id`).all()));
    app.put('/api/categories/:id', auth, (0, auth_1.requireRole)('admin'), async (req, res) => {
        const parsed = zod_1.z.object({ name: zod_1.z.string().trim().min(1).max(80), description: zod_1.z.string().max(200), emoji: zod_1.z.string().max(32), discordCategoryId: zod_1.z.string().regex(/^\d{17,20}$/).nullable(), supportRoleIds: zod_1.z.array(zod_1.z.string().regex(/^\d{17,20}$/)).max(20), enabled: zod_1.z.boolean(), sortOrder: zod_1.z.number().int().min(0).max(1000) }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: 'Invalid category data.' });
        const c = parsed.data;
        if (c.discordCategoryId && !await hasGuildChannel(c.discordCategoryId, [discord_js_1.ChannelType.GuildCategory]))
            return res.status(400).json({ error: 'The Discord category does not exist in Run a Police.' });
        if (!await hasGuildRoles(c.supportRoleIds))
            return res.status(400).json({ error: 'One or more roles do not belong to Run a Police.' });
        db_1.db.prepare('UPDATE categories SET name=?,description=?,emoji=?,discord_category_id=?,support_role_ids=?,enabled=?,sort_order=? WHERE id=?')
            .run(c.name, c.description, c.emoji, c.discordCategoryId, JSON.stringify(c.supportRoleIds), Number(c.enabled), c.sortOrder, String(req.params.id));
        addAdminLog(client, req.authUser.id, 'category_updated', String(req.params.id));
        void (0, discord_1.refreshPanel)(client).catch(e => console.error('Could not refresh ticket panel', e));
        res.json({ ok: true });
    });
    app.post('/api/categories', auth, (0, auth_1.requireRole)('admin'), async (req, res) => {
        const parsed = zod_1.z.object({ id: zod_1.z.string().regex(/^[a-z0-9-]{2,40}$/), name: zod_1.z.string().trim().min(1).max(80), description: zod_1.z.string().max(200), emoji: zod_1.z.string().max(32), discordCategoryId: zod_1.z.string().regex(/^\d{17,20}$/).nullable().default(null), supportRoleIds: zod_1.z.array(zod_1.z.string().regex(/^\d{17,20}$/)).max(20).default([]) }).safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: 'Invalid category data.' });
        if (parsed.data.discordCategoryId && !await hasGuildChannel(parsed.data.discordCategoryId, [discord_js_1.ChannelType.GuildCategory]))
            return res.status(400).json({ error: 'The Discord category does not exist in Run a Police.' });
        if (!await hasGuildRoles(parsed.data.supportRoleIds))
            return res.status(400).json({ error: 'One or more roles do not belong to Run a Police.' });
        const c = parsed.data;
        try {
            db_1.db.prepare('INSERT INTO categories(id,name,description,emoji,discord_category_id,support_role_ids,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories))')
                .run(c.id, c.name, c.description, c.emoji, c.discordCategoryId, JSON.stringify(c.supportRoleIds));
            addAdminLog(client, req.authUser.id, 'category_created', c.id);
            void (0, discord_1.refreshPanel)(client).catch(e => console.error('Could not refresh ticket panel', e));
            res.status(201).json({ ok: true });
        }
        catch {
            res.status(409).json({ error: 'That category already exists.' });
        }
    });
    app.delete('/api/categories/:id', auth, (0, auth_1.requireRole)('admin'), (req, res) => {
        const result = db_1.db.prepare('UPDATE categories SET enabled=0 WHERE id=?').run(String(req.params.id));
        if (!result.changes)
            return res.status(404).json({ error: 'Category not found.' });
        addAdminLog(client, req.authUser.id, 'category_disabled', String(req.params.id));
        void (0, discord_1.refreshPanel)(client).catch(e => console.error('Could not refresh ticket panel', e));
        res.json({ ok: true });
    });
    app.get('/api/reaction-roles', auth, (0, auth_1.requireRole)('admin'), async (_req, res) => {
        try {
            const g = await client.guilds.fetch(config_1.config.DISCORD_GUILD_ID);
            await g.roles.fetch();
            await g.channels.fetch();
            const botMember = g.members.me || await g.members.fetch(client.user.id);
            const channels = [...g.channels.cache.values()].filter(c => c.type === discord_js_1.ChannelType.GuildText).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
            const roles = [...g.roles.cache.values()].filter(r => r.id !== g.id && !r.managed && r.position < botMember.roles.highest.position).map(r => ({ id: r.id, name: r.name, position: r.position })).sort((a, b) => b.position - a.position);
            res.json({ panel: (0, db_1.getSetting)('reactionRolePanel', { channelId: '', messageId: '', title: 'Choose your roles', description: 'React below to get or remove a role.', mappings: [] }), channels, roles, canManageRoles: botMember.permissions.has(discord_js_1.PermissionFlagsBits.ManageRoles) });
        }
        catch (error) {
            console.error('Could not load reaction role settings', error);
            res.status(502).json({ error: 'Could not load channels and roles from Discord.' });
        }
    });
    app.post('/api/reaction-roles', auth, (0, auth_1.requireRole)('admin'), async (req, res) => {
        const schema = zod_1.z.object({ channelId: zod_1.z.string().regex(/^\d{17,20}$/), title: zod_1.z.string().trim().min(1).max(256), description: zod_1.z.string().trim().max(1600), mappings: zod_1.z.array(zod_1.z.object({ emoji: zod_1.z.string().trim().min(1).max(40), roleId: zod_1.z.string().regex(/^\d{17,20}$/) })).min(1).max(20) });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: 'Add a channel and between 1 and 20 valid emoji-to-role mappings.' });
        const { channelId, title, description, mappings } = parsed.data;
        const emojiKey = (value) => value.match(/^<a?:[A-Za-z0-9_]+:(\d+)>$/)?.[1] || value;
        const keys = mappings.map(item => emojiKey(item.emoji));
        if (new Set(keys).size !== keys.length)
            return res.status(400).json({ error: 'Each reaction emoji can only be used once.' });
        if (new Set(mappings.map(item => item.roleId)).size !== mappings.length)
            return res.status(400).json({ error: 'Each role can only be used once in a reaction panel.' });
        try {
            const g = await client.guilds.fetch(config_1.config.DISCORD_GUILD_ID), channel = await g.channels.fetch(channelId);
            if (!channel || channel.type !== discord_js_1.ChannelType.GuildText)
                return res.status(400).json({ error: 'Choose a text channel in the configured Discord server.' });
            const botMember = g.members.me || await g.members.fetch(client.user.id);
            if (!botMember.permissions.has(discord_js_1.PermissionFlagsBits.ManageRoles))
                return res.status(400).json({ error: 'The bot needs the Manage Roles permission.' });
            const channelPermissions = channel.permissionsFor(botMember);
            if (!channelPermissions?.has([discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.EmbedLinks, discord_js_1.PermissionFlagsBits.AddReactions, discord_js_1.PermissionFlagsBits.ReadMessageHistory]))
                return res.status(400).json({ error: 'The bot needs View Channel, Send Messages, Embed Links, Add Reactions, and Read Message History in the selected channel.' });
            const resolved = mappings.map(item => ({ emoji: item.emoji, emojiKey: emojiKey(item.emoji), role: g.roles.cache.get(item.roleId) }));
            if (resolved.some(item => !item.role || item.role.id === g.id || item.role.managed || item.role.position >= botMember.roles.highest.position))
                return res.status(400).json({ error: 'Choose roles that the bot can manage, below its highest role.' });
            const embed = new discord_js_1.EmbedBuilder().setColor(0x5794f5).setTitle(title).setDescription(description || 'React below to get or remove a role.').addFields(resolved.map(item => ({ name: `${item.emoji}  ${item.role.name}`, value: `<@&${item.role.id}>`, inline: true })));
            const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            try {
                for (const item of resolved)
                    await sent.react(item.emojiKey);
            }
            catch (error) {
                await sent.delete().catch(() => undefined);
                throw error;
            }
            const previous = (0, db_1.getSetting)('reactionRolePanel', { channelId: '', messageId: '' });
            (0, db_1.setSetting)('reactionRolePanel', { channelId, messageId: sent.id, title, description, mappings: resolved.map(item => ({ emoji: item.emoji, emojiKey: item.emojiKey, roleId: item.role.id })) });
            if (previous.messageId) {
                const oldChannel = await g.channels.fetch(previous.channelId).catch(() => null);
                if (oldChannel?.type === discord_js_1.ChannelType.GuildText) {
                    const oldMessage = await oldChannel.messages.fetch(previous.messageId).catch(() => null);
                    if (oldMessage)
                        await oldMessage.delete().catch(() => undefined);
                }
            }
            addAdminLog(client, req.authUser.id, 'reaction_roles_published', `${channelId}:${sent.id}`);
            res.json({ ok: true, messageId: sent.id, channelId });
        }
        catch (error) {
            console.error('Could not publish reaction role panel', error);
            res.status(502).json({ error: 'Could not publish the reaction role message. Check the bot permissions and emoji values.' });
        }
    });
    app.get('/api/settings', auth, (0, auth_1.requireRole)('readonly'), (_req, res) => res.json({
        panelMessage: (0, db_1.getSetting)('panelMessage', 'Choose a category to open a private ticket.'), welcomeMessage: (0, db_1.getSetting)('welcomeMessage', 'Describe your issue for the support team.'), panelChannelId: (0, db_1.getSetting)('panelChannelId', server_defaults_1.DEFAULT_PANEL_CHANNEL_ID) || server_defaults_1.DEFAULT_PANEL_CHANNEL_ID,
        logChannelId: (0, db_1.getSetting)('logChannelId', server_defaults_1.DEFAULT_LOG_CHANNEL_ID) || server_defaults_1.DEFAULT_LOG_CHANNEL_ID, transcriptChannelId: (0, db_1.getSetting)('transcriptChannelId', server_defaults_1.DEFAULT_TRANSCRIPT_CHANNEL_ID) || server_defaults_1.DEFAULT_TRANSCRIPT_CHANNEL_ID, discordCategoryId: (0, db_1.getSetting)('discordCategoryId', ''),
        panelChannelIdEn: (0, db_1.getLocalizedSetting)('panelChannelId', 'en', server_defaults_1.DEFAULT_PANEL_CHANNEL_ID), logChannelIdEn: (0, db_1.getLocalizedSetting)('logChannelId', 'en', server_defaults_1.DEFAULT_LOG_CHANNEL_ID), transcriptChannelIdEn: (0, db_1.getLocalizedSetting)('transcriptChannelId', 'en', server_defaults_1.DEFAULT_TRANSCRIPT_CHANNEL_ID), discordCategoryIdEn: (0, db_1.getLocalizedSetting)('discordCategoryId', 'en', ''), panelMessageEn: (0, db_1.getLocalizedSetting)('panelMessage', 'en', 'Choose a category to open a private ticket.'), welcomeMessageEn: (0, db_1.getLocalizedSetting)('welcomeMessage', 'en', 'The support team will help you here. Describe your issue with as much detail as possible.'),
        panelChannelIdEs: (0, db_1.getLocalizedSetting)('panelChannelId', 'es', server_defaults_1.DEFAULT_ES_PANEL_CHANNEL_ID), logChannelIdEs: (0, db_1.getLocalizedSetting)('logChannelId', 'es', server_defaults_1.DEFAULT_ES_LOG_CHANNEL_ID), transcriptChannelIdEs: (0, db_1.getLocalizedSetting)('transcriptChannelId', 'es', server_defaults_1.DEFAULT_ES_TRANSCRIPT_CHANNEL_ID), discordCategoryIdEs: (0, db_1.getLocalizedSetting)('discordCategoryId', 'es', ''), panelMessageEs: (0, db_1.getLocalizedSetting)('panelMessage', 'es', 'Selecciona una categoría para abrir un ticket privado.'), welcomeMessageEs: (0, db_1.getLocalizedSetting)('welcomeMessage', 'es', 'El equipo de soporte te ayudará aquí. Describe tu problema con el mayor detalle posible.'),
        ticketLimitPerUser: (0, db_1.getSetting)('ticketLimitPerUser', 1), priorityLabels: (0, db_1.getSetting)('priorityLabels', { en: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }, es: { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' } }), adminRoleIds: (0, db_1.getSetting)('adminRoleIds', []), supervisorRoleIds: (0, db_1.getSetting)('supervisorRoleIds', []), supportRoleIds: (0, db_1.getSetting)('supportRoleIds', []), readonlyRoleIds: (0, db_1.getSetting)('readonlyRoleIds', [])
    }));
    app.put('/api/settings', auth, (0, auth_1.requireRole)('admin'), async (req, res) => {
        const channelId = zod_1.z.string().regex(/^\d{17,20}$/).or(zod_1.z.literal('')).optional();
        const schema = zod_1.z.object({ panelChannelIdEn: channelId, panelChannelIdEs: channelId, logChannelIdEn: channelId, logChannelIdEs: channelId, transcriptChannelIdEn: channelId, transcriptChannelIdEs: channelId, discordCategoryIdEn: channelId, discordCategoryIdEs: channelId, panelMessageEn: zod_1.z.string().max(1800).optional(), panelMessageEs: zod_1.z.string().max(1800).optional(), welcomeMessageEn: zod_1.z.string().max(1800).optional(), welcomeMessageEs: zod_1.z.string().max(1800).optional(), priorityLabels: zod_1.z.object({ en: zod_1.z.object({ low: zod_1.z.string().trim().min(1).max(32), normal: zod_1.z.string().trim().min(1).max(32), high: zod_1.z.string().trim().min(1).max(32), urgent: zod_1.z.string().trim().min(1).max(32) }), es: zod_1.z.object({ low: zod_1.z.string().trim().min(1).max(32), normal: zod_1.z.string().trim().min(1).max(32), high: zod_1.z.string().trim().min(1).max(32), urgent: zod_1.z.string().trim().min(1).max(32) }) }).optional(), ticketLimitPerUser: zod_1.z.number().int().min(1).max(10).optional(), adminRoleIds: zod_1.z.array(zod_1.z.string().regex(/^\d{17,20}$/)).max(30).optional(), supervisorRoleIds: zod_1.z.array(zod_1.z.string().regex(/^\d{17,20}$/)).max(30).optional(), supportRoleIds: zod_1.z.array(zod_1.z.string().regex(/^\d{17,20}$/)).max(30).optional(), readonlyRoleIds: zod_1.z.array(zod_1.z.string().regex(/^\d{17,20}$/)).max(30).optional() });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: 'Invalid settings.' });
        const c = parsed.data;
        for (const id of [c.panelChannelIdEn, c.panelChannelIdEs, c.logChannelIdEn, c.logChannelIdEs, c.transcriptChannelIdEn, c.transcriptChannelIdEs])
            if (id && !await hasGuildChannel(id, [discord_js_1.ChannelType.GuildText]))
                return res.status(400).json({ error: 'Panel, log, and transcript destinations must be text channels in Run a Police.' });
        for (const id of [c.discordCategoryIdEn, c.discordCategoryIdEs])
            if (id && !await hasGuildChannel(id, [discord_js_1.ChannelType.GuildCategory]))
                return res.status(400).json({ error: 'Ticket destination categories must belong to Run a Police.' });
        const roles = [...(c.adminRoleIds || []), ...(c.supervisorRoleIds || []), ...(c.supportRoleIds || []), ...(c.readonlyRoleIds || [])];
        if (!await hasGuildRoles([...new Set(roles)]))
            return res.status(400).json({ error: 'One or more roles do not belong to Run a Police.' });
        const localeKeys = { panelChannelIdEn: 'panelChannelId_en', panelChannelIdEs: 'panelChannelId_es', logChannelIdEn: 'logChannelId_en', logChannelIdEs: 'logChannelId_es', transcriptChannelIdEn: 'transcriptChannelId_en', transcriptChannelIdEs: 'transcriptChannelId_es', discordCategoryIdEn: 'discordCategoryId_en', discordCategoryIdEs: 'discordCategoryId_es', panelMessageEn: 'panelMessage_en', panelMessageEs: 'panelMessage_es', welcomeMessageEn: 'welcomeMessage_en', welcomeMessageEs: 'welcomeMessage_es' };
        for (const [key, value] of Object.entries(parsed.data))
            (0, db_1.setSetting)(localeKeys[key] || key, value);
        if (c.panelChannelIdEn) {
            (0, db_1.setSetting)('panelChannelId', c.panelChannelIdEn);
        }
        addAdminLog(client, req.authUser.id, 'settings_updated', JSON.stringify(Object.keys(parsed.data)));
        void (0, discord_1.refreshPanel)(client).catch(e => console.error('Could not refresh ticket panels', e));
        res.json({ ok: true });
    });
    app.get('/api/logs', auth, (0, auth_1.requireRole)('supervisor'), (req, res) => {
        const page = Math.min(parseIntParam(req.query.page) || 1, 10000);
        const rows = db_1.db.prepare(`SELECT e.type,e.detail,e.actor_id,e.created_at,t.public_id FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id ORDER BY e.id DESC LIMIT 100 OFFSET ?`).all((page - 1) * 100);
        const admin = db_1.db.prepare('SELECT actor_id,type,detail,created_at FROM admin_events ORDER BY id DESC LIMIT 100').all();
        res.json({ ticketEvents: rows, adminEvents: admin });
    });
    app.get('/api/backup', auth, (0, auth_1.requireRole)('admin'), async (_req, res) => {
        const file = node_path_1.default.join(node_os_1.default.tmpdir(), `run-a-police-${node_crypto_1.default.randomUUID()}.sqlite`);
        try {
            await db_1.db.backup(file);
            res.set('Cache-Control', 'no-store').download(file, `run-a-police-backup-${new Date().toISOString().slice(0, 10)}.sqlite`, () => node_fs_1.default.rm(file, { force: true }, () => undefined));
        }
        catch (error) {
            await node_fs_1.default.promises.rm(file, { force: true }).catch(() => undefined);
            console.error('Database backup failed', error);
            res.status(500).json({ error: 'Could not export the database.' });
        }
    });
    app.put('/api/backup', express_1.default.raw({ type: 'application/octet-stream', limit: '100mb' }), auth, (0, auth_1.requireRole)('admin'), async (req, res) => {
        const file = node_path_1.default.join(node_os_1.default.tmpdir(), `run-a-police-import-${node_crypto_1.default.randomUUID()}.sqlite`);
        let source;
        try {
            if (!Buffer.isBuffer(req.body) || req.body.length < 100)
                return res.status(400).json({ error: 'Choose a valid SQLite backup file.' });
            await node_fs_1.default.promises.writeFile(file, req.body);
            source = new better_sqlite3_1.default(file, { readonly: true, fileMustExist: true });
            if (source.pragma('quick_check')[0]?.quick_check !== 'ok')
                throw new Error('SQLite integrity check failed.');
            const tables = ['settings', 'categories', 'tickets', 'ticket_events', 'ticket_notes', 'transcripts', 'community_posts', 'community_votes', 'ratings', 'admin_events'];
            const data = tables.map(table => {
                const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
                if (!exists)
                    throw new Error(`Backup is missing the ${table} table.`);
                const cols = source.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
                return { table, cols, rows: source.prepare(`SELECT * FROM ${table}`).all() };
            });
            const deleteOrder = ['community_votes', 'ratings', 'transcripts', 'ticket_notes', 'ticket_events', 'community_posts', 'tickets', 'categories', 'settings', 'admin_events'];
            db_1.db.transaction(() => {
                db_1.db.pragma('defer_foreign_keys = ON');
                for (const table of deleteOrder)
                    db_1.db.prepare(`DELETE FROM ${table}`).run();
                for (const { table, cols, rows } of data) {
                    const target = new Set(db_1.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
                    const validCols = cols.filter(c => target.has(c));
                    if (!validCols.length)
                        continue;
                    const stmt = db_1.db.prepare(`INSERT INTO ${table} (${validCols.map(c => `"${c}"`).join(',')}) VALUES (${validCols.map(() => '?').join(',')})`);
                    for (const row of rows)
                        stmt.run(...validCols.map(c => row[c]));
                }
            })();
            void (0, discord_1.refreshPanel)(client).catch(error => (0, audit_1.recordSystemError)(client, error, 'Panel refresh after backup import'));
            res.json({ ok: true, restoredTables: data.length });
        }
        catch (error) {
            console.error('Database backup import failed', error);
            res.status(400).json({ error: 'Could not import this backup. Confirm it is a valid Run a Police SQLite backup.' });
        }
        finally {
            source?.close();
            await node_fs_1.default.promises.rm(file, { force: true }).catch(() => undefined);
        }
    });
    app.get('/api/staff', auth, (0, auth_1.requireRole)('readonly'), async (_req, res) => {
        try {
            // Build this view from existing ticket activity; do not enumerate every guild member.
            const ids = db_1.db.prepare("SELECT actor_id id,MAX(id) last_id FROM ticket_events WHERE type IN ('claimed','closed','released','staff_participated') GROUP BY actor_id ORDER BY last_id DESC LIMIT 25").all();
            const out = [];
            for (const row of ids) {
                const user = client.users.cache.get(row.id) || await client.users.fetch(row.id).catch(() => null);
                if (!user)
                    continue;
                const stats = db_1.db.prepare(`SELECT (SELECT COUNT(*) FROM tickets WHERE closed_by=?) closed,
          (SELECT COUNT(*) FROM ticket_events WHERE actor_id=? AND type='claimed') claimed,
          (SELECT AVG((julianday(e.created_at)-julianday(t.created_at))*86400) FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id WHERE e.actor_id=? AND e.type='staff_response') response,
          (SELECT AVG((julianday(closed_at)-julianday(created_at))*86400) FROM tickets WHERE closed_by=? AND closed_at IS NOT NULL) resolution`).get(row.id, row.id, row.id, row.id);
                out.push({ id: row.id, username: user.username, avatar: user.avatar, closed: stats.closed || 0, claimed: stats.claimed || 0, avgResponseSeconds: stats.response ? Math.round(stats.response) : null, avgResolutionSeconds: stats.resolution ? Math.round(stats.resolution) : null });
            }
            res.json(out);
        }
        catch (e) {
            console.error('Could not load staff members', e);
            res.status(502).json({ error: 'Could not load the Discord staff list.' });
        }
    });
    app.post('/api/logout', auth, (req, res) => { const raw = req.cookies?.['__Host-rap_session'] || req.cookies?.rap_session; (0, auth_1.clearSession)(req, res); if (raw)
        db_1.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(node_crypto_1.default.createHash('sha256').update(raw).digest('hex')); res.json({ ok: true }); });
    const publicDir = node_path_1.default.join(__dirname, '..', 'public');
    app.use(express_1.default.static(publicDir, { extensions: ['html'], maxAge: 0, setHeaders: (res, file) => { if (/\.(?:html|js|css)$/i.test(file))
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
    app.get('*path', (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/auth/'))
        return next(); res.sendFile(node_path_1.default.join(publicDir, 'index.html')); });
    app.use((err, _req, res, _next) => { (0, audit_1.recordSystemError)(client, err, 'HTTP request error'); if (!res.headersSent)
        res.status(500).json({ error: 'Error interno.' }); });
    return app;
}
function addAdminLog(client, actor, type, detail) {
    db_1.db.prepare('INSERT INTO admin_events(actor_id,type,detail,created_at) VALUES(?,?,?,?)').run(actor, type, detail, new Date().toISOString());
    void (0, audit_1.sendAudit)(client, `**${type}** · ${actor} · ${detail}`);
}
