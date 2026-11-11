import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Guild,
  OverwriteType, PermissionFlagsBits, StringSelectMenuBuilder, TextChannel } from 'discord.js';
import crypto from 'node:crypto';
import { db, getLocalizedSetting, getSetting } from './db';
import { config } from './config';
import { AppLanguage, localized, tr } from './i18n';
import { DEFAULT_TICKET_RESPONDER_ROLE_ID } from './server-defaults';

export type TicketStatus = 'open' | 'claimed' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type Ticket = {
  id:number; public_id:string; guild_id:string; channel_id:string; owner_id:string; category_id:string;
  language:AppLanguage;
  status:TicketStatus; priority:TicketPriority; claimed_by:string|null; created_at:string;
  closed_at:string|null; closed_by:string|null; close_reason:string|null;
};
export async function refreshTicketPriorityEmbed(channel:TextChannel,ticket:Ticket,priority:TicketPriority):Promise<void> {
  const messages=await channel.messages.fetch({limit:100});
  const message=messages.find(m=>m.author.id===channel.client.user?.id&&m.embeds.some(embed=>embed.fields.some(field=>field.name.toLowerCase()==='ticket'&&field.value===ticket.public_id)));
  if(!message?.embeds[0])throw new Error(`Ticket information embed not found for ${ticket.public_id}.`);
  const source=message.embeds[0],embed=EmbedBuilder.from(source),fields=source.fields.map(field=>({name:field.name,value:field.value,inline:field.inline}));
  const priorityIndex=fields.findIndex(field=>['priority','prioridad'].includes(field.name.toLowerCase()));
  const priorityField={name:localized(ticket.language,'Prioridad','Priority'),value:priorityLabel(priority,ticket.language),inline:true};
  if(priorityIndex>=0)fields[priorityIndex]=priorityField;else fields.push(priorityField);
  await message.edit({embeds:[embed.setFields(fields)]});
}
const now = () => new Date().toISOString();
export const priorityNames: Record<TicketPriority,string> = { low:'Low', normal:'Normal', high:'High', urgent:'Urgent' };
const defaultPriorityLabels={en:{low:'Low',normal:'Normal',high:'High',urgent:'Urgent'},es:{low:'Baja',normal:'Normal',high:'Alta',urgent:'Urgente'}};
export function priorityLabel(priority:TicketPriority,locale:AppLanguage):string {
  const labels=getSetting<typeof defaultPriorityLabels>('priorityLabels',defaultPriorityLabels);
  return labels[locale]?.[priority]||defaultPriorityLabels[locale][priority];
}
export const categoryText=(id:string,name:string,description:string,locale:AppLanguage)=>{
  if(locale==='en')return {name,description};
  const es:Record<string,{name:string;description:string}>={
    general:{name:'Soporte general',description:'Consultas y ayuda general.'},
    report:{name:'Reportar a un usuario',description:'Reportes confidenciales sobre usuarios.'},
    appeal:{name:'Apelaciones',description:'Solicita la revisión de una sanción.'},
    technical:{name:'Problemas técnicos',description:'Errores, fallos o problemas técnicos.'},
    admin:{name:'Consultas administrativas',description:'Consultas para el equipo administrativo.'}
  };
  return es[id]||{name,description};
};
const event = db.prepare('INSERT INTO ticket_events(ticket_id,actor_id,type,detail,created_at) VALUES(?,?,?,?,?)');
export function getTicketByChannel(channelId:string): Ticket|undefined {
  return db.prepare('SELECT * FROM tickets WHERE channel_id=?').get(channelId) as Ticket|undefined;
}
export function getTicket(publicId:string): Ticket|undefined {
  return db.prepare('SELECT * FROM tickets WHERE public_id=?').get(publicId.toUpperCase()) as Ticket|undefined;
}
export function isSupportRole(roleIds:string[]): boolean {
  const allowed = new Set<string>([...config.bootstrapAdminRoleIds,DEFAULT_TICKET_RESPONDER_ROLE_ID]);
  for (const r of getSetting<string[]>('supportRoleIds', [])) allowed.add(r);
  for (const r of getSetting<string[]>('adminRoleIds', [])) allowed.add(r);
  for (const r of getSetting<string[]>('supervisorRoleIds', [])) allowed.add(r);
  return roleIds.some(r => allowed.has(r));
}
export async function isStaff(guild:Guild, userId:string):Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  return !!member && (member.permissions.has(PermissionFlagsBits.Administrator) || isSupportRole([...member.roles.cache.keys()]));
}
function safeChannelName(s:string) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,22) || 'user';
}

