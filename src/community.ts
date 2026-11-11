import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType, Client, EmbedBuilder,
  ForumChannel, Message, TextChannel, ThreadChannel
} from 'discord.js';
import { db, getSetting } from './db';
import { isStaff } from './tickets';
import { DEFAULT_COMMUNITY_BOARD_CHANNEL_ID, DEFAULT_COMMUNITY_FORUM_ID, DEFAULT_PROJECT_OWNER_ID } from './server-defaults';

export type CommunityKind='task'|'error'|'problem'|'suggestion';
export type CommunityPriority='low'|'normal'|'high'|'urgent';
type CommunityPost={id:number;source_thread_id:string|null;target_channel_id:string;target_message_id:string|null;kind:CommunityKind;title:string;body:string;changes:string;image_url:string|null;priority:CommunityPriority;source_votes:number;delivery_state:'queued'|'publishing'|'published';board_votes?:number;status:'pending'|'approved';created_by:string;created_at:string;approved_by:string|null;approved_at:string|null};
export const MAX_ACTIVE_COMMUNITY_POSTS=8;
export const FORUM_REACTION_THRESHOLD=10;
const names:Record<CommunityKind,string>={task:'Pending task',error:'Bug',problem:'Problem',suggestion:'Suggestion'};
const priorityNames:Record<CommunityPriority,string>={low:'Low',normal:'Normal',high:'High',urgent:'Urgent'};
const kindColor:Record<CommunityKind,number>={task:0x3b82f6,error:0xef4444,problem:0xf59e0b,suggestion:0x8b5cf6};
const clip=(value:string,max:number)=>value.trim().slice(0,max);
const safeImage=(value:string|null|undefined):string|null=>{if(!value)return null;try{const url=new URL(value);return url.protocol==='https:'?url.toString():null}catch{return null}};
const targetId=()=>getSetting<string>('communityBoardChannelId',DEFAULT_COMMUNITY_BOARD_CHANNEL_ID)||DEFAULT_COMMUNITY_BOARD_CHANNEL_ID;
const votesFor=(id:number)=>(db.prepare('SELECT COUNT(*) n FROM community_votes WHERE post_id=?').get(id) as {n:number}).n;
const label=(kind:CommunityKind)=>names[kind];
const isApproved=(post:CommunityPost)=>post.status==='approved';

