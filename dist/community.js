"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORUM_REACTION_THRESHOLD = exports.MAX_ACTIVE_COMMUNITY_POSTS = void 0;
exports.createCommunityPost = createCommunityPost;
exports.fillCommunityQueue = fillCommunityQueue;
exports.recoverCommunityQueue = recoverCommunityQueue;
exports.forwardForumThread = forwardForumThread;
exports.inspectForumReaction = inspectForumReaction;
exports.handleCommunityButton = handleCommunityButton;
exports.listPendingCommunityPosts = listPendingCommunityPosts;
exports.communityListEmbed = communityListEmbed;
exports.updateCommunityPostPriority = updateCommunityPostPriority;
exports.scanActiveForumThreads = scanActiveForumThreads;
const discord_js_1 = require("discord.js");
const db_1 = require("./db");
const tickets_1 = require("./tickets");
const server_defaults_1 = require("./server-defaults");
exports.MAX_ACTIVE_COMMUNITY_POSTS = 8;
exports.FORUM_REACTION_THRESHOLD = 10;
const names = { task: 'Pending task', error: 'Bug', problem: 'Problem', suggestion: 'Suggestion' };
const priorityNames = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const kindColor = { task: 0x3b82f6, error: 0xef4444, problem: 0xf59e0b, suggestion: 0x8b5cf6 };
const clip = (value, max) => value.trim().slice(0, max);
const safeImage = (value) => { if (!value)
    return null; try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
}
catch {
    return null;
} };
const targetId = () => (0, db_1.getSetting)('communityBoardChannelId', server_defaults_1.DEFAULT_COMMUNITY_BOARD_CHANNEL_ID) || server_defaults_1.DEFAULT_COMMUNITY_BOARD_CHANNEL_ID;
const votesFor = (id) => db_1.db.prepare('SELECT COUNT(*) n FROM community_votes WHERE post_id=?').get(id).n;
const label = (kind) => names[kind];
const isApproved = (post) => post.status === 'approved';
function components(post, votes) {
    return [new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`community:vote:${post.id}`).setLabel(`👍 Vote · ${votes}`).setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder().setCustomId(`community:approve:${post.id}`).setLabel('✅ Approved · Completed').setStyle(discord_js_1.ButtonStyle.Success).setDisabled(isApproved(post)))];
}
function postEmbed(post, votes = votesFor(post.id)) {
    const approved = isApproved(post), embed = new discord_js_1.EmbedBuilder().setColor(approved ? 0x22c55e : kindColor[post.kind]).setTitle(`${names[post.kind]} · ${post.title}`.slice(0, 256)).setDescription(post.body || 'No additional description.').addFields({ name: 'Status', value: approved ? 'Approved · Completed' : 'Pending', inline: true }, { name: 'Priority', value: priorityNames[post.priority] || 'Normal', inline: true }, { name: 'Staff votes', value: String(votes), inline: true }, { name: 'Forum reactions', value: String(post.source_votes), inline: true }).setFooter({ text: `Run a Police · Community Board #${post.id}` }).setTimestamp(new Date(post.created_at));
    if (post.changes)
        embed.addFields({ name: 'Changes included', value: post.changes.slice(0, 1024) });
    if (post.source_thread_id)
        embed.addFields({ name: 'Original forum post', value: `https://discord.com/channels/${process.env.DISCORD_GUILD_ID || '0'}/${post.source_thread_id}` });
    if (approved && post.approved_by)
        embed.addFields({ name: 'Approved by', value: `<@${post.approved_by}>`, inline: true });
    if (post.image_url)
        embed.setImage(post.image_url);
    return embed;
}
function reservePost(input) {
    return db_1.db.transaction(() => {
        const destination = targetId();
        const active = db_1.db.prepare("SELECT COUNT(*) n FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state IN ('publishing','published')").get(destination).n;
        const queued = db_1.db.prepare("SELECT COUNT(*) n FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state='queued'").get(destination).n;
        const deliveryState = active < exports.MAX_ACTIVE_COMMUNITY_POSTS && queued === 0 ? 'publishing' : 'queued';
        const result = db_1.db.prepare(`INSERT INTO community_posts(source_thread_id,target_channel_id,kind,title,body,changes,image_url,source_votes,delivery_state,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.sourceThreadId || null, destination, input.kind, clip(input.title, 200), clip(input.body || '', 3800), clip(input.changes || '', 1000), safeImage(input.imageUrl), input.sourceVotes || 0, deliveryState, input.createdBy, new Date().toISOString());
        return db_1.db.prepare('SELECT * FROM community_posts WHERE id=?').get(Number(result.lastInsertRowid));
    })();
}
async function publishReservedPost(client, post) {
    try {
        const target = await client.channels.fetch(post.target_channel_id);
        if (!target?.isTextBased() || !('send' in target))
            throw new Error(`Community board ${post.target_channel_id} is not a text channel.`);
        const message = await target.send({ embeds: [postEmbed(post, 0)], components: components(post, 0), allowedMentions: { parse: [] } });
        db_1.db.prepare("UPDATE community_posts SET target_message_id=?,delivery_state='published' WHERE id=?").run(message.id, post.id);
        return { ...post, target_message_id: message.id, delivery_state: 'published' };
    }
    catch (error) {
        db_1.db.prepare("UPDATE community_posts SET delivery_state='queued',target_message_id=NULL WHERE id=? AND status='pending'").run(post.id);
        throw error;
    }
}
async function createCommunityPost(client, input) {
    if (input.sourceThreadId && db_1.db.prepare('SELECT id FROM community_posts WHERE source_thread_id=?').get(input.sourceThreadId))
        throw new Error('This forum post was already forwarded.');
    const post = reservePost(input);
    if (post.delivery_state === 'queued')
        return post;
    try {
        return await publishReservedPost(client, post);
    }
    catch (error) {
        console.error('Community post queued after delivery failure', error);
        return db_1.db.prepare('SELECT * FROM community_posts WHERE id=?').get(post.id);
    }
}
async function fillCommunityQueue(client) {
    let published = 0;
    while (true) {
        const reserved = db_1.db.transaction(() => {
            const destination = targetId();
            const active = db_1.db.prepare("SELECT COUNT(*) n FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state IN ('publishing','published')").get(destination).n;
            if (active >= exports.MAX_ACTIVE_COMMUNITY_POSTS)
                return null;
            const next = db_1.db.prepare("SELECT id FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state='queued' ORDER BY created_at,id LIMIT 1").get(destination);
            if (!next)
                return null;
            db_1.db.prepare("UPDATE community_posts SET delivery_state='publishing' WHERE id=? AND delivery_state='queued'").run(next.id);
            return db_1.db.prepare('SELECT * FROM community_posts WHERE id=?').get(next.id);
        })();
        if (!reserved)
            break;
        try {
            await publishReservedPost(client, reserved);
            published++;
        }
        catch (error) {
            console.error('Could not publish queued community post', error);
            break;
        }
    }
    return published;
}
async function recoverCommunityQueue(client) {
    db_1.db.prepare("UPDATE community_posts SET delivery_state='queued',target_message_id=NULL WHERE status='pending' AND delivery_state='publishing' AND target_message_id IS NULL").run();
    const overflow = db_1.db.prepare("SELECT id,target_channel_id,target_message_id FROM community_posts WHERE status='pending' AND delivery_state='published' ORDER BY created_at,id LIMIT -1 OFFSET ?").all(exports.MAX_ACTIVE_COMMUNITY_POSTS);
    for (const row of overflow) {
        try {
            const channel = await client.channels.fetch(row.target_channel_id);
            if (channel?.isTextBased() && 'messages' in channel && row.target_message_id) {
                const message = await channel.messages.fetch(row.target_message_id).catch(() => null);
                if (message)
                    await message.delete();
            }
            db_1.db.prepare("UPDATE community_posts SET delivery_state='queued',target_message_id=NULL WHERE id=? AND status='pending'").run(row.id);
        }
        catch (error) {
            console.error(`Could not move overflow community post #${row.id} into queue`, error);
        }
    }
    await fillCommunityQueue(client);
}
function inferKind(thread, body) {
    const forum = thread.parent;
    if (forum?.type === discord_js_1.ChannelType.GuildForum) {
        const tags = forum.availableTags.filter(tag => thread.appliedTags.includes(tag.id)).map(tag => tag.name).join(' ').toLowerCase();
        if (/error|bug|fallo/.test(tags))
            return 'error';
        if (/problem|problema|issue/.test(tags))
            return 'problem';
        if (/task|tarea|todo/.test(tags))
            return 'task';
        if (/suggest|suger/.test(tags))
            return 'suggestion';
    }
    const source = `${thread.name} ${body}`.toLowerCase();
    if (/\b(error|bug|fallo|error\s+report)\b/.test(source))
        return 'error';
    if (/\b(problema|problem|issue)\b/.test(source))
        return 'problem';
    if (/\b(tarea|task|todo|pendiente)\b/.test(source))
        return 'task';
    return 'suggestion';
}
function imageFrom(message) {
    const attachment = [...message.attachments.values()].find(a => a.contentType?.startsWith('image/'));
    return safeImage(attachment?.url || message.embeds.find(e => e.image?.url)?.image?.url || null);
}
async function countThreadReactions(thread) {
    const messages = await thread.messages.fetch({ limit: 100 });
    const starter = await thread.fetchStarterMessage().catch(() => null);
    const all = new Map(messages.map(message => [message.id, message]));
    if (starter)
        all.set(starter.id, starter);
    return [...all.values()].reduce((sum, message) => sum + [...message.reactions.cache.values()].reduce((total, reaction) => total + Math.max(0, reaction.count - (reaction.me ? 1 : 0)), 0), 0);
}
async function forwardForumThread(client, thread, reactionCount) {
    if (thread.parentId !== server_defaults_1.DEFAULT_COMMUNITY_FORUM_ID || reactionCount <= exports.FORUM_REACTION_THRESHOLD)
        return;
    if (db_1.db.prepare('SELECT id FROM community_posts WHERE source_thread_id=?').get(thread.id))
        return;
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (!starter)
        return;
    const content = starter.content || '';
    const changeMatch = content.match(/(?:cambios?|changes?)\s*:\s*([\s\S]+)$/i);
    const post = await createCommunityPost(client, { sourceThreadId: thread.id, kind: inferKind(thread, content), title: thread.name, body: content || 'Forum post without text.', changes: changeMatch?.[1] || '', imageUrl: imageFrom(starter), sourceVotes: reactionCount, createdBy: starter.author.id });
    void post;
}
async function inspectForumReaction(client, message) {
    if (!message.guild || message.guild.id !== process.env.DISCORD_GUILD_ID)
        return;
    const thread = message.channel;
    if (!thread.isThread() || thread.parentId !== server_defaults_1.DEFAULT_COMMUNITY_FORUM_ID)
        return;
    const count = await countThreadReactions(thread);
    if (count > exports.FORUM_REACTION_THRESHOLD)
        await forwardForumThread(client, thread, count);
}
async function handleCommunityButton(interaction) {
    const match = interaction.customId.match(/^community:(vote|approve):(\d+)$/);
    if (!match)
        return false;
    const [, action, idText] = match, id = Number(idText), post = db_1.db.prepare('SELECT * FROM community_posts WHERE id=?').get(id);
    if (!post) {
        await interaction.reply({ content: 'This post no longer exists.', ephemeral: true });
        return true;
    }
    if (action === 'approve') {
        if (interaction.user.id !== server_defaults_1.DEFAULT_PROJECT_OWNER_ID) {
            await interaction.reply({ content: 'Only the project owner can approve and mark this as completed.', ephemeral: true });
            return true;
        }
        if (post.status !== 'approved')
            db_1.db.prepare('UPDATE community_posts SET status=\'approved\',approved_by=?,approved_at=? WHERE id=?').run(interaction.user.id, new Date().toISOString(), id);
    }
    else {
        if (!interaction.guild || !await (0, tickets_1.isStaff)(interaction.guild, interaction.user.id)) {
            await interaction.reply({ content: 'Only support staff can vote on board items.', ephemeral: true });
            return true;
        }
        db_1.db.transaction(() => {
            const exists = db_1.db.prepare('SELECT 1 FROM community_votes WHERE post_id=? AND user_id=?').get(id, interaction.user.id);
            if (exists)
                db_1.db.prepare('DELETE FROM community_votes WHERE post_id=? AND user_id=?').run(id, interaction.user.id);
            else
                db_1.db.prepare('INSERT INTO community_votes(post_id,user_id,created_at) VALUES(?,?,?)').run(id, interaction.user.id, new Date().toISOString());
        })();
    }
    const updated = db_1.db.prepare('SELECT * FROM community_posts WHERE id=?').get(id);
    const votes = votesFor(id), embed = postEmbed(updated, votes), rows = components(updated, votes);
    try {
        await interaction.message.edit({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
    }
    catch (error) {
        console.error('Could not update community board embed', error);
    }
    const promoted = action === 'approve' ? await fillCommunityQueue(interaction.client) : 0;
    await interaction.reply({ content: action === 'approve' ? `Marked approved and completed.${promoted ? ` Published ${promoted} queued item${promoted === 1 ? '' : 's'}.` : ''}` : `Vote updated · ${votes} staff votes.`, ephemeral: true });
    return true;
}
function listPendingCommunityPosts(limit = 10) {
    return db_1.db.prepare("SELECT p.*,(SELECT COUNT(*) FROM community_votes v WHERE v.post_id=p.id) board_votes FROM community_posts p WHERE p.status='pending' ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,p.source_votes+(SELECT COUNT(*) FROM community_votes v2 WHERE v2.post_id=p.id) DESC,p.created_at DESC LIMIT ?").all(limit);
}
function communityListEmbed(posts) {
    const embed = new discord_js_1.EmbedBuilder().setColor(0x3b82f6).setTitle('Community backlog').setDescription(posts.length ? 'Forum reactions and staff votes for tasks, bugs, problems, and suggestions.' : 'There are no pending posts.');
    for (const p of posts)
        embed.addFields({ name: `#${p.id} · ${priorityNames[p.priority] || 'Normal'} · ${label(p.kind)} · ${p.title}`.slice(0, 256), value: `${p.delivery_state === 'queued' ? 'Queued' : 'Posted'} · Forum reactions: ${p.source_votes} · Staff votes: ${p.board_votes ?? votesFor(p.id)} · <#${p.target_channel_id}>` });
    return embed;
}
async function updateCommunityPostPriority(client, id, priority) {
    const current = db_1.db.prepare('SELECT * FROM community_posts WHERE id=?').get(id);
    if (!current)
        return null;
    db_1.db.prepare('UPDATE community_posts SET priority=? WHERE id=?').run(priority, id);
    const post = db_1.db.prepare('SELECT *,(SELECT COUNT(*) FROM community_votes WHERE post_id=?) board_votes FROM community_posts WHERE id=?').get(id, id);
    if (!post.target_message_id || post.delivery_state !== 'published')
        return { post, boardUpdated: true };
    try {
        const channel = await client.channels.fetch(post.target_channel_id);
        if (!channel?.isTextBased() || !('messages' in channel))
            return { post, boardUpdated: false };
        const message = await channel.messages.fetch(post.target_message_id);
        await message.edit({ embeds: [postEmbed(post, post.board_votes)], components: components(post, post.board_votes || 0), allowedMentions: { parse: [] } });
        return { post, boardUpdated: true };
    }
    catch (error) {
        console.error(`Could not update priority on community post #${id}`, error);
        return { post, boardUpdated: false };
    }
}
async function scanActiveForumThreads(client) {
    const forum = await client.channels.fetch(server_defaults_1.DEFAULT_COMMUNITY_FORUM_ID).catch(() => null);
    if (!forum || forum.type !== discord_js_1.ChannelType.GuildForum)
        return;
    const active = await forum.threads.fetchActive().catch(() => null);
    if (!active)
        return;
    for (const thread of active.threads.values()) {
        const count = await countThreadReactions(thread).catch(() => 0);
        if (count > exports.FORUM_REACTION_THRESHOLD)
            await forwardForumThread(client, thread, count).catch(error => console.error('Could not forward popular forum post', error));
    }
}