// Serialize ticket creation per user to prevent concurrent button clicks opening duplicates.
const pendingUsers = new Set<string>();
export async function createTicket(guild:Guild, userId:string, categoryId:string, locale:AppLanguage='en'):Promise<Ticket> {
  if (pendingUsers.has(userId)) throw new Error(localized(locale,'Ya se está creando tu ticket. Espera un momento.','Your ticket is already being created. Please wait.'));
  pendingUsers.add(userId);
  try {
    const active = db.prepare("SELECT public_id FROM tickets WHERE owner_id=? AND status!='closed'").get(userId) as {public_id:string}|undefined;
    const limit = getSetting<number>('ticketLimitPerUser', 1);
    const count = (db.prepare("SELECT COUNT(*) n FROM tickets WHERE owner_id=? AND status!='closed'").get(userId) as {n:number}).n;
    if (count >= limit) throw new Error(localized(locale,`Ya alcanzaste el límite de ${limit} ticket(s) abiertos${active ? ` (${active.public_id})` : ''}.`,`You have reached the limit of ${limit} open ticket(s)${active ? ` (${active.public_id})` : ''}.`));
    const category = db.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').get(categoryId) as {id:string;name:string;emoji:string;discord_category_id:string|null;support_role_ids:string}|undefined;
    if (!category) throw new Error(localized(locale,'La categoría no está disponible.','This category is unavailable.'));
    const display=categoryText(category.id,category.name,'',locale);
    const configCategory = category.discord_category_id || getLocalizedSetting<string>('discordCategoryId',locale,'');
    const roleIds = supportRoleIdsForCategory(categoryId);
    const overwrites:any[] = [
      { id:guild.id, type:OverwriteType.Role, deny:[PermissionFlagsBits.ViewChannel] },
      { id:userId, type:OverwriteType.Member, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles] },
      { id:guild.client.user!.id, type:OverwriteType.Member, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageMessages] },
      ...roleIds.map(id => ({id,type:OverwriteType.Role,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}))
    ];
    const channel = await guild.channels.create({
      name:`ticket-${safeChannelName((await guild.client.users.fetch(userId)).username)}`,
      type:ChannelType.GuildText, parent:configCategory || undefined, permissionOverwrites:overwrites,
      topic:localized(locale,`Ticket ${categoryId} · Usuario ${userId} · Run a Police Tickets`,`Ticket ${categoryId} · User ${userId} · Run a Police Tickets`)
    }) as TextChannel;
    let insertedId:number|undefined;
    try {
      const tempId = `TMP-${crypto.randomUUID()}`;
      const result = db.prepare('INSERT INTO tickets(public_id,guild_id,channel_id,owner_id,category_id,language,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(tempId,guild.id,channel.id,userId,categoryId,locale,now());
      insertedId=Number(result.lastInsertRowid);
      const publicId = `RAP-${String(result.lastInsertRowid).padStart(6,'0')}`;
      db.prepare('UPDATE tickets SET public_id=? WHERE id=?').run(publicId,result.lastInsertRowid);
      const ticket = getTicket(publicId)!;
      event.run(ticket.id,userId,'opened',categoryId,ticket.created_at);
      const embed = new EmbedBuilder().setColor(0x3b82f6).setTitle(`${category.emoji} ${display.name}`)
      .setDescription(getLocalizedSetting('welcomeMessage',locale,localized(locale,'Hola <@'+userId+'>. El equipo de soporte te atenderá aquí. Describe tu consulta con el mayor detalle posible.','Hello <@'+userId+'>. The support team will assist you here. Please describe your issue in as much detail as possible.')))
        .addFields({name:'Ticket',value:publicId,inline:true},{name:localized(locale,'Prioridad','Priority'),value:priorityLabel('normal',locale),inline:true})
        .setFooter({text:'Run a Police Tickets'}).setTimestamp();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('ticket:claim').setLabel(localized(locale,'Reclamar','Claim')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ticket:close').setLabel(localized(locale,'Cerrar','Close')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ticket:priority').setLabel(localized(locale,'Prioridad','Priority')).setStyle(ButtonStyle.Secondary)
      );
      await channel.send({embeds:[embed],components:[row]});
      return ticket;
    } catch (error) {
      if(insertedId) {
        db.prepare('DELETE FROM ticket_events WHERE ticket_id=?').run(insertedId);
        db.prepare('DELETE FROM tickets WHERE id=?').run(insertedId);
      }
      await channel.delete('Could not save the ticket').catch(()=>undefined);
      throw error;
    }
  } finally { pendingUsers.delete(userId); }
}