function components(post:CommunityPost,votes:number) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`community:vote:${post.id}`).setLabel(`👍 Vote · ${votes}`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`community:approve:${post.id}`).setLabel('✅ Approved · Completed').setStyle(ButtonStyle.Success).setDisabled(isApproved(post))
  )];
}
function postEmbed(post:CommunityPost,votes=votesFor(post.id)) {
  const approved=isApproved(post),embed=new EmbedBuilder().setColor(approved?0x22c55e:kindColor[post.kind]).setTitle(`${names[post.kind]} · ${post.title}`.slice(0,256)).setDescription(post.body||'No additional description.').addFields(
    {name:'Status',value:approved?'Approved · Completed':'Pending',inline:true},
    {name:'Priority',value:priorityNames[post.priority]||'Normal',inline:true},
    {name:'Staff votes',value:String(votes),inline:true},
    {name:'Forum reactions',value:String(post.source_votes),inline:true}
  ).setFooter({text:`Run a Police · Community Board #${post.id}`}).setTimestamp(new Date(post.created_at));
  if(post.changes)embed.addFields({name:'Changes included',value:post.changes.slice(0,1024)});
  if(post.source_thread_id)embed.addFields({name:'Original forum post',value:`https://discord.com/channels/${process.env.DISCORD_GUILD_ID||'0'}/${post.source_thread_id}`});
  if(approved&&post.approved_by)embed.addFields({name:'Approved by',value:`<@${post.approved_by}>`,inline:true});
  if(post.image_url)embed.setImage(post.image_url);
  return embed;
}
function reservePost(input:{sourceThreadId?:string|null;kind:CommunityKind;title:string;body?:string;changes?:string;imageUrl?:string|null;sourceVotes?:number;createdBy:string}):CommunityPost {
  return db.transaction(()=>{
    const destination=targetId();
    const active=(db.prepare("SELECT COUNT(*) n FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state IN ('publishing','published')").get(destination) as {n:number}).n;
    const queued=(db.prepare("SELECT COUNT(*) n FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state='queued'").get(destination) as {n:number}).n;
    const deliveryState=active<MAX_ACTIVE_COMMUNITY_POSTS&&queued===0?'publishing':'queued';
    const result=db.prepare(`INSERT INTO community_posts(source_thread_id,target_channel_id,kind,title,body,changes,image_url,source_votes,delivery_state,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.sourceThreadId||null,destination,input.kind,clip(input.title,200),clip(input.body||'',3800),clip(input.changes||'',1000),safeImage(input.imageUrl),input.sourceVotes||0,deliveryState,input.createdBy,new Date().toISOString());
    return db.prepare('SELECT * FROM community_posts WHERE id=?').get(Number(result.lastInsertRowid)) as CommunityPost;
  })();
}
async function publishReservedPost(client:Client,post:CommunityPost):Promise<CommunityPost> {
  try {
    const target=await client.channels.fetch(post.target_channel_id);
    if(!target?.isTextBased()||!('send' in target))throw new Error(`Community board ${post.target_channel_id} is not a text channel.`);
    const message=await (target as TextChannel).send({embeds:[postEmbed(post,0)],components:components(post,0),allowedMentions:{parse:[]}});
    db.prepare("UPDATE community_posts SET target_message_id=?,delivery_state='published' WHERE id=?").run(message.id,post.id);
    return {...post,target_message_id:message.id,delivery_state:'published'};
  } catch(error) {
    db.prepare("UPDATE community_posts SET delivery_state='queued',target_message_id=NULL WHERE id=? AND status='pending'").run(post.id);
    throw error;
  }
}
export async function createCommunityPost(client:Client,input:{sourceThreadId?:string|null;kind:CommunityKind;title:string;body?:string;changes?:string;imageUrl?:string|null;sourceVotes?:number;createdBy:string}):Promise<CommunityPost> {
  if(input.sourceThreadId&&db.prepare('SELECT id FROM community_posts WHERE source_thread_id=?').get(input.sourceThreadId))throw new Error('This forum post was already forwarded.');
  const post=reservePost(input);
  if(post.delivery_state==='queued')return post;
  try {return await publishReservedPost(client,post);}
  catch(error) {console.error('Community post queued after delivery failure',error);return db.prepare('SELECT * FROM community_posts WHERE id=?').get(post.id) as CommunityPost;}
}
export async function fillCommunityQueue(client:Client):Promise<number> {
  let published=0;
  while(true) {
    const reserved=db.transaction(()=>{
      const destination=targetId();
      const active=(db.prepare("SELECT COUNT(*) n FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state IN ('publishing','published')").get(destination) as {n:number}).n;
      if(active>=MAX_ACTIVE_COMMUNITY_POSTS)return null;
      const next=db.prepare("SELECT id FROM community_posts WHERE target_channel_id=? AND status='pending' AND delivery_state='queued' ORDER BY created_at,id LIMIT 1").get(destination) as {id:number}|undefined;
      if(!next)return null;
      db.prepare("UPDATE community_posts SET delivery_state='publishing' WHERE id=? AND delivery_state='queued'").run(next.id);
      return db.prepare('SELECT * FROM community_posts WHERE id=?').get(next.id) as CommunityPost;
    })();
    if(!reserved)break;
    try {await publishReservedPost(client,reserved);published++;}
    catch(error){console.error('Could not publish queued community post',error);break;}
  }
  return published;
}
export async function recoverCommunityQueue(client:Client):Promise<void> {
  db.prepare("UPDATE community_posts SET delivery_state='queued',target_message_id=NULL WHERE status='pending' AND delivery_state='publishing' AND target_message_id IS NULL").run();
  const overflow=db.prepare("SELECT id,target_channel_id,target_message_id FROM community_posts WHERE status='pending' AND delivery_state='published' ORDER BY created_at,id LIMIT -1 OFFSET ?").all(MAX_ACTIVE_COMMUNITY_POSTS) as Array<{id:number;target_channel_id:string;target_message_id:string|null}>;
  for(const row of overflow) {
    try {
      const channel=await client.channels.fetch(row.target_channel_id);
      if(channel?.isTextBased()&&'messages' in channel&&row.target_message_id) {
        const message=await channel.messages.fetch(row.target_message_id).catch(()=>null);
        if(message)await message.delete();
      }
      db.prepare("UPDATE community_posts SET delivery_state='queued',target_message_id=NULL WHERE id=? AND status='pending'").run(row.id);
    } catch(error) {console.error(`Could not move overflow community post #${row.id} into queue`,error);}
  }
  await fillCommunityQueue(client);
}
function inferKind(thread:ThreadChannel,body:string):CommunityKind {
  const forum=thread.parent;
  if(forum?.type===ChannelType.GuildForum) {
    const tags=(forum as ForumChannel).availableTags.filter(tag=>thread.appliedTags.includes(tag.id)).map(tag=>tag.name).join(' ').toLowerCase();
    if(/error|bug|fallo/.test(tags))return 'error';
    if(/problem|problema|issue/.test(tags))return 'problem';
    if(/task|tarea|todo/.test(tags))return 'task';
    if(/suggest|suger/.test(tags))return 'suggestion';
  }
  const source=`${thread.name} ${body}`.toLowerCase();
  if(/\b(error|bug|fallo|error\s+report)\b/.test(source))return 'error';
  if(/\b(problema|problem|issue)\b/.test(source))return 'problem';
  if(/\b(tarea|task|todo|pendiente)\b/.test(source))return 'task';
  return 'suggestion';
}
function imageFrom(message:Message):string|null {
  const attachment=[...message.attachments.values()].find(a=>a.contentType?.startsWith('image/'));
  return safeImage(attachment?.url||message.embeds.find(e=>e.image?.url)?.image?.url||null);
}
async function countThreadReactions(thread:ThreadChannel):Promise<number> {
  const messages=await thread.messages.fetch({limit:100});
  const starter=await thread.fetchStarterMessage().catch(()=>null);
  const all=new Map(messages.map(message=>[message.id,message]));if(starter)all.set(starter.id,starter);
  return [...all.values()].reduce((sum,message)=>sum+[...message.reactions.cache.values()].reduce((total,reaction)=>total+Math.max(0,reaction.count-(reaction.me?1:0)),0),0);
}
export async function forwardForumThread(client:Client,thread:ThreadChannel,reactionCount:number):Promise<void> {
  if(thread.parentId!==DEFAULT_COMMUNITY_FORUM_ID||reactionCount<=FORUM_REACTION_THRESHOLD)return;
  if(db.prepare('SELECT id FROM community_posts WHERE source_thread_id=?').get(thread.id))return;
  const starter=await thread.fetchStarterMessage().catch(()=>null);if(!starter)return;
  const content=starter.content||'';
  const changeMatch=content.match(/(?:cambios?|changes?)\s*:\s*([\s\S]+)$/i);
  const post=await createCommunityPost(client,{sourceThreadId:thread.id,kind:inferKind(thread,content),title:thread.name,body:content||'Forum post without text.',changes:changeMatch?.[1]||'',imageUrl:imageFrom(starter),sourceVotes:reactionCount,createdBy:starter.author.id});
  void post;
}
export async function inspectForumReaction(client:Client,message:Message):Promise<void> {
  if(!message.guild||message.guild.id!==process.env.DISCORD_GUILD_ID)return;
  const thread=message.channel;
  if(!thread.isThread()||thread.parentId!==DEFAULT_COMMUNITY_FORUM_ID)return;
  const count=await countThreadReactions(thread);
  if(count>FORUM_REACTION_THRESHOLD)await forwardForumThread(client,thread,count);
}
export async function handleCommunityButton(interaction:ButtonInteraction):Promise<boolean> {
  const match=interaction.customId.match(/^community:(vote|approve):(\d+)$/);if(!match)return false;
  const [,action,idText]=match,id=Number(idText),post=db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as CommunityPost|undefined;
  if(!post){await interaction.reply({content:'This post no longer exists.',ephemeral:true});return true;}
  if(action==='approve') {
    if(interaction.user.id!==DEFAULT_PROJECT_OWNER_ID){await interaction.reply({content:'Only the project owner can approve and mark this as completed.',ephemeral:true});return true;}
    if(post.status!=='approved')db.prepare('UPDATE community_posts SET status=\'approved\',approved_by=?,approved_at=? WHERE id=?').run(interaction.user.id,new Date().toISOString(),id);
  } else {
    if(!interaction.guild||!await isStaff(interaction.guild,interaction.user.id)) {
      await interaction.reply({content:'Only support staff can vote on board items.',ephemeral:true});return true;
    }
    db.transaction(()=>{
      const exists=db.prepare('SELECT 1 FROM community_votes WHERE post_id=? AND user_id=?').get(id,interaction.user.id);
      if(exists)db.prepare('DELETE FROM community_votes WHERE post_id=? AND user_id=?').run(id,interaction.user.id);
      else db.prepare('INSERT INTO community_votes(post_id,user_id,created_at) VALUES(?,?,?)').run(id,interaction.user.id,new Date().toISOString());
    })();
  }
  const updated=db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as CommunityPost;
  const votes=votesFor(id),embed=postEmbed(updated,votes),rows=components(updated,votes);
  try {await interaction.message.edit({embeds:[embed],components:rows,allowedMentions:{parse:[]}});}
  catch(error){console.error('Could not update community board embed',error);}
  const promoted=action==='approve'?await fillCommunityQueue(interaction.client):0;
  await interaction.reply({content:action==='approve'?`Marked approved and completed.${promoted?` Published ${promoted} queued item${promoted===1?'':'s'}.`:''}`:`Vote updated · ${votes} staff votes.`,ephemeral:true});
  return true;
}
export function listPendingCommunityPosts(limit=10):CommunityPost[] {
  return db.prepare("SELECT p.*,(SELECT COUNT(*) FROM community_votes v WHERE v.post_id=p.id) board_votes FROM community_posts p WHERE p.status='pending' ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,p.source_votes+(SELECT COUNT(*) FROM community_votes v2 WHERE v2.post_id=p.id) DESC,p.created_at DESC LIMIT ?").all(limit) as CommunityPost[];
}
export function communityListEmbed(posts:CommunityPost[]):EmbedBuilder {
  const embed=new EmbedBuilder().setColor(0x3b82f6).setTitle('Community backlog').setDescription(posts.length?'Forum reactions and staff votes for tasks, bugs, problems, and suggestions.':'There are no pending posts.');
  for(const p of posts)embed.addFields({name:`#${p.id} · ${priorityNames[p.priority]||'Normal'} · ${label(p.kind)} · ${p.title}`.slice(0,256),value:`${p.delivery_state==='queued'?'Queued':'Posted'} · Forum reactions: ${p.source_votes} · Staff votes: ${p.board_votes??votesFor(p.id)} · <#${p.target_channel_id}>`});
  return embed;
}
export async function updateCommunityPostPriority(client:Client,id:number,priority:CommunityPriority):Promise<{post:CommunityPost;boardUpdated:boolean}|null> {
  const current=db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as CommunityPost|undefined;if(!current)return null;
  db.prepare('UPDATE community_posts SET priority=? WHERE id=?').run(priority,id);
  const post=db.prepare('SELECT *,(SELECT COUNT(*) FROM community_votes WHERE post_id=?) board_votes FROM community_posts WHERE id=?').get(id,id) as CommunityPost;
  if(!post.target_message_id||post.delivery_state!=='published')return {post,boardUpdated:true};
  try {
    const channel=await client.channels.fetch(post.target_channel_id);
    if(!channel?.isTextBased()||!('messages' in channel))return {post,boardUpdated:false};
    const message=await channel.messages.fetch(post.target_message_id);
    await message.edit({embeds:[postEmbed(post,post.board_votes)],components:components(post,post.board_votes||0),allowedMentions:{parse:[]}});
    return {post,boardUpdated:true};
  } catch(error){console.error(`Could not update priority on community post #${id}`,error);return {post,boardUpdated:false};}
}
async function refreshCommunityMessage(client:Client,post:CommunityPost):Promise<boolean> {
  if(!post.target_message_id||post.delivery_state!=='published')return true;
  try {
    const channel=await client.channels.fetch(post.target_channel_id);
    if(!channel?.isTextBased()||!('messages' in channel))return false;
    const message=await channel.messages.fetch(post.target_message_id);
    await message.edit({embeds:[postEmbed(post,votesFor(post.id))],components:components(post,votesFor(post.id)),allowedMentions:{parse:[]}});
    return true;
  } catch(error){console.error(`Could not refresh community post #${post.id}`,error);return false;}
}
export async function approveCommunityPost(client:Client,id:number,actorId:string):Promise<{post:CommunityPost;boardUpdated:boolean;promoted:number}|null> {
  const current=db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as CommunityPost|undefined;if(!current)return null;
  if(current.status!=='approved')db.prepare("UPDATE community_posts SET status='approved',approved_by=?,approved_at=? WHERE id=?").run(actorId,new Date().toISOString(),id);
  const post=db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as CommunityPost;
  const boardUpdated=await refreshCommunityMessage(client,post),promoted=await fillCommunityQueue(client);
  return {post,boardUpdated,promoted};
}
export async function deleteCommunityPost(client:Client,id:number):Promise<{post:CommunityPost;promoted:number}|null> {
  const post=db.prepare('SELECT * FROM community_posts WHERE id=?').get(id) as CommunityPost|undefined;if(!post)return null;
  if(post.target_message_id&&post.delivery_state==='published') {
    const channel=await client.channels.fetch(post.target_channel_id).catch(()=>null);
    if(channel?.isTextBased()&&'messages' in channel) {
      const message=await channel.messages.fetch(post.target_message_id).catch(error=>{if(error&&typeof error==='object'&&'code' in error&&(error as {code:number}).code===10008)return null;throw error;});
      if(message)await message.delete();
    }
  }
  db.prepare('DELETE FROM community_posts WHERE id=?').run(id);
  const promoted=post.status==='pending'&&post.delivery_state==='published'?await fillCommunityQueue(client):0;
  return {post,promoted};
}
export async function scanActiveForumThreads(client:Client):Promise<void> {
  const forum=await client.channels.fetch(DEFAULT_COMMUNITY_FORUM_ID).catch(()=>null);
  if(!forum||forum.type!==ChannelType.GuildForum)return;
  const active=await forum.threads.fetchActive().catch(()=>null);if(!active)return;
  for(const thread of active.threads.values()) {
    const count=await countThreadReactions(thread).catch(()=>0);
    if(count>FORUM_REACTION_THRESHOLD)await forwardForumThread(client,thread,count).catch(error=>console.error('Could not forward popular forum post',error));
  }
}
