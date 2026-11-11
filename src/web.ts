import express, { Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { gunzipSync } from 'node:zlib';
import { ChannelType, Client, EmbedBuilder, PermissionFlagsBits, TextChannel } from 'discord.js';
import { config } from './config';
import { db, getLocalizedSetting, getSetting, setSetting } from './db';
import { clearSession, finishOAuth, requireAuth, requireRole, setSessionCookie, startOAuth } from './auth';
import { addTicketEvent, categoryText, getTicket, priorityLabel, recreateTicketChannel, refreshTicketPriorityEmbed, supportRoleIdsForCategory, Ticket, TicketPriority, toggleClaim, updateTicket } from './tickets';
import { generateTranscript, sendTranscriptToDiscord } from './transcripts';
import { DEFAULT_ES_LOG_CHANNEL_ID, DEFAULT_ES_PANEL_CHANNEL_ID, DEFAULT_ES_TRANSCRIPT_CHANNEL_ID, DEFAULT_LOG_CHANNEL_ID, DEFAULT_PANEL_CHANNEL_ID, DEFAULT_PROJECT_OWNER_ID, DEFAULT_TRANSCRIPT_CHANNEL_ID } from './server-defaults';
import { refreshPanel } from './discord';
import { recordSystemError, sendAudit } from './audit';
import { localized, tr } from './i18n';
import { z } from 'zod';
import { getReactionRolePanels, saveReactionRolePanels } from './reaction-roles';
import { approveCommunityPost, CommunityKind, createCommunityPost, deleteCommunityPost, updateCommunityPostPriority } from './community';

const categoriesTable=`SELECT id,name,description,emoji,discord_category_id,support_role_ids,enabled,sort_order FROM categories`;
const mutationRoles=['support','supervisor','admin'] as const;
const adminRoles=['admin'] as const;
const parseIntParam=(v:unknown)=>{const n=Number(v);return Number.isInteger(n)&&n>0?n:null;};
const urlsafe=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function createWebApp(client:Client) {
  const app=express();
  app.disable('x-powered-by');
  app.set('trust proxy',1);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'https://cdn.discordapp.com','data:'],connectSrc:["'self'"],objectSrc:["'none'"],baseUri:["'self'"],frameAncestors:["'none'"]}}}));
  app.use((req:any,_res,next)=>{const raw=req.headers.cookie||'';req.cookies=Object.fromEntries(raw.split(';').map((s:string)=>s.trim().split(/=(.*)/s).slice(0,2)).filter((p:string[])=>p.length===2).map((p:string[])=>[p[0],decodeURIComponent(p[1])]));next();});
  app.use(express.json({limit:'32mb'}));
  const loginLimit=rateLimit({windowMs:15*60_000,limit:20,standardHeaders:true,legacyHeaders:false});
  const apiLimit=rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false});
  app.use('/auth',loginLimit);app.use('/api',apiLimit);
  app.get('/health',(_req,res)=>res.json({status:'ok',service:'run-a-police-tickets'}));
  app.get('/auth/discord',(req,res)=>{
    const {url}=startOAuth();res.cookie('rap_oauth_state',url.split('state=')[1],{httpOnly:true,secure:config.secureCookies,sameSite:'lax',path:'/auth',maxAge:10*60_000});
    res.redirect(url);
  });
  app.get('/auth/callback',async(req,res)=>{
    try {
      const code=String(req.query.code||''),state=String(req.query.state||''),cookie=(req as any).cookies?.rap_oauth_state;
      console.info(`[OAuth] callback received: code=${!!code} state=${!!state} stateCookie=${!!cookie}`);
      if(!code||!state||!cookie||!crypto.timingSafeEqual(Buffer.from(state),Buffer.from(cookie))) throw new Error('Invalid OAuth state. Please sign in again.');
      const result=await finishOAuth(client,code,state);setSessionCookie(res,result.cookie);res.clearCookie('rap_oauth_state',{path:'/auth'});
      console.info(`[OAuth] session created: user=${result.user.id} role=${result.user.role}`);
      res.redirect('/');
    } catch(e) {console.error('[OAuth] callback failed:',e instanceof Error?e.message:'Unknown error');res.status(403).send(`<!doctype html><meta charset="utf-8"><title>Access error</title><p>${urlsafe(e instanceof Error?e.message:'Could not sign in.')}</p><a href="/auth/discord">Try again</a>`);}
  });
  app.post('/auth/logout',async(req,res)=>{await requireAuth(client,req,res,()=>{});if(!req.authUser)return;clearSession(req,res);res.json({ok:true});});
  const auth=(req:Request,res:Response,next:any)=>requireAuth(client,req,res,next);
  const guild=()=>client.guilds.cache.get(config.DISCORD_GUILD_ID)!;
  const hasGuildChannel=async(id:string,types:ChannelType[])=>{
    const channel=await client.channels.fetch(id).catch(()=>null);
    return !!channel&&'guildId' in channel&&channel.guildId===config.DISCORD_GUILD_ID&&types.includes(channel.type as ChannelType);
  };
  const hasGuildRoles=async(ids:string[])=>{
    if(!ids.length)return true;
    const g=await client.guilds.fetch(config.DISCORD_GUILD_ID);await g.roles.fetch().catch(()=>undefined);
    return ids.every(id=>g.roles.cache.has(id));
  };
  app.get('/api/me',auth,(req,res)=>res.json({user:{id:req.authUser!.id,username:req.authUser!.username,avatar:req.authUser!.avatar,role:req.authUser!.role,csrfToken:req.authUser!.csrfToken},guild:{id:config.DISCORD_GUILD_ID,name:guild()?.name||'Run a Police'}}));
  app.get('/api/dashboard',auth,requireRole('readonly'),(_req,res)=>{
    const counts=db.prepare(`SELECT COUNT(*) total,SUM(status='open') open,SUM(status='claimed') claimed,SUM(status='closed') closed FROM tickets`).get() as any;
    const languageCounts=db.prepare("SELECT language,COUNT(*) total,SUM(status='open') open,SUM(status='claimed') claimed,SUM(status='closed') closed FROM tickets GROUP BY language").all();
    const resolution=db.prepare("SELECT AVG((julianday(closed_at)-julianday(created_at))*86400) sec FROM tickets WHERE closed_at IS NOT NULL").get() as {sec:number|null};
    const response=db.prepare("SELECT AVG((julianday(e.created_at)-julianday(t.created_at))*86400) sec FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id WHERE e.type='staff_response'").get() as {sec:number|null};
    const ratings=db.prepare('SELECT AVG(score) avg,COUNT(*) count FROM ratings').get() as {avg:number|null;count:number};
    const categoryCounts=db.prepare(`SELECT c.name,c.emoji,COUNT(t.id) count FROM categories c LEFT JOIN tickets t ON t.category_id=c.id GROUP BY c.id ORDER BY count DESC`).all();
    const recent=db.prepare(`SELECT t.public_id,t.status,t.priority,t.owner_id,t.created_at,c.name category FROM tickets t LEFT JOIN categories c ON c.id=t.category_id ORDER BY t.id DESC LIMIT 8`).all();
    res.json({counts:{...counts,total:counts.total||0,open:counts.open||0,claimed:counts.claimed||0,closed:counts.closed||0},languageCounts,avgResponseSeconds:response.sec?Math.round(response.sec):null,avgResolutionSeconds:resolution.sec?Math.round(resolution.sec):null,satisfaction:ratings.avg?Number(ratings.avg.toFixed(2)):null,ratingCount:ratings.count,categoryCounts,recent});
  });
  app.get('/api/tickets',auth,requireRole('readonly'),(req,res)=>{
    const page=Math.min(parseIntParam(req.query.page)||1,10000),limit=25,offset=(page-1)*limit;
    const where:string[]=[],args:unknown[]=[];
    if(typeof req.query.status==='string'&&['open','claimed','closed'].includes(req.query.status)){where.push('t.status=?');args.push(req.query.status);}
    if(typeof req.query.language==='string'&&['en','es'].includes(req.query.language)){where.push('t.language=?');args.push(req.query.language);}
    if(typeof req.query.category==='string'&&req.query.category.length<80){where.push('t.category_id=?');args.push(req.query.category);}
    if(typeof req.query.user==='string'&&/^\d{17,20}$/.test(req.query.user)){where.push('t.owner_id=?');args.push(req.query.user);}
    if(typeof req.query.staff==='string'&&/^\d{17,20}$/.test(req.query.staff)){where.push('(t.claimed_by=? OR t.closed_by=?)');args.push(req.query.staff,req.query.staff);}
    if(typeof req.query.from==='string'&&!Number.isNaN(Date.parse(req.query.from))){where.push('t.created_at>=?');args.push(new Date(req.query.from).toISOString());}
    if(typeof req.query.to==='string'&&!Number.isNaN(Date.parse(req.query.to))){where.push('t.created_at<=?');args.push(new Date(req.query.to).toISOString());}
    if(typeof req.query.q==='string'&&req.query.q.length<=40){where.push('(t.public_id LIKE ? OR t.owner_id LIKE ?)');args.push(`%${req.query.q}%`,`%${req.query.q}%`);}
    const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const rawRows=db.prepare(`SELECT t.public_id,t.owner_id,t.category_id,t.language,t.status,t.priority,t.claimed_by,t.created_at,t.closed_at,c.name category,
      EXISTS(SELECT 1 FROM transcripts x WHERE x.ticket_id=t.id) has_transcript FROM tickets t LEFT JOIN categories c ON c.id=t.category_id ${clause} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const rows=(rawRows as Array<any>).map(row=>({...row,priority_label:priorityLabel(row.priority,row.language)}));
    const total=(db.prepare(`SELECT COUNT(*) n FROM tickets t ${clause}`).get(...args) as {n:number}).n;
    res.json({rows,page,limit,total});
  });
  app.get('/api/tickets/:id',auth,requireRole('readonly'),(req,res)=>{
    const ticket=getTicket(String(req.params.id));if(!ticket)return res.status(404).json({error:'Ticket not found.'});
    const events=db.prepare('SELECT actor_id,type,detail,created_at FROM ticket_events WHERE ticket_id=? ORDER BY id DESC LIMIT 200').all(ticket.id);
    const notes=db.prepare('SELECT author_id,body,created_at FROM ticket_notes WHERE ticket_id=? ORDER BY id DESC LIMIT 100').all(ticket.id);
    const category=db.prepare('SELECT name FROM categories WHERE id=?').get(ticket.category_id);
    res.json({ticket,category,events,notes,priority_label:priorityLabel(ticket.priority,ticket.language),hasTranscript:!!db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(ticket.id)});
  });
  app.get('/api/tickets/:id/transcript',auth,requireRole('readonly'),(req,res)=>{
    const ticket=getTicket(String(req.params.id));if(!ticket)return res.status(404).json({error:'Ticket not found.'});
    const row=db.prepare('SELECT html FROM transcripts WHERE ticket_id=?').get(ticket.id) as {html:Buffer|string}|undefined;
    if(!row)return res.status(404).json({error:'No transcript is available yet.'});
    const html=Buffer.isBuffer(row.html)?gunzipSync(row.html):row.html;
    res.type('html').set('Content-Disposition',`attachment; filename="${ticket.public_id}.html"`).send(html);
  });
  app.post('/api/tickets/:id/transcript',auth,requireRole(...mutationRoles),async(req,res)=>{
    const ticket=getTicket(String(req.params.id));if(!ticket)return res.status(404).json({error:'Ticket not found.'});
    const ch=await client.channels.fetch(ticket.channel_id).catch(()=>null);if(!ch?.isTextBased()||!('messages' in ch))return res.status(409).json({error:'The channel is no longer available.'});
    try {const html=await generateTranscript(ticket,ch as TextChannel,req.authUser!.id);await sendTranscriptToDiscord(client,ticket,html);res.json({ok:true,sentToDiscord:true});}catch(e){console.error(e);res.status(502).json({error:tr('El transcript quedó guardado en el panel, pero no se pudo enviar al canal configurado.','The transcript was saved in the dashboard but could not be sent to the configured channel.')});}
  });
  app.post('/api/tickets/:id/notes',auth,requireRole(...mutationRoles),(req,res)=>{
    const ticket=getTicket(String(req.params.id)),parsed=z.object({body:z.string().trim().min(1).max(2000)}).safeParse(req.body);
    if(!ticket)return res.status(404).json({error:'Ticket not found.'});if(!parsed.success)return res.status(400).json({error:'Invalid note.'});
    const at=new Date().toISOString();db.prepare('INSERT INTO ticket_notes(ticket_id,author_id,body,created_at) VALUES(?,?,?,?)').run(ticket.id,req.authUser!.id,parsed.data.body,at);
    addTicketEvent(ticket,req.authUser!.id,'internal_note');res.json({ok:true});
  });
  app.post('/api/tickets/:id/action',auth,requireRole(...mutationRoles),async(req,res)=>{
    const ticket=getTicket(String(req.params.id)),parsed=z.object({action:z.enum(['claim','release','priority','reopen','close','transfer']),value:z.string().max(500).optional()}).safeParse(req.body);
    if(!ticket)return res.status(404).json({error:'Ticket not found.'});if(!parsed.success)return res.status(400).json({error:'Invalid action.'});
    const action=parsed.data.action,actor=req.authUser!.id;
    let channel=await client.channels.fetch(ticket.channel_id).catch(()=>null);
    if(action==='claim') {
      const result=toggleClaim(ticket,actor);
      if(result==='conflict')return res.status(409).json({error:'This ticket has already been claimed by another staff member.'});
    if(result==='closed')return res.status(409).json({error:'Reopen this ticket before claiming it.'});
    }
    if(action==='release') {
      if(ticket.claimed_by!==actor)return res.status(409).json({error:'Only the staff member who claimed this ticket can release it.'});
      updateTicket(ticket,actor,'released');
    }
    if(action==='priority') {if(!['low','normal','high','urgent'].includes(parsed.data.value||''))return res.status(400).json({error:'Invalid priority.'});updateTicket(ticket,actor,'priority',parsed.data.value);if(channel?.type===ChannelType.GuildText)await refreshTicketPriorityEmbed(channel as TextChannel,ticket,parsed.data.value as TicketPriority).catch(error=>recordSystemError(client,error,'Ticket priority embed update'));}
    if(action==='reopen') {
      if(ticket.status!=='closed')return res.status(409).json({error:'This ticket is not closed.'});
      if(!channel?.isTextBased()||!('permissionOverwrites' in channel)) {
        try { channel=await recreateTicketChannel(await client.guilds.fetch(ticket.guild_id),ticket); }
        catch(error) {console.error('Could not recreate ticket channel',error);return res.status(502).json({error:tr('No se pudo recrear el canal del ticket.','Could not recreate the ticket channel.')});}
      }
      updateTicket(ticket,actor,'reopened');
    }
    if(action==='close') updateTicket(ticket,actor,'closed',parsed.data.value||'Closed from the dashboard');
    if(action==='transfer') {
      const categoryId=parsed.data.value||'';
      const category=db.prepare('SELECT * FROM categories WHERE id=? AND enabled=1').get(categoryId) as {id:string;name:string;discord_category_id:string|null;support_role_ids:string}|undefined;
      if(!category)return res.status(400).json({error:'Invalid destination category.'});
      const display=categoryText(category.id,category.name,'',ticket.language);
      const oldRoles=supportRoleIdsForCategory(ticket.category_id),newRoles=supportRoleIdsForCategory(categoryId);
      if(channel?.isTextBased()&&'permissionOverwrites' in channel) {
        for(const role of oldRoles.filter(id=>!newRoles.includes(id)))await (channel as TextChannel).permissionOverwrites.delete(role).catch(()=>undefined);
        for(const role of newRoles)await (channel as TextChannel).permissionOverwrites.edit(role,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>undefined);
        await (channel as TextChannel).setParent(category.discord_category_id||null).catch(()=>undefined);
        await (channel as TextChannel).setTopic(`Ticket ${ticket.public_id} · ${display.name}`).catch(()=>undefined);
      }
      updateTicket(ticket,actor,'transferred',categoryId);
    }
    if(channel?.isTextBased()&&'send' in channel) await channel.send(localized(ticket.language,`Ticket actualizado desde el panel por <@${actor}>: **${action}**${parsed.data.value?` · ${urlsafe(parsed.data.value)}`:''}`,`Ticket updated from the dashboard by <@${actor}>: **${action}**${parsed.data.value?` · ${urlsafe(parsed.data.value)}`:''}`)).catch(()=>undefined);
    if(action==='close'&&channel?.isTextBased()&&'messages' in channel) {
      const closed=db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id) as Ticket;
      try { await generateTranscript(closed,channel as TextChannel,actor); }
      catch(e) {console.error('Panel transcript failed',e);return res.status(502).json({error:'Transcript could not be saved; the channel was kept.'});}
      const transcriptRow=db.prepare('SELECT html FROM transcripts WHERE ticket_id=?').get(ticket.id) as {html:Buffer|string}|undefined;
      try {
        const {gunzipSync}=await import('node:zlib');
        const html=transcriptRow?(Buffer.isBuffer(transcriptRow.html)?gunzipSync(transcriptRow.html).toString('utf8'):String(transcriptRow.html)):'';
        if(!html)throw new Error('Transcript not found after generation.');
        await sendTranscriptToDiscord(client,closed,html);
      } catch(e) {console.error('Transcript forwarding failed',e);return res.status(502).json({error:tr('El transcript quedó guardado en el panel, pero no se pudo enviar al canal configurado; se conserva el canal del ticket.','The transcript was saved in the dashboard but could not be sent to the configured channel; the ticket channel was kept.')});}
      await (channel as TextChannel).send(localized(ticket.language,`Ticket ${ticket.public_id} cerrado. La transcripción se guardó en el panel.`,`Ticket ${ticket.public_id} closed. The transcript was saved to the dashboard.`)).catch(()=>undefined);
      try { await (channel as TextChannel).delete(`Ticket ${ticket.public_id} closed; transcript saved`); }
      catch(e) {console.error('Could not delete closed ticket channel',e);return res.status(502).json({error:tr('El transcript se guardó, pero no se pudo borrar el canal. Verifica que el bot tenga Administrar canales.','Transcript saved, but the channel could not be deleted. Check the bot’s Manage Channels permission.')});}
    }
    if(action==='reopen'&&channel?.isTextBased()&&'messages' in channel) {
      await (channel as TextChannel).permissionOverwrites.edit(ticket.owner_id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(()=>undefined);
      await (channel as TextChannel).setName(`ticket-${ticket.public_id.toLowerCase()}`).catch(()=>undefined);
    }
    void sendAudit(client,`**ticket_${action}** · ${ticket.public_id} · ${actor}${parsed.data.value?` · ${parsed.data.value}`:''}`,ticket.language);
    res.json({ok:true});
  });
  app.get('/api/categories',auth,requireRole('readonly'),(_req,res)=>res.json(db.prepare(`${categoriesTable} ORDER BY sort_order,id`).all()));
  app.put('/api/categories/:id',auth,requireRole('admin'),async(req,res)=>{
    const parsed=z.object({name:z.string().trim().min(1).max(80),description:z.string().max(200),emoji:z.string().max(32),discordCategoryId:z.string().regex(/^\d{17,20}$/).nullable(),supportRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(20),enabled:z.boolean(),sortOrder:z.number().int().min(0).max(1000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Invalid category data.'});
    const c=parsed.data;
    if(c.discordCategoryId&&!await hasGuildChannel(c.discordCategoryId,[ChannelType.GuildCategory]))return res.status(400).json({error:'The Discord category does not exist in Run a Police.'});
    if(!await hasGuildRoles(c.supportRoleIds))return res.status(400).json({error:'One or more roles do not belong to Run a Police.'});
    db.prepare('UPDATE categories SET name=?,description=?,emoji=?,discord_category_id=?,support_role_ids=?,enabled=?,sort_order=? WHERE id=?')
      .run(c.name,c.description,c.emoji,c.discordCategoryId,JSON.stringify(c.supportRoleIds),Number(c.enabled),c.sortOrder,String(req.params.id));
    addAdminLog(client,req.authUser!.id,'category_updated',String(req.params.id));void refreshPanel(client).catch(e=>console.error('Could not refresh ticket panel',e));res.json({ok:true});
  });
  app.post('/api/categories',auth,requireRole('admin'),async(req,res)=>{
    const parsed=z.object({id:z.string().regex(/^[a-z0-9-]{2,40}$/),name:z.string().trim().min(1).max(80),description:z.string().max(200),emoji:z.string().max(32),discordCategoryId:z.string().regex(/^\d{17,20}$/).nullable().default(null),supportRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(20).default([])}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Invalid category data.'});
    if(parsed.data.discordCategoryId&&!await hasGuildChannel(parsed.data.discordCategoryId,[ChannelType.GuildCategory]))return res.status(400).json({error:'The Discord category does not exist in Run a Police.'});
    if(!await hasGuildRoles(parsed.data.supportRoleIds))return res.status(400).json({error:'One or more roles do not belong to Run a Police.'});
    const c=parsed.data;try{db.prepare('INSERT INTO categories(id,name,description,emoji,discord_category_id,support_role_ids,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories))')
      .run(c.id,c.name,c.description,c.emoji,c.discordCategoryId,JSON.stringify(c.supportRoleIds));addAdminLog(client,req.authUser!.id,'category_created',c.id);void refreshPanel(client).catch(e=>console.error('Could not refresh ticket panel',e));res.status(201).json({ok:true});}
    catch{res.status(409).json({error:'That category already exists.'});}
  });
  app.delete('/api/categories/:id',auth,requireRole('admin'),(req,res)=>{
    const result=db.prepare('UPDATE categories SET enabled=0 WHERE id=?').run(String(req.params.id));if(!result.changes)return res.status(404).json({error:'Category not found.'});
    addAdminLog(client,req.authUser!.id,'category_disabled',String(req.params.id));void refreshPanel(client).catch(e=>console.error('Could not refresh ticket panel',e));res.json({ok:true});
  });
  app.get('/api/community',auth,requireRole('readonly'),(req,res)=>{
    const rows=db.prepare("SELECT p.*,(SELECT COUNT(*) FROM community_votes v WHERE v.post_id=p.id) AS board_votes FROM community_posts p ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,p.created_at DESC,p.id DESC").all();
    res.json({posts:rows,permissions:{canCreate:['support','supervisor','admin'].includes(req.authUser!.role),canDelete:req.authUser!.role==='admin',canApprove:req.authUser!.id===DEFAULT_PROJECT_OWNER_ID}});
  });
  app.post('/api/community',auth,requireRole(...mutationRoles),async(req,res)=>{
    const parsed=z.object({kind:z.enum(['task','error','problem','suggestion']),title:z.string().trim().min(1).max(200),body:z.string().trim().max(3800),changes:z.string().trim().max(1000).optional().default(''),imageUrl:z.string().trim().max(2000).optional().default('')}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Enter a title and valid community item details.'});
    if(parsed.data.imageUrl&&!/^https:\/\//i.test(parsed.data.imageUrl))return res.status(400).json({error:'The image URL must use HTTPS.'});
    try {
      const post=await createCommunityPost(client,{...parsed.data,imageUrl:parsed.data.imageUrl||null,createdBy:req.authUser!.id});
      addAdminLog(client,req.authUser!.id,'community_post_created',String(post.id));res.status(201).json({ok:true,id:post.id,queued:post.delivery_state==='queued'});
    } catch(error){console.error('Could not create community post from dashboard',error);res.status(502).json({error:'Could not save the community item.'});}
  });
  app.put('/api/community/:id/priority',auth,requireRole(...mutationRoles),async(req,res)=>{
    const id=parseIntParam(req.params.id),parsed=z.object({priority:z.enum(['low','normal','high','urgent'])}).safeParse(req.body);
    if(!id)return res.status(400).json({error:'Invalid community item ID.'});if(!parsed.success)return res.status(400).json({error:'Choose a valid priority.'});
    const updated=await updateCommunityPostPriority(client,id,parsed.data.priority);if(!updated)return res.status(404).json({error:'Community item not found.'});
    addAdminLog(client,req.authUser!.id,'community_priority_updated',`${id}:${parsed.data.priority}`);
    res.json({ok:true,boardUpdated:updated.boardUpdated});
  });
  app.post('/api/community/:id/approve',auth,requireRole('admin'),async(req,res)=>{
    if(req.authUser!.id!==DEFAULT_PROJECT_OWNER_ID)return res.status(403).json({error:'Only the project owner can approve and mark items as completed.'});
    const id=parseIntParam(req.params.id);if(!id)return res.status(400).json({error:'Invalid community item ID.'});
    const result=await approveCommunityPost(client,id,req.authUser!.id);if(!result)return res.status(404).json({error:'Community item not found.'});
    addAdminLog(client,req.authUser!.id,'community_post_approved',String(id));res.json({ok:true,boardUpdated:result.boardUpdated,promoted:result.promoted});
  });
  app.delete('/api/community/:id',auth,requireRole('admin'),async(req,res)=>{
    const id=parseIntParam(req.params.id);if(!id)return res.status(400).json({error:'Invalid community item ID.'});
    try {
      const result=await deleteCommunityPost(client,id);if(!result)return res.status(404).json({error:'Community item not found.'});
      addAdminLog(client,req.authUser!.id,'community_post_deleted',String(id));res.json({ok:true,promoted:result.promoted});
    } catch(error){console.error('Could not delete community item',error);res.status(502).json({error:'Could not delete the community item from Discord. Check the bot permissions and try again.'});}
  });
  app.get('/api/reaction-roles',auth,requireRole('admin'),async(_req,res)=>{
    try {
      const g=await client.guilds.fetch(config.DISCORD_GUILD_ID);await g.roles.fetch();await g.channels.fetch();
      const botMember=g.members.me||await g.members.fetch(client.user!.id);
      const channels=[...g.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(c=>({id:c.id,name:c.name})).sort((a,b)=>a.name.localeCompare(b.name));
      const canManageRoles=botMember.permissions.has(PermissionFlagsBits.ManageRoles);
      const roles=[...g.roles.cache.values()].filter(r=>r.id!==g.id&&!r.managed&&r.tags?.botId!==client.user?.id).map(r=>({id:r.id,name:r.name,position:r.position,assignable:canManageRoles&&r.editable})).sort((a,b)=>b.position-a.position);
      res.json({panels:getReactionRolePanels(),channels,roles,canManageRoles});
    } catch(error){console.error('Could not load reaction role settings',error);res.status(502).json({error:'Could not load channels and roles from Discord.'});}
  });
  app.post('/api/reaction-roles',auth,requireRole('admin'),async(req,res)=>{
    const schema=z.object({messageId:z.string().regex(/^\d{17,20}$/).or(z.literal('')).optional(),channelId:z.string().regex(/^\d{17,20}$/),title:z.string().trim().min(1).max(256),description:z.string().trim().max(1600),mappings:z.array(z.object({emoji:z.string().trim().min(1).max(40),roleId:z.string().regex(/^\d{17,20}$/)})).min(1).max(20)});
    const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Add a channel and between 1 and 20 valid emoji-to-role mappings.'});
    const {channelId,title,description,mappings}=parsed.data,messageId=parsed.data.messageId||'';
    const currentPanels=getReactionRolePanels(),editing=messageId?currentPanels.find(panel=>panel.messageId===messageId):undefined;
    if(messageId&&!editing)return res.status(404).json({error:'Reaction role panel not found.'});
    const emojiKey=(value:string)=>value.match(/^<a?:[A-Za-z0-9_]+:(\d+)>$/)?.[1]||value;
    const keys=mappings.map(item=>emojiKey(item.emoji));if(new Set(keys).size!==keys.length)return res.status(400).json({error:'Each reaction emoji can only be used once.'});
    if(new Set(mappings.map(item=>item.roleId)).size!==mappings.length)return res.status(400).json({error:'Each role can only be used once in a reaction panel.'});
    try {
      const g=await client.guilds.fetch(config.DISCORD_GUILD_ID),channel=await g.channels.fetch(channelId);
      if(!channel||channel.type!==ChannelType.GuildText)return res.status(400).json({error:'Choose a text channel in the configured Discord server.'});
      const botMember=g.members.me||await g.members.fetch(client.user!.id);
      if(!botMember.permissions.has(PermissionFlagsBits.ManageRoles))return res.status(400).json({error:'The bot needs the Manage Roles permission.'});
      const channelPermissions=channel.permissionsFor(botMember);
      if(!channelPermissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AddReactions,PermissionFlagsBits.ReadMessageHistory]))return res.status(400).json({error:'The bot needs View Channel, Send Messages, Embed Links, Add Reactions, and Read Message History in the selected channel.'});
      const resolved=mappings.map(item=>({emoji:item.emoji,emojiKey:emojiKey(item.emoji),role:g.roles.cache.get(item.roleId)}));
      if(resolved.some(item=>!item.role||item.role.id===g.id||item.role.managed||item.role.position>=botMember.roles.highest.position))return res.status(400).json({error:'Choose roles that the bot can manage, below its highest role.'});
      const embed=new EmbedBuilder().setColor(0x5794f5).setTitle(title).setDescription(description||'React below to get or remove a role.').addFields(resolved.map(item=>({name:`${item.emoji}  ${item.role!.name}`,value:`<@&${item.role!.id}>`,inline:true})));
      const sent=await (channel as TextChannel).send({embeds:[embed],allowedMentions:{parse:[]}});
      try {for(const item of resolved)await sent.react(item.emojiKey);}
      catch(error){await sent.delete().catch(()=>undefined);throw error;}
      const updated={channelId,messageId:sent.id,title,description,mappings:resolved.map(item=>({emoji:item.emoji,emojiKey:item.emojiKey,roleId:item.role!.id}))};
      saveReactionRolePanels(editing?currentPanels.map(panel=>panel.messageId===editing.messageId?updated:panel):[...currentPanels,updated]);
      if(editing){const oldChannel=await g.channels.fetch(editing.channelId).catch(()=>null);if(oldChannel?.type===ChannelType.GuildText){const oldMessage=await oldChannel.messages.fetch(editing.messageId).catch(()=>null);if(oldMessage)await oldMessage.delete().catch(()=>undefined);}}
      addAdminLog(client,req.authUser!.id,'reaction_roles_published',`${channelId}:${sent.id}`);
      res.json({ok:true,messageId:sent.id,channelId});
    } catch(error){console.error('Could not publish reaction role panel',error);res.status(502).json({error:'Could not publish the reaction role message. Check the bot permissions and emoji values.'});}
  });
  app.delete('/api/reaction-roles/:messageId',auth,requireRole('admin'),async(req,res)=>{
    const messageId=String(req.params.messageId),panels=getReactionRolePanels(),panel=panels.find(entry=>entry.messageId===messageId);
    if(!panel)return res.status(404).json({error:'Reaction role panel not found.'});
    try {
      const channel=await client.channels.fetch(panel.channelId).catch(()=>null);
      if(channel?.type===ChannelType.GuildText){const message=await channel.messages.fetch(messageId).catch(()=>null);if(message)await message.delete();}
      saveReactionRolePanels(panels.filter(entry=>entry.messageId!==messageId));addAdminLog(client,req.authUser!.id,'reaction_roles_deleted',`${panel.channelId}:${messageId}`);res.json({ok:true});
    } catch(error){console.error('Could not delete reaction role panel',error);res.status(502).json({error:'Could not remove the reaction role message. Check the bot permissions.'});}
  });
  app.get('/api/settings',auth,requireRole('readonly'),(_req,res)=>res.json({
    panelMessage:getSetting('panelMessage','Choose a category to open a private ticket.'),welcomeMessage:getSetting('welcomeMessage','Describe your issue for the support team.'),panelChannelId:getSetting('panelChannelId',DEFAULT_PANEL_CHANNEL_ID)||DEFAULT_PANEL_CHANNEL_ID,
    logChannelId:getSetting('logChannelId',DEFAULT_LOG_CHANNEL_ID)||DEFAULT_LOG_CHANNEL_ID,transcriptChannelId:getSetting('transcriptChannelId',DEFAULT_TRANSCRIPT_CHANNEL_ID)||DEFAULT_TRANSCRIPT_CHANNEL_ID,discordCategoryId:getSetting('discordCategoryId',''),
    panelChannelIdEn:getLocalizedSetting('panelChannelId','en',DEFAULT_PANEL_CHANNEL_ID),logChannelIdEn:getLocalizedSetting('logChannelId','en',DEFAULT_LOG_CHANNEL_ID),transcriptChannelIdEn:getLocalizedSetting('transcriptChannelId','en',DEFAULT_TRANSCRIPT_CHANNEL_ID),discordCategoryIdEn:getLocalizedSetting('discordCategoryId','en',''),panelMessageEn:getLocalizedSetting('panelMessage','en','Choose a category to open a private ticket.'),welcomeMessageEn:getLocalizedSetting('welcomeMessage','en','The support team will help you here. Describe your issue with as much detail as possible.'),
    panelChannelIdEs:getLocalizedSetting('panelChannelId','es',DEFAULT_ES_PANEL_CHANNEL_ID),logChannelIdEs:getLocalizedSetting('logChannelId','es',DEFAULT_ES_LOG_CHANNEL_ID),transcriptChannelIdEs:getLocalizedSetting('transcriptChannelId','es',DEFAULT_ES_TRANSCRIPT_CHANNEL_ID),discordCategoryIdEs:getLocalizedSetting('discordCategoryId','es',''),panelMessageEs:getLocalizedSetting('panelMessage','es','Selecciona una categoría para abrir un ticket privado.'),welcomeMessageEs:getLocalizedSetting('welcomeMessage','es','El equipo de soporte te ayudará aquí. Describe tu problema con el mayor detalle posible.'),
    ticketLimitPerUser:getSetting('ticketLimitPerUser',1),priorityLabels:getSetting('priorityLabels',{en:{low:'Low',normal:'Normal',high:'High',urgent:'Urgent'},es:{low:'Baja',normal:'Normal',high:'Alta',urgent:'Urgente'}}),adminRoleIds:getSetting('adminRoleIds',[]),supervisorRoleIds:getSetting('supervisorRoleIds',[]),supportRoleIds:getSetting('supportRoleIds',[]),readonlyRoleIds:getSetting('readonlyRoleIds',[])
  }));
  app.put('/api/settings',auth,requireRole('admin'),async(req,res)=>{
    const channelId=z.string().regex(/^\d{17,20}$/).or(z.literal('')).optional();
    const schema=z.object({panelChannelIdEn:channelId,panelChannelIdEs:channelId,logChannelIdEn:channelId,logChannelIdEs:channelId,transcriptChannelIdEn:channelId,transcriptChannelIdEs:channelId,discordCategoryIdEn:channelId,discordCategoryIdEs:channelId,panelMessageEn:z.string().max(1800).optional(),panelMessageEs:z.string().max(1800).optional(),welcomeMessageEn:z.string().max(1800).optional(),welcomeMessageEs:z.string().max(1800).optional(),priorityLabels:z.object({en:z.object({low:z.string().trim().min(1).max(32),normal:z.string().trim().min(1).max(32),high:z.string().trim().min(1).max(32),urgent:z.string().trim().min(1).max(32)}),es:z.object({low:z.string().trim().min(1).max(32),normal:z.string().trim().min(1).max(32),high:z.string().trim().min(1).max(32),urgent:z.string().trim().min(1).max(32)})}).optional(),ticketLimitPerUser:z.number().int().min(1).max(10).optional(),adminRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(30).optional(),supervisorRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(30).optional(),supportRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(30).optional(),readonlyRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(30).optional()});
    const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid settings.'});
    const c=parsed.data;
    for(const id of [c.panelChannelIdEn,c.panelChannelIdEs,c.logChannelIdEn,c.logChannelIdEs,c.transcriptChannelIdEn,c.transcriptChannelIdEs])if(id&&!await hasGuildChannel(id,[ChannelType.GuildText]))return res.status(400).json({error:'Panel, log, and transcript destinations must be text channels in Run a Police.'});
    for(const id of [c.discordCategoryIdEn,c.discordCategoryIdEs])if(id&&!await hasGuildChannel(id,[ChannelType.GuildCategory]))return res.status(400).json({error:'Ticket destination categories must belong to Run a Police.'});
    const roles=[...(c.adminRoleIds||[]),...(c.supervisorRoleIds||[]),...(c.supportRoleIds||[]),...(c.readonlyRoleIds||[])];
    if(!await hasGuildRoles([...new Set(roles)]))return res.status(400).json({error:'One or more roles do not belong to Run a Police.'});
    const localeKeys:Record<string,string>={panelChannelIdEn:'panelChannelId_en',panelChannelIdEs:'panelChannelId_es',logChannelIdEn:'logChannelId_en',logChannelIdEs:'logChannelId_es',transcriptChannelIdEn:'transcriptChannelId_en',transcriptChannelIdEs:'transcriptChannelId_es',discordCategoryIdEn:'discordCategoryId_en',discordCategoryIdEs:'discordCategoryId_es',panelMessageEn:'panelMessage_en',panelMessageEs:'panelMessage_es',welcomeMessageEn:'welcomeMessage_en',welcomeMessageEs:'welcomeMessage_es'};
    for(const [key,value] of Object.entries(parsed.data))setSetting(localeKeys[key]||key,value);
    if(c.panelChannelIdEn){setSetting('panelChannelId',c.panelChannelIdEn);}addAdminLog(client,req.authUser!.id,'settings_updated',JSON.stringify(Object.keys(parsed.data)));void refreshPanel(client).catch(e=>console.error('Could not refresh ticket panels',e));res.json({ok:true});
  });
  app.get('/api/logs',auth,requireRole('supervisor'),(req,res)=>{
    const page=Math.min(parseIntParam(req.query.page)||1,10000);const rows=db.prepare(`SELECT e.type,e.detail,e.actor_id,e.created_at,t.public_id FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id ORDER BY e.id DESC LIMIT 100 OFFSET ?`).all((page-1)*100);
    const admin=db.prepare('SELECT actor_id,type,detail,created_at FROM admin_events ORDER BY id DESC LIMIT 100').all();res.json({ticketEvents:rows,adminEvents:admin});
  });
  app.get('/api/backup',auth,requireRole('admin'),async(_req,res)=>{
    const file=path.join(os.tmpdir(),`run-a-police-${crypto.randomUUID()}.sqlite`);
    try {
      await db.backup(file);
      res.set('Cache-Control','no-store').download(file,`run-a-police-backup-${new Date().toISOString().slice(0,10)}.sqlite`,()=>fs.rm(file,{force:true},()=>undefined));
    } catch(error) {await fs.promises.rm(file,{force:true}).catch(()=>undefined);console.error('Database backup failed',error);res.status(500).json({error:'Could not export the database.'});}
  });
  app.put('/api/backup',express.raw({type:'application/octet-stream',limit:'100mb'}),auth,requireRole('admin'),async(req,res)=>{
    const file=path.join(os.tmpdir(),`run-a-police-import-${crypto.randomUUID()}.sqlite`);
    let source:Database.Database|undefined;
    try {
      if(!Buffer.isBuffer(req.body)||req.body.length<100)return res.status(400).json({error:'Choose a valid SQLite backup file.'});
      await fs.promises.writeFile(file,req.body);
      source=new Database(file,{readonly:true,fileMustExist:true});
      if((source.pragma('quick_check') as Array<{quick_check:string}>)[0]?.quick_check!=='ok')throw new Error('SQLite integrity check failed.');
      const tables=['settings','categories','tickets','ticket_events','ticket_notes','transcripts','community_posts','community_votes','ratings','admin_events'];
      const data=tables.map(table=>{
        const exists=source!.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if(!exists)throw new Error(`Backup is missing the ${table} table.`);
        const cols=(source!.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(c=>c.name);
        return {table,cols,rows:source!.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string,unknown>>};
      });
      const deleteOrder=['community_votes','ratings','transcripts','ticket_notes','ticket_events','community_posts','tickets','categories','settings','admin_events'];
      db.transaction(()=>{
        db.pragma('defer_foreign_keys = ON');
        for(const table of deleteOrder)db.prepare(`DELETE FROM ${table}`).run();
        for(const {table,cols,rows} of data) {
          const target=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(c=>c.name));
          const validCols=cols.filter(c=>target.has(c));
          if(!validCols.length)continue;
          const stmt=db.prepare(`INSERT INTO ${table} (${validCols.map(c=>`"${c}"`).join(',')}) VALUES (${validCols.map(()=>'?').join(',')})`);
          for(const row of rows)stmt.run(...validCols.map(c=>row[c]));
        }
      })();
      void refreshPanel(client).catch(error=>recordSystemError(client,error,'Panel refresh after backup import'));
      res.json({ok:true,restoredTables:data.length});
    } catch(error) {
      console.error('Database backup import failed',error);
      res.status(400).json({error:'Could not import this backup. Confirm it is a valid Run a Police SQLite backup.'});
    } finally {source?.close();await fs.promises.rm(file,{force:true}).catch(()=>undefined);}
  });
  app.get('/api/staff',auth,requireRole('readonly'),async(_req,res)=>{
    try {
      // Build this view from existing ticket activity; do not enumerate every guild member.
      const ids=db.prepare("SELECT actor_id id,MAX(id) last_id FROM ticket_events WHERE type IN ('claimed','closed','released','staff_participated') GROUP BY actor_id ORDER BY last_id DESC LIMIT 25").all() as Array<{id:string}>;
      const out=[];
      for(const row of ids) {
        const user=client.users.cache.get(row.id)||await client.users.fetch(row.id).catch(()=>null);if(!user)continue;
        const stats=db.prepare(`SELECT (SELECT COUNT(*) FROM tickets WHERE closed_by=?) closed,
          (SELECT COUNT(*) FROM ticket_events WHERE actor_id=? AND type='claimed') claimed,
          (SELECT AVG((julianday(e.created_at)-julianday(t.created_at))*86400) FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id WHERE e.actor_id=? AND e.type='staff_response') response,
          (SELECT AVG((julianday(closed_at)-julianday(created_at))*86400) FROM tickets WHERE closed_by=? AND closed_at IS NOT NULL) resolution`).get(row.id,row.id,row.id,row.id) as any;
        out.push({id:row.id,username:user.username,avatar:user.avatar,closed:stats.closed||0,claimed:stats.claimed||0,avgResponseSeconds:stats.response?Math.round(stats.response):null,avgResolutionSeconds:stats.resolution?Math.round(stats.resolution):null});
      }
      res.json(out);
    } catch(e){console.error('Could not load staff members',e);res.status(502).json({error:'Could not load the Discord staff list.'});}
  });
  app.post('/api/logout',auth,(req,res)=>{const raw=(req as any).cookies?.['__Host-rap_session']||(req as any).cookies?.rap_session;clearSession(req,res);if(raw)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(raw).digest('hex'));res.json({ok:true});});
  const publicDir=path.join(__dirname,'..','public');app.use(express.static(publicDir,{extensions:['html'],maxAge:0,setHeaders:(res,file)=>{if(/\.(?:html|js|css)$/i.test(file))res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');}}));
  app.get('*path',(req,res,next)=>{if(req.path.startsWith('/api/')||req.path.startsWith('/auth/'))return next();res.sendFile(path.join(publicDir,'index.html'));});
  app.use((err:unknown,_req:Request,res:Response,_next:any)=>{recordSystemError(client,err,'HTTP request error');if(!res.headersSent)res.status(500).json({error:'Error interno.'});});
  return app;
}
function addAdminLog(client:Client,actor:string,type:string,detail:string) {
  db.prepare('INSERT INTO admin_events(actor_id,type,detail,created_at) VALUES(?,?,?,?)').run(actor,type,detail,new Date().toISOString());
  void sendAudit(client,`**${type}** · ${actor} · ${detail}`);
}

