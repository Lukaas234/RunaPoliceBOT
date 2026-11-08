"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.client = void 0;
exports.registerCommands = registerCommands;
exports.startDiscord = startDiscord;
exports.refreshPanel = refreshPanel;
const discord_js_1 = require("discord.js");
const config_1 = require("./config");
const db_1 = require("./db");
const tickets_1 = require("./tickets");
const transcripts_1 = require("./transcripts");
const audit_1 = require("./audit");
const i18n_1 = require("./i18n");
const server_defaults_1 = require("./server-defaults");
const community_1 = require("./community");
exports.client = new discord_js_1.Client({ intents: [discord_js_1.GatewayIntentBits.Guilds, discord_js_1.GatewayIntentBits.GuildMessages, discord_js_1.GatewayIntentBits.MessageContent, discord_js_1.GatewayIntentBits.GuildMessageReactions], partials: [discord_js_1.Partials.Message, discord_js_1.Partials.Channel, discord_js_1.Partials.Reaction] });
// Discord's command UI permission hint is intentionally broad; every action is checked again server-side.
const staffCommand = (c) => c;
const commands = () => [
    new discord_js_1.SlashCommandBuilder().setName('ticket').setDescription((0, i18n_1.tr)('Consulta la ayuda y el panel de tickets.', 'View ticket help and the support panel.')),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-panel').setDescription((0, i18n_1.tr)('Publica o actualiza el panel de tickets.', 'Post or update the ticket panel.'))
        .addChannelOption(o => o.setName('channel').setDescription((0, i18n_1.tr)('Canal donde publicar el panel', 'Channel for the panel')).addChannelTypes(discord_js_1.ChannelType.GuildText))
        .addStringOption(o => o.setName('language').setDescription('Panel language').addChoices({ name: 'English', value: 'en' }, { name: 'Español', value: 'es' }))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-setup').setDescription((0, i18n_1.tr)('Comprueba la configuración del bot.', 'Check the bot configuration.'))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-stats').setDescription((0, i18n_1.tr)('Muestra el resumen de tickets.', 'Show a ticket summary.'))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-close').setDescription((0, i18n_1.tr)('Cierra y elimina el canal del ticket.', 'Close the ticket and delete its channel.'))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-reopen').setDescription((0, i18n_1.tr)('Reabre un ticket cerrado por su ID.', 'Reopen a closed ticket by its ID.'))
        .addStringOption(o => o.setName('ticket').setDescription((0, i18n_1.tr)('ID del ticket, por ejemplo RAP-000123', 'Ticket ID, for example RAP-000123')).setRequired(true))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-claim').setDescription((0, i18n_1.tr)('Reclama o libera el ticket actual.', 'Claim or release the current ticket.'))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-priority').setDescription((0, i18n_1.tr)('Cambia la prioridad del ticket actual.', 'Change the current ticket priority.'))
        .addStringOption(o => o.setName('priority').setDescription((0, i18n_1.tr)('Prioridad nueva', 'New priority')).setRequired(true).addChoices({ name: (0, i18n_1.tr)('Baja', 'Low'), value: 'low' }, { name: 'Normal', value: 'normal' }, { name: (0, i18n_1.tr)('Alta', 'High'), value: 'high' }, { name: (0, i18n_1.tr)('Urgente', 'Urgent'), value: 'urgent' }))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-add').setDescription((0, i18n_1.tr)('Añade un usuario al ticket actual.', 'Add a user to the current ticket.'))
        .addUserOption(o => o.setName('user').setDescription((0, i18n_1.tr)('Usuario a añadir', 'User to add')).setRequired(true))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-remove').setDescription((0, i18n_1.tr)('Quita un usuario del ticket actual.', 'Remove a user from the current ticket.'))
        .addUserOption(o => o.setName('user').setDescription((0, i18n_1.tr)('Usuario a quitar', 'User to remove')).setRequired(true))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-transcript').setDescription((0, i18n_1.tr)('Genera o actualiza el transcript del ticket actual.', 'Generate or update the current ticket transcript.'))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('ticket-transfer').setDescription((0, i18n_1.tr)('Transfiere el ticket a otra categoría.', 'Transfer the ticket to another category.'))
        .addStringOption(o => o.setName('category').setDescription((0, i18n_1.tr)('Categoría de destino', 'Destination category')).setRequired(true).setAutocomplete(true))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('community-create').setDescription('Post a task, bug, problem, or suggestion.')
        .addStringOption(o => o.setName('title').setDescription('Short title').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('Post type').setRequired(true).addChoices({ name: 'Pending task', value: 'task' }, { name: 'Bug', value: 'error' }, { name: 'Problem', value: 'problem' }, { name: 'Suggestion', value: 'suggestion' }))
        .addStringOption(o => o.setName('description').setDescription('Description').setRequired(true))
        .addStringOption(o => o.setName('changes').setDescription('Changes included (optional)').setRequired(false))
        .addStringOption(o => o.setName('image').setDescription('Image https URL (optional)').setRequired(false))),
    staffCommand(new discord_js_1.SlashCommandBuilder().setName('community-list').setDescription('Show pending items ordered by forum reactions and votes.'))
];
async function registerCommands() {
    const rest = new discord_js_1.REST({ version: '10' }).setToken(config_1.config.DISCORD_TOKEN);
    await rest.put(discord_js_1.Routes.applicationGuildCommands(config_1.config.DISCORD_CLIENT_ID, config_1.config.DISCORD_GUILD_ID), { body: commands().map(c => c.toJSON()) });
}
async function startDiscord() {
    await exports.client.login(config_1.config.DISCORD_TOKEN);
    if (!exports.client.isReady())
        await new Promise(resolve => exports.client.once(discord_js_1.Events.ClientReady, () => resolve()));
}
async function refreshPanel(bot = exports.client) {
    for (const locale of ['en', 'es'])
        await publishPanel(bot, locale);
}
async function publishPanel(bot, locale, targetOverride) {
    const fallback = locale === 'en' ? server_defaults_1.DEFAULT_PANEL_CHANNEL_ID : server_defaults_1.DEFAULT_ES_PANEL_CHANNEL_ID;
    const targetId = targetOverride || (0, db_1.getLocalizedSetting)('panelChannelId', locale, fallback) || fallback;
    const oldChannelId = (0, db_1.getSetting)(`panelMessageChannelId_${locale}`, locale === 'en' ? (0, db_1.getSetting)('panelMessageChannelId', '') : ''), messageId = (0, db_1.getSetting)(`panelMessageId_${locale}`, locale === 'en' ? (0, db_1.getSetting)('panelMessageId', '') : '');
    const target = await bot.channels.fetch(targetId).catch(() => null);
    if (!target?.isTextBased() || !('messages' in target))
        return;
    const description = (0, db_1.getLocalizedSetting)('panelMessage', locale, (0, i18n_1.localized)(locale, 'Selecciona una categoría para abrir un ticket privado.', 'Choose a category to open a private ticket.'));
    const embed = { color: 0x3b82f6, title: (0, i18n_1.localized)(locale, 'Run a Police · Centro de soporte', 'Run a Police · Support Center'), description, footer: { text: `Run a Police Tickets · ${locale.toUpperCase()} PANEL` } };
    const oldChannel = oldChannelId ? await bot.channels.fetch(oldChannelId).catch(() => null) : null;
    let oldMessage = oldChannel?.isTextBased() && 'messages' in oldChannel && messageId ? await oldChannel.messages.fetch(messageId).catch(() => null) : null;
    // If the saved pointer was lost, find this bot's panel before posting another one.
    if (!oldMessage) {
        const recent = await target.messages.fetch({ limit: 100 }).catch(() => null);
        oldMessage = recent?.find(m => m.author.id === bot.user?.id && m.components.some((row) => Array.isArray(row.components) && row.components.some((c) => c.customId === `ticket:category:${locale}` || locale === 'en' && c.customId === 'ticket:category'))) ?? null;
    }
    if (oldMessage && oldMessage.channelId === targetId)
        await oldMessage.edit({ embeds: [embed], components: (0, tickets_1.panelComponents)(locale), allowedMentions: { parse: [] } });
    else {
        if (oldMessage)
            await oldMessage.edit({ content: (0, i18n_1.localized)(locale, 'Este panel fue movido. Usa el panel actualizado.', 'This panel has moved. Use the updated panel.'), components: [] }).catch(() => undefined);
        oldMessage = await target.send({ embeds: [embed], components: (0, tickets_1.panelComponents)(locale), allowedMentions: { parse: [] } });
    }
    (0, db_1.setSetting)(`panelChannelId_${locale}`, targetId);
    (0, db_1.setSetting)(`panelMessageChannelId_${locale}`, targetId);
    (0, db_1.setSetting)(`panelMessageId_${locale}`, oldMessage.id);
    if (locale === 'en') {
        (0, db_1.setSetting)('panelChannelId', targetId);
        (0, db_1.setSetting)('panelMessageChannelId', targetId);
        (0, db_1.setSetting)('panelMessageId', oldMessage.id);
    }
}
function eventLog(ticket, actor, type, detail = '') {
    if (type === 'user_added' || type === 'user_removed')
        (0, tickets_1.addTicketEvent)(ticket, actor, type, detail);
    void (0, audit_1.sendAudit)(exports.client, `**${type}** · ${ticket.public_id} · <@${actor}>${detail ? ` · ${detail}` : ''}`, ticket.language);
}
async function staffOnly(i) {
    if (!i.guild || !await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
        await i.reply({ content: (0, i18n_1.tr)('No tienes permiso para gestionar tickets.', 'You do not have permission to manage tickets.'), ephemeral: true });
        return false;
    }
    return true;
}
async function transcript(i, t) {
    if (!i.deferred && !i.replied)
        await i.deferReply({ ephemeral: true });
    const html = await (0, transcripts_1.generateTranscript)(t, i.channel, i.user.id);
    let sent = false;
    try {
        await (0, transcripts_1.sendTranscriptToDiscord)(exports.client, t, html);
        sent = true;
    }
    catch (error) {
        console.error('Could not send transcript to Discord', error);
    }
    await i.editReply({ content: sent ? (0, i18n_1.localized)(t.language, `Transcripción ${t.public_id} generada y enviada al canal de transcripciones.`, `Transcript ${t.public_id} generated and sent to the transcript channel.`) : (0, i18n_1.localized)(t.language, `La transcripción ${t.public_id} se guardó en el panel, pero no se pudo enviar a Discord.`, `Transcript ${t.public_id} was saved in the dashboard but could not be sent to Discord.`) });
}
async function closeTicket(i, t, reason) {
    if (t.status === 'closed') {
        await i.reply({ content: (0, i18n_1.localized)(t.language, 'Este ticket ya está cerrado.', 'This ticket is already closed.'), ephemeral: true });
        return;
    }
    (0, tickets_1.updateTicket)(t, i.user.id, 'closed', reason || 'No reason provided');
    const updated = db_1.db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id);
    const ch = i.channel;
    const owner = await ch.guild.members.fetch(t.owner_id).catch(() => null);
    if (owner)
        await ch.permissionOverwrites.edit(owner.id, { SendMessages: false, AddReactions: false }).catch(() => undefined);
    await ch.setName(`${t.language === 'es' ? 'cerrado' : 'closed'}-${t.public_id.toLowerCase()}`).catch(() => undefined);
    const html = await (0, transcripts_1.generateTranscript)(updated, ch, i.user.id).catch(e => { console.error('Transcript generation failed', e); return null; });
    let sent = false;
    if (html)
        try {
            await (0, transcripts_1.sendTranscriptToDiscord)(exports.client, updated, html);
            sent = true;
        }
        catch (error) {
            console.error('Could not send closed ticket transcript to Discord', error);
        }
    const ratingRow = new discord_js_1.ActionRowBuilder().addComponents(...[1, 2, 3, 4, 5].map(score => new discord_js_1.ButtonBuilder().setCustomId(`ticket:rate:${score}`).setLabel(`${score} ★`).setStyle(discord_js_1.ButtonStyle.Secondary)));
    const response = { content: (0, i18n_1.localized)(t.language, `Ticket cerrado. Motivo: **${reason || 'Sin motivo indicado'}**${sent ? ' · La transcripción se guardó en el panel y se envió a Discord.' : html ? ' · La transcripción se guardó en el panel, pero no se envió a Discord; el canal se conservará.' : ' · No se pudo guardar la transcripción; el canal se conservará.'}\n¿Cómo fue tu experiencia con el equipo de soporte? Valora la atención:`, `Ticket closed. Reason: **${reason || 'No reason provided'}**${sent ? ' · Transcript saved in the dashboard and sent to Discord.' : html ? ' · Transcript saved in the dashboard but not sent to Discord; the channel will be kept.' : ' · The transcript could not be saved; the channel will be kept.'}\nHow was your support experience? Rate the service:`), components: html ? [ratingRow] : [], ephemeral: true, allowedMentions: { parse: [] } };
    if (i.deferred || i.replied)
        await i.followUp(response);
    else
        await i.reply(response);
    eventLog(updated, i.user.id, 'closed', reason);
    if (html && sent)
        try {
            await ch.delete(`Ticket ${t.public_id} closed; transcript saved`);
        }
        catch (error) {
            console.error('Could not delete closed ticket channel', error);
            await i.followUp({ content: (0, i18n_1.tr)('El transcript se guardó, pero no se pudo borrar el canal. Verifica el permiso Administrar canales del bot.', 'The transcript was saved, but the channel could not be deleted. Check that the bot has Manage Channels permission.'), ephemeral: true });
        }
}
async function handleCommand(i) {
    const name = i.commandName;
    if (name === 'ticket') {
        await i.reply({ content: (0, i18n_1.tr)('Para contactar al equipo, usa el panel de tickets publicado en el servidor.', 'To contact support, use the ticket panel posted in the server.'), ephemeral: true });
        return;
    }
    if (!await staffOnly(i))
        return;
    if (name === 'ticket-panel') {
        const locale = (i.options.getString('language') || 'en');
        const selectedOption = i.options.getChannel('channel');
        const selected = selectedOption ? await exports.client.channels.fetch(selectedOption.id).catch(() => null) : null;
        const configuredId = (0, db_1.getLocalizedSetting)('panelChannelId', locale, locale === 'es' ? server_defaults_1.DEFAULT_ES_PANEL_CHANNEL_ID : server_defaults_1.DEFAULT_PANEL_CHANNEL_ID);
        const configured = configuredId ? await exports.client.channels.fetch(configuredId).catch(() => null) : null;
        const candidate = selected || configured || i.channel;
        if (!candidate?.isTextBased() || !('send' in candidate)) {
            await i.reply({ content: (0, i18n_1.tr)('Elige un canal de texto.', 'Choose a text channel.'), ephemeral: true });
            return;
        }
        await publishPanel(exports.client, locale, candidate.id);
        await i.reply({ content: (0, i18n_1.localized)(locale, `Panel de tickets en español actualizado en <#${candidate.id}>.`, `English ticket panel updated in <#${candidate.id}>.`), ephemeral: true });
        return;
    }
    if (name === 'ticket-setup') {
        const g = i.guild;
        const missing = [];
        if (!g.members.me?.permissions.has(discord_js_1.PermissionFlagsBits.ManageChannels))
            missing.push('Manage Channels');
        if (!g.members.me?.permissions.has(discord_js_1.PermissionFlagsBits.ViewChannel))
            missing.push('View Channel');
        await i.reply({ content: missing.length ? (0, i18n_1.tr)(`Faltan permisos del bot: ${missing.join(', ')}.`, `The bot is missing permissions: ${missing.join(', ')}.`) : (0, i18n_1.tr)(`Configuración básica lista. ${(0, tickets_1.getCategories)().length} categorías activas.`, `Basic setup is ready. ${(0, tickets_1.getCategories)().length} active categories.`), ephemeral: true });
        return;
    }
    if (name === 'ticket-stats') {
        const row = db_1.db.prepare(`SELECT SUM(status='open') open,SUM(status='claimed') claimed,SUM(status='closed') closed,COUNT(*) total FROM tickets`).get();
        await i.reply({ content: (0, i18n_1.tr)(`Tickets · Abiertos: ${row.open || 0} · Reclamados: ${row.claimed || 0} · Cerrados: ${row.closed || 0} · Total: ${row.total || 0}`, `Tickets · Open: ${row.open || 0} · Claimed: ${row.claimed || 0} · Closed: ${row.closed || 0} · Total: ${row.total || 0}`), ephemeral: true });
        return;
    }
    if (name === 'ticket-reopen') {
        const ticketId = i.options.getString('ticket', true).trim().toUpperCase();
        const closed = (0, tickets_1.getTicket)(ticketId);
        if (!closed) {
            await i.reply({ content: (0, i18n_1.tr)('No se encontró ese ticket.', 'Ticket not found.'), ephemeral: true });
            return;
        }
        if (closed.status !== 'closed') {
            await i.reply({ content: (0, i18n_1.tr)('Ese ticket no está cerrado.', 'That ticket is not closed.'), ephemeral: true });
            return;
        }
        let channel = await exports.client.channels.fetch(closed.channel_id).catch(() => null);
        if (!channel?.isTextBased() || !('permissionOverwrites' in channel))
            channel = await (0, tickets_1.recreateTicketChannel)(i.guild, closed);
        (0, tickets_1.updateTicket)(closed, i.user.id, 'reopened');
        if (channel?.isTextBased() && 'permissionOverwrites' in channel) {
            await channel.permissionOverwrites.edit(closed.owner_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => undefined);
            await channel.setName(`ticket-${closed.public_id.toLowerCase()}`).catch(() => undefined);
        }
        await i.reply({ content: (0, i18n_1.localized)(closed.language, `Ticket ${closed.public_id} reabierto: <#${channel?.id}>`, `Ticket ${closed.public_id} reopened: <#${channel?.id}>`), ephemeral: true });
        eventLog(closed, i.user.id, 'reopened');
        return;
    }
    if (name === 'community-create') {
        const title = i.options.getString('title', true), kind = i.options.getString('type', true), body = i.options.getString('description', true), changes = i.options.getString('changes') || '', imageUrl = i.options.getString('image');
        if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
            await i.reply({ content: 'The image must use an https URL.', ephemeral: true });
            return;
        }
        try {
            const post = await (0, community_1.createCommunityPost)(exports.client, { kind, title, body, changes, imageUrl, createdBy: i.user.id });
            await i.reply({ content: post.delivery_state === 'queued' ? `Post #${post.id} added to the queue.` : `Post #${post.id} published to the community board.`, ephemeral: true });
        }
        catch (error) {
            console.error('Could not create community post', error);
            await i.reply({ content: 'Could not publish. Check that the bot can view and send messages in the board channel.', ephemeral: true });
        }
        return;
    }
    if (name === 'community-list') {
        await i.reply({ embeds: [(0, community_1.communityListEmbed)((0, community_1.listPendingCommunityPosts)())], ephemeral: true });
        return;
    }
    const t = (0, tickets_1.getTicketByChannel)(i.channelId);
    if (!t) {
        await i.reply({ content: (0, i18n_1.tr)('Este canal no está asociado a un ticket activo.', 'This channel is not linked to an active ticket.'), ephemeral: true });
        return;
    }
    if (name === 'ticket-close') {
        const modal = new discord_js_1.ModalBuilder().setCustomId('ticket:close-modal').setTitle(`${(0, i18n_1.tr)('Cerrar', 'Close')} ${t.public_id}`)
            .addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId('reason').setLabel((0, i18n_1.tr)('Motivo de cierre', 'Closing reason')).setStyle(discord_js_1.TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
        await i.showModal(modal);
        return;
    }
    if (name === 'ticket-reopen') {
        if (t.status !== 'closed') {
            await i.reply({ content: (0, i18n_1.tr)('El ticket ya está abierto.', 'This ticket is already open.'), ephemeral: true });
            return;
        }
        (0, tickets_1.updateTicket)(t, i.user.id, 'reopened');
        const owner = await i.guild.members.fetch(t.owner_id).catch(() => null);
        if (owner)
            await i.channel.permissionOverwrites.edit(owner.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        await i.channel.setName(`ticket-${t.public_id.toLowerCase()}`).catch(() => undefined);
        await i.reply({ content: (0, i18n_1.tr)(`${t.public_id} reabierto.`, `${t.public_id} reopened.`) });
        eventLog(t, i.user.id, 'reopened');
        return;
    }
    if (name === 'ticket-claim') {
        const result = (0, tickets_1.toggleClaim)(t, i.user.id);
        if (result === 'closed') {
            await i.reply({ content: (0, i18n_1.tr)('Reabre el ticket antes de reclamarlo.', 'Reopen the ticket before claiming it.'), ephemeral: true });
            return;
        }
        if (result === 'conflict')
            await i.reply({ content: (0, i18n_1.tr)(`Este ticket ya está reclamado por <@${t.claimed_by}>.`, `This ticket is already claimed by <@${t.claimed_by}>.`), ephemeral: true });
        else if (result === 'released') {
            await i.reply({ content: (0, i18n_1.tr)('Has liberado el ticket.', 'You released this ticket.') });
            eventLog(t, i.user.id, 'released');
        }
        else {
            await i.reply({ content: (0, i18n_1.tr)(`<@${i.user.id}> se encargará de este ticket.`, `<@${i.user.id}> will handle this ticket.`) });
            eventLog(t, i.user.id, 'claimed');
        }
        return;
    }
    if (name === 'ticket-priority') {
        const p = i.options.getString('priority', true);
        (0, tickets_1.updateTicket)(t, i.user.id, 'priority', p);
        await i.reply({ content: (0, i18n_1.localized)(t.language, `Prioridad actualizada: **${(0, tickets_1.priorityLabel)(p, t.language)}**.`, `Priority updated: **${(0, tickets_1.priorityLabel)(p, t.language)}**.`) });
        eventLog(t, i.user.id, 'priority', p);
        return;
    }
    if (name === 'ticket-transcript') {
        await transcript(i, t);
        return;
    }
    if (name === 'ticket-add' || name === 'ticket-remove') {
        const user = i.options.getUser('user', true);
        const ch = i.channel;
        if (name === 'ticket-add')
            await ch.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
        else
            await ch.permissionOverwrites.delete(user.id).catch(() => undefined);
        eventLog(t, i.user.id, name === 'ticket-add' ? 'user_added' : 'user_removed', user.id);
        await i.reply({ content: (0, i18n_1.localized)(t.language, `<@${user.id}> ${name === 'ticket-add' ? 'añadido al' : 'retirado del'} ticket.`, `<@${user.id}> ${name === 'ticket-add' ? 'added to' : 'removed from'} the ticket.`) });
        return;
    }
    if (name === 'ticket-transfer') {
        const categoryId = i.options.getString('category', true);
        const cat = db_1.db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId);
        if (!cat) {
            await i.reply({ content: (0, i18n_1.tr)('Categoría no válida.', 'Invalid category.'), ephemeral: true });
            return;
        }
        const oldRoles = (0, tickets_1.supportRoleIdsForCategory)(t.category_id);
        const newRoles = (0, tickets_1.supportRoleIdsForCategory)(categoryId);
        const ch = i.channel;
        for (const role of oldRoles.filter(r => !newRoles.includes(r)))
            await ch.permissionOverwrites.delete(role).catch(() => undefined);
        for (const role of newRoles)
            await ch.permissionOverwrites.edit(role, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => undefined);
        (0, tickets_1.updateTicket)(t, i.user.id, 'transferred', categoryId);
        await ch.setParent(cat.discord_category_id || null).catch(() => undefined);
        await ch.setTopic(`Ticket ${t.public_id} · ${cat.name}`).catch(() => undefined);
        eventLog(t, i.user.id, 'transferred', cat.name);
        await i.reply({ content: (0, i18n_1.localized)(t.language, `Ticket transferido a **${cat.name}**.`, `Ticket transferred to **${cat.name}**.`) });
        return;
    }
}
exports.client.on(discord_js_1.Events.InteractionCreate, async (i) => {
    try {
        if (i.isButton() && i.customId.startsWith('community:')) {
            await (0, community_1.handleCommunityButton)(i);
            return;
        }
        if (i.guildId && i.guildId !== config_1.config.DISCORD_GUILD_ID) {
            if (i.isRepliable())
                await i.reply({ content: (0, i18n_1.tr)('Run a Police Tickets solo está habilitado en el servidor Run a Police.', 'Run a Police Tickets is only enabled in the Run a Police server.'), ephemeral: true, allowedMentions: { parse: [] } }).catch(() => undefined);
            return;
        }
        if (i.isAutocomplete() && i.commandName === 'ticket-transfer') {
            const term = i.options.getFocused().toLowerCase();
            return await i.respond((0, tickets_1.getCategories)().filter(c => `${c.name} ${c.id}`.toLowerCase().includes(term)).slice(0, 25).map(c => ({ name: `${c.emoji} ${c.name}`, value: c.id })));
        }
        if (i.isChatInputCommand())
            return await handleCommand(i);
        if (i.isModalSubmit() && i.customId === 'ticket:close-modal') {
            if (!i.guild || !i.channelId) {
                await i.reply({ content: (0, i18n_1.tr)('Canal no disponible.', 'Channel unavailable.'), ephemeral: true });
                return;
            }
            const t = (0, tickets_1.getTicketByChannel)(i.channelId);
            if (!t) {
                await i.reply({ content: (0, i18n_1.tr)('Ticket no encontrado.', 'Ticket not found.'), ephemeral: true });
                return;
            }
            if (i.user.id !== t.owner_id && !await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
                await i.reply({ content: (0, i18n_1.tr)('No tienes permiso.', 'You do not have permission.'), ephemeral: true });
                return;
            }
            await i.deferReply({ ephemeral: true });
            return await closeTicket(i, t, i.fields.getTextInputValue('reason').trim());
        }
        if (i.isModalSubmit() && i.customId.startsWith('ticket:rating-modal:')) {
            if (!i.channelId) {
                await i.reply({ content: (0, i18n_1.tr)('Canal no disponible.', 'Channel unavailable.'), ephemeral: true });
                return;
            }
            const score = Number(i.customId.split(':').at(-1));
            const t = (0, tickets_1.getTicketByChannel)(i.channelId);
            if (!t || t.status !== 'closed' || t.owner_id !== i.user.id || score < 1 || score > 5) {
                await i.reply({ content: (0, i18n_1.localized)(t?.language || 'en', 'No se pudo guardar la valoración.', 'Could not save the rating.'), ephemeral: true });
                return;
            }
            const comment = i.fields.getTextInputValue('comment').trim();
            db_1.db.prepare(`INSERT INTO ratings(ticket_id,user_id,staff_id,score,comment,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(ticket_id) DO UPDATE SET user_id=excluded.user_id,staff_id=excluded.staff_id,score=excluded.score,comment=excluded.comment,created_at=excluded.created_at`)
                .run(t.id, i.user.id, t.claimed_by, score, comment, new Date().toISOString());
            (0, tickets_1.addTicketEvent)(t, i.user.id, 'rating', String(score));
            await i.reply({ content: (0, i18n_1.localized)(t.language, `Gracias por valorar la atención con ${score}/5.`, `Thanks for rating your support experience ${score}/5.`), ephemeral: true });
            return;
        }
        if (i.isStringSelectMenu() && (i.customId === 'ticket:category' || i.customId.startsWith('ticket:category:'))) {
            if (!i.guild)
                return;
            const locale = (i.customId.split(':')[2] || 'en');
            await i.deferReply({ ephemeral: true });
            try {
                const ticket = await (0, tickets_1.createTicket)(i.guild, i.user.id, i.values[0], locale);
                await i.editReply((0, i18n_1.localized)(locale, `Ticket **${ticket.public_id}** creado: <#${ticket.channel_id}>`, `Ticket **${ticket.public_id}** created: <#${ticket.channel_id}>`));
                eventLog(ticket, i.user.id, 'opened', ticket.category_id);
            }
            finally {
                await i.message.edit({ components: (0, tickets_1.panelComponents)(locale), allowedMentions: { parse: [] } }).catch(error => console.error('Could not reset ticket category menu', error));
            }
            return;
        }
        if (i.isButton() && i.customId.startsWith('ticket:')) {
            if (!i.guild)
                return;
            const t = (0, tickets_1.getTicketByChannel)(i.channelId);
            if (!t) {
                await i.reply({ content: (0, i18n_1.tr)('Ticket no encontrado.', 'Ticket not found.'), ephemeral: true });
                return;
            }
            if (i.customId.startsWith('ticket:rate:')) {
                const score = Number(i.customId.split(':').at(-1));
                if (i.user.id !== t.owner_id || t.status !== 'closed' || score < 1 || score > 5) {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, 'Solo quien abrió el ticket puede valorarlo al cerrarse.', 'Only the ticket creator can rate it after closure.'), ephemeral: true });
                    return;
                }
                const modal = new discord_js_1.ModalBuilder().setCustomId(`ticket:rating-modal:${score}`).setTitle((0, i18n_1.localized)(t.language, `Valorar atención · ${score}/5`, `Rate support · ${score}/5`)).addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId('comment').setLabel((0, i18n_1.localized)(t.language, 'Comentario (opcional)', 'Comment (optional)')).setStyle(discord_js_1.TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
                await i.showModal(modal);
                return;
            }
            if (i.customId === 'ticket:close') {
                if (i.user.id !== t.owner_id && !await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, 'No tienes permiso para cerrar este ticket.', 'You do not have permission to close this ticket.'), ephemeral: true });
                    return;
                }
                const modal = new discord_js_1.ModalBuilder().setCustomId('ticket:close-modal').setTitle(`${(0, i18n_1.localized)(t.language, 'Cerrar', 'Close')} ${t.public_id}`).addComponents(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.TextInputBuilder().setCustomId('reason').setLabel((0, i18n_1.localized)(t.language, 'Motivo de cierre', 'Closing reason')).setStyle(discord_js_1.TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
                await i.showModal(modal);
                return;
            }
            if (i.customId === 'ticket:claim') {
                if (!await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, 'Solo el equipo de soporte puede reclamar tickets.', 'Only support staff can claim tickets.'), ephemeral: true });
                    return;
                }
                const type = (0, tickets_1.toggleClaim)(t, i.user.id);
                if (type === 'closed') {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, 'Este ticket está cerrado.', 'This ticket is closed.'), ephemeral: true });
                    return;
                }
                if (type === 'conflict') {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, `Este ticket ya está reclamado por <@${t.claimed_by}>.`, `This ticket is already claimed by <@${t.claimed_by}>.`), ephemeral: true });
                    return;
                }
                eventLog(t, i.user.id, type);
                await i.reply({ content: type === 'claimed' ? (0, i18n_1.localized)(t.language, `<@${i.user.id}> atenderá este ticket.`, `<@${i.user.id}> will handle this ticket.`) : (0, i18n_1.localized)(t.language, 'Ticket liberado.', 'Ticket released.') });
                return;
            }
            if (i.customId === 'ticket:priority') {
                if (!await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, 'Solo el equipo de soporte puede cambiar la prioridad.', 'Only support staff can change priority.'), ephemeral: true });
                    return;
                }
                const menu = new discord_js_1.StringSelectMenuBuilder().setCustomId('ticket:priority-select').setPlaceholder((0, i18n_1.localized)(t.language, 'Selecciona prioridad', 'Select priority')).addOptions(...Object.keys(tickets_1.priorityNames).map(value => ({ label: (0, tickets_1.priorityLabel)(value, t.language), value })));
                await i.reply({ content: (0, i18n_1.localized)(t.language, 'Prioridad del ticket:', 'Ticket priority:'), components: [new discord_js_1.ActionRowBuilder().addComponents(menu)], ephemeral: true });
                return;
            }
            if (i.customId === 'ticket:reopen') {
                if (!await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
                    await i.reply({ content: (0, i18n_1.localized)(t.language, 'Solo el equipo de soporte puede reabrir tickets.', 'Only support staff can reopen tickets.'), ephemeral: true });
                    return;
                }
                (0, tickets_1.updateTicket)(t, i.user.id, 'reopened');
                const owner = await i.guild.members.fetch(t.owner_id).catch(() => null);
                if (owner)
                    await i.channel.permissionOverwrites.edit(owner.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
                await i.channel.setName(`ticket-${t.public_id.toLowerCase()}`).catch(() => undefined);
                eventLog(t, i.user.id, 'reopened');
                await i.reply({ content: (0, i18n_1.localized)(t.language, 'Ticket reabierto.', 'Ticket reopened.') });
                return;
            }
        }
        if (i.isStringSelectMenu() && i.customId === 'ticket:priority-select') {
            const t = (0, tickets_1.getTicketByChannel)(i.channelId);
            if (!t)
                return i.reply({ content: (0, i18n_1.tr)('Ticket no encontrado.', 'Ticket not found.'), ephemeral: true });
            if (!i.guild || !await (0, tickets_1.isStaff)(i.guild, i.user.id)) {
                await i.reply({ content: (0, i18n_1.localized)(t.language, 'Solo el equipo de soporte puede cambiar la prioridad.', 'Only support staff can change priority.'), ephemeral: true });
                return;
            }
            const priority = i.values[0];
            (0, tickets_1.updateTicket)(t, i.user.id, 'priority', priority);
            eventLog(t, i.user.id, 'priority', priority);
            await i.update({ content: (0, i18n_1.localized)(t.language, `Prioridad: **${(0, tickets_1.priorityLabel)(priority, t.language)}**.`, `Priority: **${(0, tickets_1.priorityLabel)(priority, t.language)}**.`), components: [] });
        }
    }
    catch (error) {
        (0, audit_1.recordSystemError)(exports.client, error, `Discord interaction ${i.type}`);
        if ('isRepliable' in i && i.isRepliable()) {
            const ticket = 'channelId' in i && typeof i.channelId === 'string' ? (0, tickets_1.getTicketByChannel)(i.channelId) : undefined;
            const customId = i.customId;
            const locale = (typeof customId === 'string' && customId.startsWith('ticket:category:') ? customId.split(':')[2] : ticket?.language || 'en');
            const payload = { content: (0, i18n_1.localized)(locale, 'Ocurrió un error al procesar la acción. Inténtalo nuevamente.', 'Something went wrong while processing this action. Please try again.'), ephemeral: true };
            if (i.deferred)
                await i.followUp(payload).catch(() => undefined);
            else if (!i.replied)
                await i.reply(payload).catch(() => undefined);
        }
    }
});
async function handleReactionRole(reaction, user, action) {
    if (user.bot)
        return;
    try {
        if (reaction.partial)
            await reaction.fetch();
        const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
        if (!message.guild)
            return;
        const panel = (0, db_1.getSetting)('reactionRolePanel', { messageId: '', mappings: [] });
        if (!panel.messageId || panel.messageId !== message.id)
            return;
        const emojiKey = reaction.emoji.id || reaction.emoji.name;
        const mapping = panel.mappings.find(item => item.emojiKey === emojiKey || item.emoji === emojiKey);
        if (!mapping)
            return;
        const guild = message.guild, role = await guild.roles.fetch(mapping.roleId), member = await guild.members.fetch(user.id);
        const botMember = guild.members.me;
        if (!role || !botMember?.permissions.has(discord_js_1.PermissionFlagsBits.ManageRoles) || role.position >= botMember.roles.highest.position)
            return;
        if (action === 'add')
            await member.roles.add(role, 'Reaction role assignment');
        else
            await member.roles.remove(role, 'Reaction role removal');
    }
    catch (error) {
        (0, audit_1.recordSystemError)(exports.client, error, `Reaction role ${action}`);
    }
}
exports.client.on(discord_js_1.Events.MessageReactionAdd, async (reaction, user) => {
    await handleReactionRole(reaction, user, 'add');
    if (user.bot)
        return;
    try {
        if (reaction.partial)
            await reaction.fetch();
        const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
        await (0, community_1.inspectForumReaction)(exports.client, message);
    }
    catch (error) {
        (0, audit_1.recordSystemError)(exports.client, error, 'Forum reaction tracking');
    }
});
exports.client.on(discord_js_1.Events.MessageReactionRemove, (reaction, user) => handleReactionRole(reaction, user, 'remove'));
exports.client.once(discord_js_1.Events.ClientReady, () => { void (0, community_1.recoverCommunityQueue)(exports.client).then(() => (0, community_1.scanActiveForumThreads)(exports.client)).catch(error => (0, audit_1.recordSystemError)(exports.client, error, 'Community queue startup')); });
exports.client.once(discord_js_1.Events.ClientReady, c => console.log(`Discord ready as ${c.user.tag}`));
exports.client.on(discord_js_1.Events.Error, e => (0, audit_1.recordSystemError)(exports.client, e, 'Discord client error'));
exports.client.on(discord_js_1.Events.MessageCreate, message => {
    if (!message.guild || message.author.bot || !message.member)
        return;
    const ticket = (0, tickets_1.getTicketByChannel)(message.channelId);
    if (!ticket || ticket.status === 'closed')
        return;
    const member = message.member;
    if (!member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator) && !(0, tickets_1.isSupportRole)([...member.roles.cache.keys()]))
        return;
    const exists = db_1.db.prepare("SELECT 1 FROM ticket_events WHERE ticket_id=? AND type='staff_response' LIMIT 1").get(ticket.id);
    if (!exists)
        (0, tickets_1.addTicketEvent)(ticket, message.author.id, 'staff_response');
    const participated = db_1.db.prepare("SELECT 1 FROM ticket_events WHERE ticket_id=? AND type='staff_participated' AND actor_id=? LIMIT 1").get(ticket.id, message.author.id);
    if (!participated)
        (0, tickets_1.addTicketEvent)(ticket, message.author.id, 'staff_participated');
});