export function updateTicket(ticket:Ticket, actorId:string, type:string, detail=''):void {
  const time=now();
  const tx=db.transaction(()=>{
    if(type==='claimed') db.prepare("UPDATE tickets SET status='claimed',claimed_by=? WHERE id=? AND status!='closed'").run(actorId,ticket.id);
    else if(type==='released') db.prepare("UPDATE tickets SET status='open',claimed_by=NULL WHERE id=? AND status!='closed'").run(ticket.id);
    else if(type==='priority') db.prepare('UPDATE tickets SET priority=? WHERE id=? AND status!=\'closed\'').run(detail,ticket.id);
    else if(type==='closed') db.prepare("UPDATE tickets SET status='closed',closed_at=?,closed_by=?,close_reason=? WHERE id=?").run(time,actorId,detail,ticket.id);
    else if(type==='reopened') { db.prepare("UPDATE tickets SET status='open',claimed_by=NULL,closed_at=NULL,closed_by=NULL,close_reason=NULL WHERE id=?").run(ticket.id); db.prepare('DELETE FROM transcripts WHERE ticket_id=?').run(ticket.id); db.prepare('DELETE FROM ratings WHERE ticket_id=?').run(ticket.id); }
    else if(type==='transferred') db.prepare('UPDATE tickets SET category_id=? WHERE id=?').run(detail,ticket.id);
    event.run(ticket.id,actorId,type,detail,time);
  }); tx();
}
export function toggleClaim(ticket:Ticket,actorId:string):'claimed'|'released'|'conflict'|'closed' {
  return db.transaction(()=>{
    const current=db.prepare('SELECT status,claimed_by FROM tickets WHERE id=?').get(ticket.id) as {status:TicketStatus;claimed_by:string|null}|undefined;
    if(!current||current.status==='closed')return 'closed';
    if(current.claimed_by&&current.claimed_by!==actorId)return 'conflict';
    const type=current.claimed_by===actorId?'released':'claimed';
    if(type==='claimed')db.prepare("UPDATE tickets SET status='claimed',claimed_by=? WHERE id=? AND status!='closed' AND claimed_by IS NULL").run(actorId,ticket.id);
    else db.prepare("UPDATE tickets SET status='open',claimed_by=NULL WHERE id=? AND status!='closed' AND claimed_by=?").run(ticket.id,actorId);
    event.run(ticket.id,actorId,type,'',now());
    return type;
  })();
}
export function addTicketEvent(ticket:Ticket,actorId:string,type:string,detail=''):void { event.run(ticket.id,actorId,type,detail,now()); }
export function getCategories() {
  return db.prepare('SELECT * FROM categories WHERE enabled=1 ORDER BY sort_order,id').all() as Array<{id:string;name:string;description:string;emoji:string;support_role_ids:string}>;
}
export function supportRoleIdsForCategory(categoryId:string):string[] {
  const row=db.prepare('SELECT support_role_ids FROM categories WHERE id=?').get(categoryId) as {support_role_ids:string}|undefined;
  const specific=row?JSON.parse(row.support_role_ids) as string[]:[];
  return [...new Set([...specific,DEFAULT_TICKET_RESPONDER_ROLE_ID,...getSetting<string[]>('supportRoleIds',[]),...getSetting<string[]>('supervisorRoleIds',[]),...getSetting<string[]>('adminRoleIds',[]),...config.bootstrapAdminRoleIds])];
}
export async function recreateTicketChannel(guild:Guild,ticket:Ticket):Promise<TextChannel> {
  const category=db.prepare('SELECT * FROM categories WHERE id=?').get(ticket.category_id) as {name:string;emoji:string;discord_category_id:string|null}|undefined;
  if(!category) throw new Error('The ticket category could not be found.');
  const display=categoryText(ticket.category_id,category.name,'',ticket.language);
  const user=await guild.client.users.fetch(ticket.owner_id);
  const roles=supportRoleIdsForCategory(ticket.category_id);
  const channel=await guild.channels.create({name:`ticket-${safeChannelName(user.username)}`,type:ChannelType.GuildText,parent:category.discord_category_id||getLocalizedSetting<string>('discordCategoryId',ticket.language,'')||undefined,
    permissionOverwrites:[
      {id:guild.id,type:OverwriteType.Role,deny:[PermissionFlagsBits.ViewChannel]},
      {id:ticket.owner_id,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]},
      {id:guild.client.user!.id,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageMessages]},
      ...roles.map(id=>({id,type:OverwriteType.Role,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}))
    ],topic:`Ticket ${ticket.public_id} · ${category.name}`});
  db.prepare('UPDATE tickets SET channel_id=? WHERE id=?').run(channel.id,ticket.id);
  const row=new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('ticket:claim').setLabel(localized(ticket.language,'Reclamar','Claim')).setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('ticket:close').setLabel(localized(ticket.language,'Cerrar','Close')).setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('ticket:priority').setLabel(localized(ticket.language,'Prioridad','Priority')).setStyle(ButtonStyle.Secondary));
  const embed=new EmbedBuilder().setColor(0x3b82f6).setTitle(`${category.emoji} ${display.name}`).setDescription(getLocalizedSetting('welcomeMessage',ticket.language,localized(ticket.language,'Describe tu consulta al equipo de soporte.','Describe your issue for the support team.'))).addFields({name:'Ticket',value:ticket.public_id,inline:true},{name:localized(ticket.language,'Prioridad','Priority'),value:priorityLabel(ticket.priority,ticket.language),inline:true}).setFooter({text:'Run a Police Tickets'}).setTimestamp();
  await channel.send({embeds:[embed],components:[row]});
  return channel;
}
export function panelComponents(locale:AppLanguage='en') {
  const cats=getCategories().slice(0,25);
  const menu = new StringSelectMenuBuilder().setCustomId(`ticket:category:${locale}`).setPlaceholder(localized(locale,'Elige el motivo de contacto','Choose a contact reason'))
    .addOptions(cats.map(c=>{const display=categoryText(c.id,c.name,c.description,locale);return {label:display.name.slice(0,100),description:(display.description||(locale==='en'?'Open a ticket':'Abrir un ticket')).slice(0,100),value:c.id,emoji:c.emoji}}));
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}
export function ticketControls(locale:AppLanguage='en') {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(localized(locale,'Reclamar','Claim')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:close').setLabel(localized(locale,'Cerrar','Close')).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:priority').setLabel(localized(locale,'Prioridad','Priority')).setStyle(ButtonStyle.Secondary)
  )];
}
