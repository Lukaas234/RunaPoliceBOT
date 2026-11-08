"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryText = exports.priorityNames = void 0;
exports.priorityLabel = priorityLabel;
exports.getTicketByChannel = getTicketByChannel;
exports.getTicket = getTicket;
exports.isSupportRole = isSupportRole;
exports.isStaff = isStaff;
exports.createTicket = createTicket;
exports.updateTicket = updateTicket;
exports.toggleClaim = toggleClaim;
exports.addTicketEvent = addTicketEvent;
exports.getCategories = getCategories;
exports.supportRoleIdsForCategory = supportRoleIdsForCategory;
exports.recreateTicketChannel = recreateTicketChannel;
exports.panelComponents = panelComponents;
exports.ticketControls = ticketControls;
const discord_js_1 = require("discord.js");
const node_crypto_1 = __importDefault(require("node:crypto"));
const db_1 = require("./db");
const config_1 = require("./config");
const i18n_1 = require("./i18n");
const now = () => new Date().toISOString();
exports.priorityNames = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const defaultPriorityLabels = { en: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }, es: { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' } };
function priorityLabel(priority, locale) {
    const labels = (0, db_1.getSetting)('priorityLabels', defaultPriorityLabels);
    return labels[locale]?.[priority] || defaultPriorityLabels[locale][priority];
}
const categoryText = (id, name, description, locale) => {
    if (locale === 'en')
        return { name, description };
    const es = {
        general: { name: 'Soporte general', description: 'Consultas y ayuda general.' },
        report: { name: 'Reportar a un usuario', description: 'Reportes confidenciales sobre usuarios.' },
        appeal: { name: 'Apelaciones', description: 'Solicita la revisión de una sanción.' },
        technical: { name: 'Problemas técnicos', description: 'Errores, fallos o problemas técnicos.' },
        admin: { name: 'Consultas administrativas', description: 'Consultas para el equipo administrativo.' }
    };
    return es[id] || { name, description };
};
exports.categoryText = categoryText;
const event = db_1.db.prepare('INSERT INTO ticket_events(ticket_id,actor_id,type,detail,created_at) VALUES(?,?,?,?,?)');
function getTicketByChannel(channelId) {
    return db_1.db.prepare('SELECT * FROM tickets WHERE channel_id=?').get(channelId);
}
function getTicket(publicId) {
    return db_1.db.prepare('SELECT * FROM tickets WHERE public_id=?').get(publicId.toUpperCase());
}
function isSupportRole(roleIds) {
    const allowed = new Set(config_1.config.bootstrapAdminRoleIds);
    for (const r of (0, db_1.getSetting)('supportRoleIds', []))
        allowed.add(r);
    for (const r of (0, db_1.getSetting)('adminRoleIds', []))
        allowed.add(r);
    for (const r of (0, db_1.getSetting)('supervisorRoleIds', []))
        allowed.add(r);
    return roleIds.some(r => allowed.has(r));
}
async function isStaff(guild, userId) {
    const member = await guild.members.fetch(userId).catch(() => null);
    return !!member && (member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator) || isSupportRole([...member.roles.cache.keys()]));
}
function safeChannelName(s) {
    return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 22) || 'user';
}
// Serialize ticket creation per user to prevent concurrent button clicks opening duplicates.
const pendingUsers = new Set();
async function createTicket(guild, userId, categoryId, locale = 'en') {
    if (pendingUsers.has(userId))
        throw new Error((0, i18n_1.localized)(locale, 'Ya se está creando tu ticket. Espera un momento.', 'Your ticket is already being created. Please wait.'));
    pendingUsers.add(userId);
    try {
        const active = db_1.db.prepare("SELECT public_id FROM tickets WHERE owner_id=? AND status!='closed'").get(userId);
        const limit = (0, db_1.getSetting)('ticketLimitPerUser', 1);
        const count = db_1.db.prepare("SELECT COUNT(*) n FROM tickets WHERE owner_id=? AND status!='closed'").get(userId).n;
        if (count >= limit)
            throw new Error((0, i18n_1.localized)(locale, `Ya alcanzaste el límite de ${limit} ticket(s) abiertos${active ? ` (${active.public_id})` : ''}.`, `You have reached the limit of ${limit} open ticket(s)${active ? ` (${active.public_id})` : ''}.`));
        const category = db_1.db.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').get(categoryId);
        if (!category)
            throw new Error((0, i18n_1.localized)(locale, 'La categoría no está disponible.', 'This category is unavailable.'));
        const display = (0, exports.categoryText)(category.id, category.name, '', locale);
        const configCategory = category.discord_category_id || (0, db_1.getLocalizedSetting)('discordCategoryId', locale, '');
        const roleIds = supportRoleIdsForCategory(categoryId);
        const overwrites = [
            { id: guild.id, type: discord_js_1.OverwriteType.Role, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
            { id: userId, type: discord_js_1.OverwriteType.Member, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory, discord_js_1.PermissionFlagsBits.AttachFiles] },
            { id: guild.client.user.id, type: discord_js_1.OverwriteType.Member, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory, discord_js_1.PermissionFlagsBits.ManageChannels, discord_js_1.PermissionFlagsBits.ManageMessages] },
            ...roleIds.map(id => ({ id, type: discord_js_1.OverwriteType.Role, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] }))
        ];
        const channel = await guild.channels.create({
            name: `ticket-${safeChannelName((await guild.client.users.fetch(userId)).username)}`,
            type: discord_js_1.ChannelType.GuildText, parent: configCategory || undefined, permissionOverwrites: overwrites,
            topic: (0, i18n_1.localized)(locale, `Ticket ${categoryId} · Usuario ${userId} · Run a Police Tickets`, `Ticket ${categoryId} · User ${userId} · Run a Police Tickets`)
        });
        let insertedId;
        try {
            const tempId = `TMP-${node_crypto_1.default.randomUUID()}`;
            const result = db_1.db.prepare('INSERT INTO tickets(public_id,guild_id,channel_id,owner_id,category_id,language,created_at) VALUES(?,?,?,?,?,?,?)')
                .run(tempId, guild.id, channel.id, userId, categoryId, locale, now());
            insertedId = Number(result.lastInsertRowid);
            const publicId = `RAP-${String(result.lastInsertRowid).padStart(6, '0')}`;
            db_1.db.prepare('UPDATE tickets SET public_id=? WHERE id=?').run(publicId, result.lastInsertRowid);
            const ticket = getTicket(publicId);
            event.run(ticket.id, userId, 'opened', categoryId, ticket.created_at);
            const embed = new discord_js_1.EmbedBuilder().setColor(0x3b82f6).setTitle(`${category.emoji} ${display.name}`)
                .setDescription((0, db_1.getLocalizedSetting)('welcomeMessage', locale, (0, i18n_1.localized)(locale, 'Hola <@' + userId + '>. El equipo de soporte te atenderá aquí. Describe tu consulta con el mayor detalle posible.', 'Hello <@' + userId + '>. The support team will assist you here. Please describe your issue in as much detail as possible.')))
                .addFields({ name: 'Ticket', value: publicId, inline: true }, { name: (0, i18n_1.localized)(locale, 'Prioridad', 'Priority'), value: priorityLabel('normal', locale), inline: true })
                .setFooter({ text: 'Run a Police Tickets' }).setTimestamp();
            const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId('ticket:claim').setLabel((0, i18n_1.localized)(locale, 'Reclamar', 'Claim')).setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId('ticket:close').setLabel((0, i18n_1.localized)(locale, 'Cerrar', 'Close')).setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder().setCustomId('ticket:priority').setLabel((0, i18n_1.localized)(locale, 'Prioridad', 'Priority')).setStyle(discord_js_1.ButtonStyle.Secondary));
            await channel.send({ embeds: [embed], components: [row] });
            return ticket;
        }
        catch (error) {
            if (insertedId) {
                db_1.db.prepare('DELETE FROM ticket_events WHERE ticket_id=?').run(insertedId);
                db_1.db.prepare('DELETE FROM tickets WHERE id=?').run(insertedId);
            }
            await channel.delete('Could not save the ticket').catch(() => undefined);
            throw error;
        }
    }
    finally {
        pendingUsers.delete(userId);
    }
}
function updateTicket(ticket, actorId, type, detail = '') {
    const time = now();
    const tx = db_1.db.transaction(() => {
        if (type === 'claimed')
            db_1.db.prepare("UPDATE tickets SET status='claimed',claimed_by=? WHERE id=? AND status!='closed'").run(actorId, ticket.id);
        else if (type === 'released')
            db_1.db.prepare("UPDATE tickets SET status='open',claimed_by=NULL WHERE id=? AND status!='closed'").run(ticket.id);
        else if (type === 'priority')
            db_1.db.prepare('UPDATE tickets SET priority=? WHERE id=? AND status!=\'closed\'').run(detail, ticket.id);
        else if (type === 'closed')
            db_1.db.prepare("UPDATE tickets SET status='closed',closed_at=?,closed_by=?,close_reason=? WHERE id=?").run(time, actorId, detail, ticket.id);
        else if (type === 'reopened') {
            db_1.db.prepare("UPDATE tickets SET status='open',claimed_by=NULL,closed_at=NULL,closed_by=NULL,close_reason=NULL WHERE id=?").run(ticket.id);
            db_1.db.prepare('DELETE FROM transcripts WHERE ticket_id=?').run(ticket.id);
            db_1.db.prepare('DELETE FROM ratings WHERE ticket_id=?').run(ticket.id);
        }
        else if (type === 'transferred')
            db_1.db.prepare('UPDATE tickets SET category_id=? WHERE id=?').run(detail, ticket.id);
        event.run(ticket.id, actorId, type, detail, time);
    });
    tx();
}
function toggleClaim(ticket, actorId) {
    return db_1.db.transaction(() => {
        const current = db_1.db.prepare('SELECT status,claimed_by FROM tickets WHERE id=?').get(ticket.id);
        if (!current || current.status === 'closed')
            return 'closed';
        if (current.claimed_by && current.claimed_by !== actorId)
            return 'conflict';
        const type = current.claimed_by === actorId ? 'released' : 'claimed';
        if (type === 'claimed')
            db_1.db.prepare("UPDATE tickets SET status='claimed',claimed_by=? WHERE id=? AND status!='closed' AND claimed_by IS NULL").run(actorId, ticket.id);
        else
            db_1.db.prepare("UPDATE tickets SET status='open',claimed_by=NULL WHERE id=? AND status!='closed' AND claimed_by=?").run(ticket.id, actorId);
        event.run(ticket.id, actorId, type, '', now());
        return type;
    })();
}
function addTicketEvent(ticket, actorId, type, detail = '') { event.run(ticket.id, actorId, type, detail, now()); }
function getCategories() {
    return db_1.db.prepare('SELECT * FROM categories WHERE enabled=1 ORDER BY sort_order,id').all();
}
function supportRoleIdsForCategory(categoryId) {
    const row = db_1.db.prepare('SELECT support_role_ids FROM categories WHERE id=?').get(categoryId);
    const specific = row ? JSON.parse(row.support_role_ids) : [];
    return [...new Set([...specific, ...(0, db_1.getSetting)('supportRoleIds', []), ...(0, db_1.getSetting)('supervisorRoleIds', []), ...(0, db_1.getSetting)('adminRoleIds', []), ...config_1.config.bootstrapAdminRoleIds])];
}
async function recreateTicketChannel(guild, ticket) {
    const category = db_1.db.prepare('SELECT * FROM categories WHERE id=?').get(ticket.category_id);
    if (!category)
        throw new Error('The ticket category could not be found.');
    const display = (0, exports.categoryText)(ticket.category_id, category.name, '', ticket.language);
    const user = await guild.client.users.fetch(ticket.owner_id);
    const roles = supportRoleIdsForCategory(ticket.category_id);
    const channel = await guild.channels.create({ name: `ticket-${safeChannelName(user.username)}`, type: discord_js_1.ChannelType.GuildText, parent: category.discord_category_id || (0, db_1.getLocalizedSetting)('discordCategoryId', ticket.language, '') || undefined,
        permissionOverwrites: [
            { id: guild.id, type: discord_js_1.OverwriteType.Role, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
            { id: ticket.owner_id, type: discord_js_1.OverwriteType.Member, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory, discord_js_1.PermissionFlagsBits.AttachFiles] },
            { id: guild.client.user.id, type: discord_js_1.OverwriteType.Member, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory, discord_js_1.PermissionFlagsBits.ManageChannels, discord_js_1.PermissionFlagsBits.ManageMessages] },
            ...roles.map(id => ({ id, type: discord_js_1.OverwriteType.Role, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] }))
        ], topic: `Ticket ${ticket.public_id} · ${category.name}` });
    db_1.db.prepare('UPDATE tickets SET channel_id=? WHERE id=?').run(channel.id, ticket.id);
    const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId('ticket:claim').setLabel((0, i18n_1.localized)(ticket.language, 'Reclamar', 'Claim')).setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId('ticket:close').setLabel((0, i18n_1.localized)(ticket.language, 'Cerrar', 'Close')).setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder().setCustomId('ticket:priority').setLabel((0, i18n_1.localized)(ticket.language, 'Prioridad', 'Priority')).setStyle(discord_js_1.ButtonStyle.Secondary));
    const embed = new discord_js_1.EmbedBuilder().setColor(0x3b82f6).setTitle(`${category.emoji} ${display.name}`).setDescription((0, db_1.getLocalizedSetting)('welcomeMessage', ticket.language, (0, i18n_1.localized)(ticket.language, 'Describe tu consulta al equipo de soporte.', 'Describe your issue for the support team.'))).addFields({ name: 'Ticket', value: ticket.public_id, inline: true }).setFooter({ text: 'Run a Police Tickets' }).setTimestamp();
    await channel.send({ embeds: [embed], components: [row] });
    return channel;
}
function panelComponents(locale = 'en') {
    const cats = getCategories().slice(0, 25);
    const menu = new discord_js_1.StringSelectMenuBuilder().setCustomId(`ticket:category:${locale}`).setPlaceholder((0, i18n_1.localized)(locale, 'Elige el motivo de contacto', 'Choose a contact reason'))
        .addOptions(cats.map(c => { const display = (0, exports.categoryText)(c.id, c.name, c.description, locale); return { label: display.name.slice(0, 100), description: (display.description || (locale === 'en' ? 'Open a ticket' : 'Abrir un ticket')).slice(0, 100), value: c.id, emoji: c.emoji }; }));
    return [new discord_js_1.ActionRowBuilder().addComponents(menu)];
}
function ticketControls(locale = 'en') {
    return [new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId('ticket:claim').setLabel((0, i18n_1.localized)(locale, 'Reclamar', 'Claim')).setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId('ticket:close').setLabel((0, i18n_1.localized)(locale, 'Cerrar', 'Close')).setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder().setCustomId('ticket:priority').setLabel((0, i18n_1.localized)(locale, 'Prioridad', 'Priority')).setStyle(discord_js_1.ButtonStyle.Secondary))];
}
