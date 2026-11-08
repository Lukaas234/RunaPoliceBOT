import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client, Events,
  GatewayIntentBits, ModalBuilder, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, ChannelType, Partials,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, TextChannel
} from 'discord.js';
import { config } from './config';
import { db, getLocalizedSetting, getSetting, setSetting } from './db';
import { addTicketEvent, createTicket, getCategories, getTicket, getTicketByChannel, isStaff, isSupportRole, panelComponents, priorityLabel, priorityNames, recreateTicketChannel, supportRoleIdsForCategory, Ticket, TicketPriority, toggleClaim, updateTicket } from './tickets';
import { generateTranscript, sendTranscriptToDiscord } from './transcripts';
import { recordSystemError, sendAudit } from './audit';
import { AppLanguage, localized, tr } from './i18n';
import { DEFAULT_ES_PANEL_CHANNEL_ID, DEFAULT_PANEL_CHANNEL_ID } from './server-defaults';
import { communityListEmbed, createCommunityPost, handleCommunityButton, inspectForumReaction, listPendingCommunityPosts, recoverCommunityQueue, scanActiveForumThreads, CommunityKind } from './community';

export const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildMessageReactions],partials:[Partials.Message,Partials.Channel,Partials.Reaction]});
// Discord's command UI permission hint is intentionally broad; every action is checked again server-side.
const staffCommand=(c:any)=>c;
const commands=()=>[
  new SlashCommandBuilder().setName('ticket').setDescription(tr('Consulta la ayuda y el panel de tickets.','View ticket help and the support panel.')),
  staffCommand(new SlashCommandBuilder().setName('ticket-panel').setDescription(tr('Publica o actualiza el panel de tickets.','Post or update the ticket panel.'))
    .addChannelOption(o=>o.setName('channel').setDescription(tr('Canal donde publicar el panel','Channel for the panel')).addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName('language').setDescription('Panel language').addChoices({name:'English',value:'en'},{name:'Español',value:'es'}))),
  staffCommand(new SlashCommandBuilder().setName('ticket-setup').setDescription(tr('Comprueba la configuración del bot.','Check the bot configuration.'))),
  staffCommand(new SlashCommandBuilder().setName('ticket-stats').setDescription(tr('Muestra el resumen de tickets.','Show a ticket summary.'))),
  staffCommand(new SlashCommandBuilder().setName('ticket-close').setDescription(tr('Cierra y elimina el canal del ticket.','Close the ticket and delete its channel.'))),
  staffCommand(new SlashCommandBuilder().setName('ticket-reopen').setDescription(tr('Reabre un ticket cerrado por su ID.','Reopen a closed ticket by its ID.'))
    .addStringOption(o=>o.setName('ticket').setDescription(tr('ID del ticket, por ejemplo RAP-000123','Ticket ID, for example RAP-000123')).setRequired(true))),
  staffCommand(new SlashCommandBuilder().setName('ticket-claim').setDescription(tr('Reclama o libera el ticket actual.','Claim or release the current ticket.'))),
  staffCommand(new SlashCommandBuilder().setName('ticket-priority').setDescription(tr('Cambia la prioridad del ticket actual.','Change the current ticket priority.'))
    .addStringOption(o=>o.setName('priority').setDescription(tr('Prioridad nueva','New priority')).setRequired(true).addChoices(
      {name:tr('Baja','Low'),value:'low'},{name:'Normal',value:'normal'},{name:tr('Alta','High'),value:'high'},{name:tr('Urgente','Urgent'),value:'urgent'}))),
  staffCommand(new SlashCommandBuilder().setName('ticket-add').setDescription(tr('Añade un usuario al ticket actual.','Add a user to the current ticket.'))
    .addUserOption(o=>o.setName('user').setDescription(tr('Usuario a añadir','User to add')).setRequired(true))),
  staffCommand(new SlashCommandBuilder().setName('ticket-remove').setDescription(tr('Quita un usuario del ticket actual.','Remove a user from the current ticket.'))
    .addUserOption(o=>o.setName('user').setDescription(tr('Usuario a quitar','User to remove')).setRequired(true))),
  staffCommand(new SlashCommandBuilder().setName('ticket-transcript').setDescription(tr('Genera o actualiza el transcript del ticket actual.','Generate or update the current ticket transcript.'))),
  staffCommand(new SlashCommandBuilder().setName('ticket-transfer').setDescription(tr('Transfiere el ticket a otra categoría.','Transfer the ticket to another category.'))
    .addStringOption(o=>o.setName('category').setDescription(tr('Categoría de destino','Destination category')).setRequired(true).setAutocomplete(true))),
  staffCommand(new SlashCommandBuilder().setName('community-create').setDescription('Post a task, bug, problem, or suggestion.')
    .addStringOption(o=>o.setName('title').setDescription('Short title').setRequired(true))
    .addStringOption(o=>o.setName('type').setDescription('Post type').setRequired(true).addChoices(
      {name:'Pending task',value:'task'},{name:'Bug',value:'error'},{name:'Problem',value:'problem'},{name:'Suggestion',value:'suggestion'}))
    .addStringOption(o=>o.setName('description').setDescription('Description').setRequired(true))
    .addStringOption(o=>o.setName('changes').setDescription('Changes included (optional)').setRequired(false))
    .addStringOption(o=>o.setName('image').setDescription('Image https URL (optional)').setRequired(false))),
  staffCommand(new SlashCommandBuilder().setName('community-list').setDescription('Show pending items ordered by forum reactions and votes.'))
];

