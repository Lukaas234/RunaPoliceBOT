import { Client } from 'discord.js';
import { getLocalizedSetting } from './db';
import { db } from './db';
import { DEFAULT_COMMUNITY_LOG_CHANNEL_ID, DEFAULT_ES_LOG_CHANNEL_ID, DEFAULT_LOG_CHANNEL_ID } from './server-defaults';
import { AppLanguage } from './i18n';

export async function sendAudit(client:Client,message:string,locale:AppLanguage='en'):Promise<void> {
  const fallback=locale==='es'?DEFAULT_ES_LOG_CHANNEL_ID:DEFAULT_LOG_CHANNEL_ID;
  const channelId=getLocalizedSetting<string>('logChannelId',locale,fallback)||fallback;
  try {
    const channel=await client.channels.fetch(channelId);
    if(channel?.isTextBased()&&'send' in channel) await channel.send({content:message.slice(0,1900),allowedMentions:{parse:[]}});
  } catch(error) {console.error('Could not send Discord audit log',error);}
}
export async function sendCommunityAudit(client:Client,message:string):Promise<void> {
  try {
    const channel=await client.channels.fetch(DEFAULT_COMMUNITY_LOG_CHANNEL_ID);
    if(channel?.isTextBased()&&'send' in channel)await channel.send({content:message.slice(0,1900),allowedMentions:{parse:[]}});
    else console.error(`Community audit channel ${DEFAULT_COMMUNITY_LOG_CHANNEL_ID} is not a text channel.`);
  } catch(error){console.error('Could not send community audit log',error);}
}
export function recordSystemError(client:Client,error:unknown,context:string):void {
  const message=error instanceof Error?error.message:String(error);
  console.error(context,error);
  try { db.prepare('INSERT INTO admin_events(actor_id,type,detail,created_at) VALUES(?,?,?,?)').run('system','system_error',`${context}: ${message}`.slice(0,2000),new Date().toISOString()); }
  catch(logError) { console.error('Could not persist system error',logError); }
  void sendAudit(client,`**system_error** · ${context}: ${message}`);
}