export async function registerCommands() {
  const rest=new REST({version:'10'}).setToken(config.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID,config.DISCORD_GUILD_ID),{body:commands().map(c=>c.toJSON())});
}
export async function startDiscord() {
  await client.login(config.DISCORD_TOKEN);
  if(!client.isReady()) await new Promise<void>(resolve=>client.once(Events.ClientReady,()=>resolve()));
}
export async function refreshPanel(bot:Client=client):Promise<void> {
  for(const locale of ['en','es'] as AppLanguage[]) await publishPanel(bot,locale);
}
async function publishPanel(bot:Client,locale:AppLanguage,targetOverride?:string):Promise<void> {
  const fallback=locale==='en'?DEFAULT_PANEL_CHANNEL_ID:DEFAULT_ES_PANEL_CHANNEL_ID;
  const targetId=targetOverride||getLocalizedSetting<string>('panelChannelId',locale,fallback)||fallback;
  const oldChannelId=getSetting<string>(`panelMessageChannelId_${locale}`,locale==='en'?getSetting('panelMessageChannelId',''):''),messageId=getSetting<string>(`panelMessageId_${locale}`,locale==='en'?getSetting('panelMessageId',''):'');
  const target=await bot.channels.fetch(targetId).catch(()=>null);
  if(!target?.isTextBased()||!('messages' in target))return;
  const description=getLocalizedSetting('panelMessage',locale,localized(locale,'Selecciona una categoría para abrir un ticket privado.','Choose a category to open a private ticket.'));
  const embed={color:0x3b82f6,title:localized(locale,'Run a Police · Centro de soporte','Run a Police · Support Center'),description,footer:{text:`Run a Police Tickets · ${locale.toUpperCase()} PANEL`}};
  const oldChannel=oldChannelId?await bot.channels.fetch(oldChannelId).catch(()=>null):null;
  let oldMessage=oldChannel?.isTextBased()&&'messages' in oldChannel&&messageId?await oldChannel.messages.fetch(messageId).catch(()=>null):null;
  // If the saved pointer was lost, find this bot's panel before posting another one.
  if(!oldMessage) {
    const recent=await (target as TextChannel).messages.fetch({limit:100}).catch(()=>null);
    oldMessage=recent?.find(m=>m.author.id===bot.user?.id&&m.components.some((row:any)=>Array.isArray(row.components)&&row.components.some((c:any)=>c.customId===`ticket:category:${locale}`||locale==='en'&&c.customId==='ticket:category')))??null;
  }
  if(oldMessage&&oldMessage.channelId===targetId) await oldMessage.edit({embeds:[embed],components:panelComponents(locale),allowedMentions:{parse:[]}});
  else {
    if(oldMessage) await oldMessage.edit({content:localized(locale,'Este panel fue movido. Usa el panel actualizado.','This panel has moved. Use the updated panel.'),components:[]}).catch(()=>undefined);
    oldMessage=await (target as TextChannel).send({embeds:[embed],components:panelComponents(locale),allowedMentions:{parse:[]}});
  }
  setSetting(`panelChannelId_${locale}`,targetId);setSetting(`panelMessageChannelId_${locale}`,targetId);setSetting(`panelMessageId_${locale}`,oldMessage.id);
  if(locale==='en'){setSetting('panelChannelId',targetId);setSetting('panelMessageChannelId',targetId);setSetting('panelMessageId',oldMessage.id);}
}
function eventLog(ticket:Ticket, actor:string, type:string, detail='') {
  if(type==='user_added'||type==='user_removed') addTicketEvent(ticket,actor,type,detail);
  void sendAudit(client,`**${type}** · ${ticket.public_id} · <@${actor}>${detail?` · ${detail}`:''}`,ticket.language);
}
async function staffOnly(i:ChatInputCommandInteraction):Promise<boolean> {
  if(!i.guild||!await isStaff(i.guild,i.user.id)) { await i.reply({content:tr('No tienes permiso para gestionar tickets.','You do not have permission to manage tickets.'),ephemeral:true}); return false; }
  return true;
}
async function transcript(i:ChatInputCommandInteraction,t:Ticket) {
  if(!i.deferred&&!i.replied) await i.deferReply({ephemeral:true});
  const html=await generateTranscript(t,i.channel as TextChannel,i.user.id);
  let sent=false;try {await sendTranscriptToDiscord(client,t,html);sent=true;}catch(error){console.error('Could not send transcript to Discord',error);}
  await i.editReply({content:sent?localized(t.language,`Transcripción ${t.public_id} generada y enviada al canal de transcripciones.`,`Transcript ${t.public_id} generated and sent to the transcript channel.`):localized(t.language,`La transcripción ${t.public_id} se guardó en el panel, pero no se pudo enviar a Discord.`,`Transcript ${t.public_id} was saved in the dashboard but could not be sent to Discord.`)});
}
async function closeTicket(i:any,t:Ticket,reason:string) {
  if(t.status==='closed') { await i.reply({content:localized(t.language,'Este ticket ya está cerrado.','This ticket is already closed.'),ephemeral:true}); return; }
  updateTicket(t,i.user.id,'closed',reason||'No reason provided');
  const updated=db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id) as Ticket;
  const ch=i.channel as TextChannel;
  const owner=await ch.guild.members.fetch(t.owner_id).catch(()=>null);
  if(owner) await ch.permissionOverwrites.edit(owner.id,{SendMessages:false,AddReactions:false}).catch(()=>undefined);
  await ch.setName(`${t.language==='es'?'cerrado':'closed'}-${t.public_id.toLowerCase()}`).catch(()=>undefined);
  const html=await generateTranscript(updated,ch,i.user.id).catch(e=>{console.error('Transcript generation failed',e);return null;});
  let sent=false;if(html)try {await sendTranscriptToDiscord(client,updated,html);sent=true;}catch(error){console.error('Could not send closed ticket transcript to Discord',error);}
  const ratingRow=new ActionRowBuilder<ButtonBuilder>().addComponents(...[1,2,3,4,5].map(score=>new ButtonBuilder().setCustomId(`ticket:rate:${score}`).setLabel(`${score} ★`).setStyle(ButtonStyle.Secondary)));
  const response={content:localized(t.language,`Ticket cerrado. Motivo: **${reason||'Sin motivo indicado'}**${sent?' · La transcripción se guardó en el panel y se envió a Discord.':html?' · La transcripción se guardó en el panel, pero no se envió a Discord; el canal se conservará.':' · No se pudo guardar la transcripción; el canal se conservará.'}\n¿Cómo fue tu experiencia con el equipo de soporte? Valora la atención:`,`Ticket closed. Reason: **${reason||'No reason provided'}**${sent?' · Transcript saved in the dashboard and sent to Discord.':html?' · Transcript saved in the dashboard but not sent to Discord; the channel will be kept.':' · The transcript could not be saved; the channel will be kept.'}\nHow was your support experience? Rate the service:`),components:html?[ratingRow]:[],ephemeral:true,allowedMentions:{parse:[]}};
  if(i.deferred||i.replied) await i.followUp(response);
  else await i.reply(response);
  eventLog(updated,i.user.id,'closed',reason);
  if(html&&sent) try { await ch.delete(`Ticket ${t.public_id} closed; transcript saved`); }
  catch(error) { console.error('Could not delete closed ticket channel',error);await i.followUp({content:tr('El transcript se guardó, pero no se pudo borrar el canal. Verifica el permiso Administrar canales del bot.','The transcript was saved, but the channel could not be deleted. Check that the bot has Manage Channels permission.'),ephemeral:true}); }
}
async function handleCommand(i:ChatInputCommandInteraction) {
  const name=i.commandName;
  if(name==='ticket') {
    await i.reply({content:tr('Para contactar al equipo, usa el panel de tickets publicado en el servidor.','To contact support, use the ticket panel posted in the server.'),ephemeral:true});return;
  }
  if(!await staffOnly(i)) return;
  if(name==='ticket-panel') {
    const locale=(i.options.getString('language')||'en') as AppLanguage;
    const selectedOption=i.options.getChannel('channel');
    const selected=selectedOption?await client.channels.fetch(selectedOption.id).catch(()=>null):null;
    const configuredId=getLocalizedSetting<string>('panelChannelId',locale,locale==='es'?DEFAULT_ES_PANEL_CHANNEL_ID:DEFAULT_PANEL_CHANNEL_ID);
    const configured=configuredId?await client.channels.fetch(configuredId).catch(()=>null):null;
    const candidate=selected||configured||i.channel; if(!candidate?.isTextBased()||!('send' in candidate)) {await i.reply({content:tr('Elige un canal de texto.','Choose a text channel.'),ephemeral:true});return;}
    await publishPanel(client,locale,candidate.id);
    await i.reply({content:localized(locale,`Panel de tickets en español actualizado en <#${candidate.id}>.`,`English ticket panel updated in <#${candidate.id}>.`),ephemeral:true});return;
  }
  if(name==='ticket-setup') {
    const g=i.guild!;
    const missing:string[]=[];
    if(!g.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) missing.push('Manage Channels');
    if(!g.members.me?.permissions.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
    await i.reply({content:missing.length?tr(`Faltan permisos del bot: ${missing.join(', ')}.`,`The bot is missing permissions: ${missing.join(', ')}.`):tr(`Configuración básica lista. ${getCategories().length} categorías activas.`,`Basic setup is ready. ${getCategories().length} active categories.`),ephemeral:true});return;
  }
  if(name==='ticket-stats') {
    const row=db.prepare(`SELECT SUM(status='open') open,SUM(status='claimed') claimed,SUM(status='closed') closed,COUNT(*) total FROM tickets`).get() as any;
    await i.reply({content:tr(`Tickets · Abiertos: ${row.open||0} · Reclamados: ${row.claimed||0} · Cerrados: ${row.closed||0} · Total: ${row.total||0}`,`Tickets · Open: ${row.open||0} · Claimed: ${row.claimed||0} · Closed: ${row.closed||0} · Total: ${row.total||0}`),ephemeral:true});return;
  }
  if(name==='ticket-reopen') {
    const ticketId=i.options.getString('ticket',true).trim().toUpperCase();const closed=getTicket(ticketId);
    if(!closed) {await i.reply({content:tr('No se encontró ese ticket.','Ticket not found.'),ephemeral:true});return;}
    if(closed.status!=='closed') {await i.reply({content:tr('Ese ticket no está cerrado.','That ticket is not closed.'),ephemeral:true});return;}
    let channel=await client.channels.fetch(closed.channel_id).catch(()=>null);
    if(!channel?.isTextBased()||!('permissionOverwrites' in channel)) channel=await recreateTicketChannel(i.guild!,closed);
    updateTicket(closed,i.user.id,'reopened');
    if(channel?.isTextBased()&&'permissionOverwrites' in channel) {
      await (channel as TextChannel).permissionOverwrites.edit(closed.owner_id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>undefined);
      await (channel as TextChannel).setName(`ticket-${closed.public_id.toLowerCase()}`).catch(()=>undefined);
    }
    await i.reply({content:localized(closed.language,`Ticket ${closed.public_id} reabierto: <#${channel?.id}>`,`Ticket ${closed.public_id} reopened: <#${channel?.id}>`),ephemeral:true});eventLog(closed,i.user.id,'reopened');return;
  }
  if(name==='community-create') {
    const title=i.options.getString('title',true),kind=i.options.getString('type',true) as CommunityKind,body=i.options.getString('description',true),changes=i.options.getString('changes')||'',imageUrl=i.options.getString('image');
    if(imageUrl&&!/^https:\/\//i.test(imageUrl)){await i.reply({content:'The image must use an https URL.',ephemeral:true});return;}
    try {const post=await createCommunityPost(client,{kind,title,body,changes,imageUrl,createdBy:i.user.id});await i.reply({content:post.delivery_state==='queued'?`Post #${post.id} added to the queue.`:`Post #${post.id} published to the community board.`,ephemeral:true});}
    catch(error){console.error('Could not create community post',error);await i.reply({content:'Could not publish. Check that the bot can view and send messages in the board channel.',ephemeral:true});}return;
  }
  if(name==='community-list') {await i.reply({embeds:[communityListEmbed(listPendingCommunityPosts())],ephemeral:true});return;}
  const t=getTicketByChannel(i.channelId);
  if(!t) { await i.reply({content:tr('Este canal no está asociado a un ticket activo.','This channel is not linked to an active ticket.'),ephemeral:true});return; }
  if(name==='ticket-close') {
    const modal=new ModalBuilder().setCustomId('ticket:close-modal').setTitle(`${tr('Cerrar','Close')} ${t.public_id}`)
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(tr('Motivo de cierre','Closing reason')).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
    await i.showModal(modal);return;
  }
  if(name==='ticket-reopen') {
    if(t.status!=='closed') { await i.reply({content:tr('El ticket ya está abierto.','This ticket is already open.'),ephemeral:true});return; }
    updateTicket(t,i.user.id,'reopened'); const owner=await i.guild!.members.fetch(t.owner_id).catch(()=>null);
    if(owner) await (i.channel as TextChannel).permissionOverwrites.edit(owner.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
    await (i.channel as TextChannel).setName(`ticket-${t.public_id.toLowerCase()}`).catch(()=>undefined);
    await i.reply({content:tr(`${t.public_id} reabierto.`,`${t.public_id} reopened.`)}); eventLog(t,i.user.id,'reopened');return;
  }
  if(name==='ticket-claim') {
    const result=toggleClaim(t,i.user.id);
    if(result==='closed') { await i.reply({content:tr('Reabre el ticket antes de reclamarlo.','Reopen the ticket before claiming it.'),ephemeral:true});return; }
    if(result==='conflict') await i.reply({content:tr(`Este ticket ya está reclamado por <@${t.claimed_by}>.`,`This ticket is already claimed by <@${t.claimed_by}>.`),ephemeral:true});
    else if(result==='released') {await i.reply({content:tr('Has liberado el ticket.','You released this ticket.')});eventLog(t,i.user.id,'released');}
    else {await i.reply({content:tr(`<@${i.user.id}> se encargará de este ticket.`,`<@${i.user.id}> will handle this ticket.`)});eventLog(t,i.user.id,'claimed');}
    return;
  }
  if(name==='ticket-priority') {const p=i.options.getString('priority',true) as TicketPriority;updateTicket(t,i.user.id,'priority',p);await i.reply({content:localized(t.language,`Prioridad actualizada: **${priorityLabel(p,t.language)}**.`,`Priority updated: **${priorityLabel(p,t.language)}**.`)});eventLog(t,i.user.id,'priority',p);return;}
  if(name==='ticket-transcript') {await transcript(i,t);return;}
  if(name==='ticket-add'||name==='ticket-remove') {
    const user=i.options.getUser('user',true); const ch=i.channel as TextChannel;
    if(name==='ticket-add') await ch.permissionOverwrites.edit(user.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true,AttachFiles:true});
    else await ch.permissionOverwrites.delete(user.id).catch(()=>undefined);
    eventLog(t,i.user.id,name==='ticket-add'?'user_added':'user_removed',user.id);await i.reply({content:localized(t.language,`<@${user.id}> ${name==='ticket-add'?'añadido al':'retirado del'} ticket.`,`<@${user.id}> ${name==='ticket-add'?'added to':'removed from'} the ticket.`)});return;
  }
  if(name==='ticket-transfer') {
    const categoryId=i.options.getString('category',true);const cat=db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId) as any;
    if(!cat) {await i.reply({content:tr('Categoría no válida.','Invalid category.'),ephemeral:true});return;}
    const oldRoles=supportRoleIdsForCategory(t.category_id);
    const newRoles=supportRoleIdsForCategory(categoryId);
    const ch=i.channel as TextChannel;
    for(const role of oldRoles.filter(r=>!newRoles.includes(r))) await ch.permissionOverwrites.delete(role).catch(()=>undefined);
    for(const role of newRoles) await ch.permissionOverwrites.edit(role,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>undefined);
    updateTicket(t,i.user.id,'transferred',categoryId);
    await ch.setParent(cat.discord_category_id||null).catch(()=>undefined);
    await ch.setTopic(`Ticket ${t.public_id} · ${cat.name}`).catch(()=>undefined);
    eventLog(t,i.user.id,'transferred',cat.name);await i.reply({content:localized(t.language,`Ticket transferido a **${cat.name}**.`,`Ticket transferred to **${cat.name}**.`)});return;
  }
}

client.on(Events.InteractionCreate,async i=>{
  try {
    if(i.isButton()&&i.customId.startsWith('community:')) {await handleCommunityButton(i);return;}
    if(i.guildId&&i.guildId!==config.DISCORD_GUILD_ID) {
      if(i.isRepliable()) await i.reply({content:tr('Run a Police Tickets solo está habilitado en el servidor Run a Police.','Run a Police Tickets is only enabled in the Run a Police server.'),ephemeral:true,allowedMentions:{parse:[]}}).catch(()=>undefined);
      return;
    }
    if(i.isAutocomplete()&&i.commandName==='ticket-transfer') {
      const term=i.options.getFocused().toLowerCase();
      return await i.respond(getCategories().filter(c=>`${c.name} ${c.id}`.toLowerCase().includes(term)).slice(0,25).map(c=>({name:`${c.emoji} ${c.name}`,value:c.id})));
    }
    if(i.isChatInputCommand()) return await handleCommand(i);
    if(i.isModalSubmit()&&i.customId==='ticket:close-modal') {
      if(!i.guild||!i.channelId) {await i.reply({content:tr('Canal no disponible.','Channel unavailable.'),ephemeral:true});return;}
      const t=getTicketByChannel(i.channelId);if(!t) {await i.reply({content:tr('Ticket no encontrado.','Ticket not found.'),ephemeral:true});return;}
      if(i.user.id!==t.owner_id&&!await isStaff(i.guild,i.user.id)) {await i.reply({content:tr('No tienes permiso.','You do not have permission.'),ephemeral:true});return;}
      await i.deferReply({ephemeral:true});
      return await closeTicket(i,t,i.fields.getTextInputValue('reason').trim());
    }
    if(i.isModalSubmit()&&i.customId.startsWith('ticket:rating-modal:')) {
      if(!i.channelId) {await i.reply({content:tr('Canal no disponible.','Channel unavailable.'),ephemeral:true});return;}
      const score=Number(i.customId.split(':').at(-1));const t=getTicketByChannel(i.channelId);
      if(!t||t.status!=='closed'||t.owner_id!==i.user.id||score<1||score>5) {await i.reply({content:localized(t?.language||'en','No se pudo guardar la valoración.','Could not save the rating.'),ephemeral:true});return;}
      const comment=i.fields.getTextInputValue('comment').trim();
      db.prepare(`INSERT INTO ratings(ticket_id,user_id,staff_id,score,comment,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(ticket_id) DO UPDATE SET user_id=excluded.user_id,staff_id=excluded.staff_id,score=excluded.score,comment=excluded.comment,created_at=excluded.created_at`)
        .run(t.id,i.user.id,t.claimed_by,score,comment,new Date().toISOString());
      addTicketEvent(t,i.user.id,'rating',String(score));
      await i.reply({content:localized(t.language,`Gracias por valorar la atención con ${score}/5.`,`Thanks for rating your support experience ${score}/5.`),ephemeral:true});return;
    }
    if(i.isStringSelectMenu()&&(i.customId==='ticket:category'||i.customId.startsWith('ticket:category:'))) {
      if(!i.guild) return;
      const locale=(i.customId.split(':')[2]||'en') as AppLanguage;
      await i.deferReply({ephemeral:true});
      try {
        const ticket=await createTicket(i.guild,i.user.id,i.values[0],locale);
        await i.editReply(localized(locale,`Ticket **${ticket.public_id}** creado: <#${ticket.channel_id}>`,`Ticket **${ticket.public_id}** created: <#${ticket.channel_id}>`));
        eventLog(ticket,i.user.id,'opened',ticket.category_id);
      } finally {
        await i.message.edit({components:panelComponents(locale),allowedMentions:{parse:[]}}).catch(error=>console.error('Could not reset ticket category menu',error));
      }
      return;
    }
    if(i.isButton()&&i.customId.startsWith('ticket:')) {
      if(!i.guild) return;
      const t=getTicketByChannel(i.channelId);if(!t) {await i.reply({content:tr('Ticket no encontrado.','Ticket not found.'),ephemeral:true});return;}
      if(i.customId.startsWith('ticket:rate:')) {
        const score=Number(i.customId.split(':').at(-1));
        if(i.user.id!==t.owner_id||t.status!=='closed'||score<1||score>5) {await i.reply({content:localized(t.language,'Solo quien abrió el ticket puede valorarlo al cerrarse.','Only the ticket creator can rate it after closure.'),ephemeral:true});return;}
        const modal=new ModalBuilder().setCustomId(`ticket:rating-modal:${score}`).setTitle(localized(t.language,`Valorar atención · ${score}/5`,`Rate support · ${score}/5`)).addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('comment').setLabel(localized(t.language,'Comentario (opcional)','Comment (optional)')).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
        await i.showModal(modal);return;
      }
      if(i.customId==='ticket:close') {
        if(i.user.id!==t.owner_id&&!await isStaff(i.guild,i.user.id)) {await i.reply({content:localized(t.language,'No tienes permiso para cerrar este ticket.','You do not have permission to close this ticket.'),ephemeral:true});return;}
        const modal=new ModalBuilder().setCustomId('ticket:close-modal').setTitle(`${localized(t.language,'Cerrar','Close')} ${t.public_id}`).addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(localized(t.language,'Motivo de cierre','Closing reason')).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)));
        await i.showModal(modal);return;
      }
      if(i.customId==='ticket:claim') {
        if(!await isStaff(i.guild,i.user.id)) {await i.reply({content:localized(t.language,'Solo el equipo de soporte puede reclamar tickets.','Only support staff can claim tickets.'),ephemeral:true});return;}
        const type=toggleClaim(t,i.user.id);
        if(type==='closed') {await i.reply({content:localized(t.language,'Este ticket está cerrado.','This ticket is closed.'),ephemeral:true});return;}
        if(type==='conflict') {await i.reply({content:localized(t.language,`Este ticket ya está reclamado por <@${t.claimed_by}>.`,`This ticket is already claimed by <@${t.claimed_by}>.`),ephemeral:true});return;}
        eventLog(t,i.user.id,type);await i.reply({content:type==='claimed'?localized(t.language,`<@${i.user.id}> atenderá este ticket.`,`<@${i.user.id}> will handle this ticket.`):localized(t.language,'Ticket liberado.','Ticket released.')});return;
      }
      if(i.customId==='ticket:priority') {
        if(!await isStaff(i.guild,i.user.id)) {await i.reply({content:localized(t.language,'Solo el equipo de soporte puede cambiar la prioridad.','Only support staff can change priority.'),ephemeral:true});return;}
        const menu=new StringSelectMenuBuilder().setCustomId('ticket:priority-select').setPlaceholder(localized(t.language,'Selecciona prioridad','Select priority')).addOptions(
          ...Object.keys(priorityNames).map(value=>({label:priorityLabel(value as TicketPriority,t.language),value})));
        await i.reply({content:localized(t.language,'Prioridad del ticket:','Ticket priority:'),components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],ephemeral:true});return;
      }
      if(i.customId==='ticket:reopen') {
        if(!await isStaff(i.guild,i.user.id)) {await i.reply({content:localized(t.language,'Solo el equipo de soporte puede reabrir tickets.','Only support staff can reopen tickets.'),ephemeral:true});return;}
        updateTicket(t,i.user.id,'reopened');const owner=await i.guild.members.fetch(t.owner_id).catch(()=>null);
        if(owner) await (i.channel as TextChannel).permissionOverwrites.edit(owner.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
        await (i.channel as TextChannel).setName(`ticket-${t.public_id.toLowerCase()}`).catch(()=>undefined);
        eventLog(t,i.user.id,'reopened');await i.reply({content:localized(t.language,'Ticket reabierto.','Ticket reopened.')});return;
      }
    }
    if(i.isStringSelectMenu()&&i.customId==='ticket:priority-select') {
      const t=getTicketByChannel(i.channelId);if(!t) return i.reply({content:tr('Ticket no encontrado.','Ticket not found.'),ephemeral:true});
      if(!i.guild||!await isStaff(i.guild,i.user.id)) {await i.reply({content:localized(t.language,'Solo el equipo de soporte puede cambiar la prioridad.','Only support staff can change priority.'),ephemeral:true});return;}
      const priority=i.values[0] as TicketPriority;updateTicket(t,i.user.id,'priority',priority);eventLog(t,i.user.id,'priority',priority);
      await i.update({content:localized(t.language,`Prioridad: **${priorityLabel(priority,t.language)}**.`,`Priority: **${priorityLabel(priority,t.language)}**.`),components:[]});
    }
  } catch(error) {
    recordSystemError(client,error,`Discord interaction ${i.type}`);
    if('isRepliable' in i&&i.isRepliable()) {
      const ticket='channelId' in i&&typeof i.channelId==='string'?getTicketByChannel(i.channelId):undefined;
      const customId=(i as any).customId;
      const locale=(typeof customId==='string'&&customId.startsWith('ticket:category:')?customId.split(':')[2]:ticket?.language||'en') as AppLanguage;
      const payload={content:localized(locale,'Ocurrió un error al procesar la acción. Inténtalo nuevamente.','Something went wrong while processing this action. Please try again.'),ephemeral:true};
      if(i.deferred) await i.followUp(payload).catch(()=>undefined); else if(!i.replied) await i.reply(payload).catch(()=>undefined);
    }
  }
});

client.on(Events.MessageReactionAdd,async(reaction,user)=>{
  if(user.bot)return;
  try {if(reaction.partial)await reaction.fetch();const message=reaction.message.partial?await reaction.message.fetch():reaction.message;await inspectForumReaction(client,message);}
  catch(error){recordSystemError(client,error,'Forum reaction tracking');}
});
client.once(Events.ClientReady,()=>{void recoverCommunityQueue(client).then(()=>scanActiveForumThreads(client)).catch(error=>recordSystemError(client,error,'Community queue startup'));});
client.once(Events.ClientReady,c=>console.log(`Discord ready as ${c.user.tag}`));
client.on(Events.Error,e=>recordSystemError(client,e,'Discord client error'));
client.on(Events.MessageCreate,message=>{
  if(!message.guild||message.author.bot||!message.member) return;
  const ticket=getTicketByChannel(message.channelId);if(!ticket||ticket.status==='closed')return;
  const member=message.member;
  if(!member.permissions.has(PermissionFlagsBits.Administrator)&&!isSupportRole([...member.roles.cache.keys()]))return;
  const exists=db.prepare("SELECT 1 FROM ticket_events WHERE ticket_id=? AND type='staff_response' LIMIT 1").get(ticket.id);
  if(!exists) addTicketEvent(ticket,message.author.id,'staff_response');
  const participated=db.prepare("SELECT 1 FROM ticket_events WHERE ticket_id=? AND type='staff_participated' AND actor_id=? LIMIT 1").get(ticket.id,message.author.id);
  if(!participated) addTicketEvent(ticket,message.author.id,'staff_participated');
});
