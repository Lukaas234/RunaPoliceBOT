import { Client, EmbedBuilder, Message, TextChannel } from 'discord.js';
import { db, getLocalizedSetting } from './db';
import { categoryText, Ticket, addTicketEvent } from './tickets';
import { gzipSync } from 'node:zlib';
import { localized } from './i18n';
import { DEFAULT_ES_TRANSCRIPT_CHANNEL_ID, DEFAULT_TRANSCRIPT_CHANNEL_ID } from './server-defaults';

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function sendTranscriptToDiscord(client:Client,ticket:Ticket,html:string):Promise<void> {
  const fallback=ticket.language==='es'?DEFAULT_ES_TRANSCRIPT_CHANNEL_ID:DEFAULT_TRANSCRIPT_CHANNEL_ID;
  const channelId=getLocalizedSetting<string>('transcriptChannelId',ticket.language,fallback)||fallback;
  const channel=await client.channels.fetch(channelId);
  if(!channel?.isTextBased()||!('send' in channel))throw new Error(`Transcript channel ${channelId} is unavailable or is not a text channel.`);
  const category=db.prepare('SELECT name,emoji FROM categories WHERE id=?').get(ticket.category_id) as {name:string;emoji:string}|undefined;
  const display=category?categoryText(ticket.category_id,category.name,'',ticket.language):null;
  const embed=new EmbedBuilder().setColor(ticket.status==='closed'?0x64748b:0x3b82f6)
    .setTitle(`${localized(ticket.language,'Transcripción','Transcript')} · ${ticket.public_id}`)
    .setDescription(localized(ticket.language,'La transcripción HTML está comprimida en el archivo adjunto para que Discord no muestre el código fuente en el mensaje. Descárgala y descomprímela para abrirla en tu navegador.','The HTML transcript is compressed in the attachment so Discord does not display its source code in the message. Download and decompress it to open it in your browser.'))
    .addFields(
      {name:localized(ticket.language,'Categoría','Category'),value:`${category?.emoji||'🎫'} ${display?.name||ticket.category_id}`,inline:true},
      {name:localized(ticket.language,'Abierto por','Opened by'),value:`<@${ticket.owner_id}>`,inline:true},
      {name:localized(ticket.language,'Estado','Status'),value:localized(ticket.language,ticket.status==='closed'?'Cerrado':ticket.status==='claimed'?'Reclamado':'Abierto',ticket.status==='closed'?'Closed':ticket.status==='claimed'?'Claimed':'Open'),inline:true},
      ...(ticket.closed_by?[{name:localized(ticket.language,'Cerrado por','Closed by'),value:`<@${ticket.closed_by}>`,inline:true}]:[]),
      ...(ticket.close_reason?[{name:localized(ticket.language,'Motivo de cierre','Close reason'),value:ticket.close_reason.slice(0,1024),inline:false}]:[])
    ).setFooter({text:'Run a Police Tickets · HTML transcript'}).setTimestamp(new Date(ticket.closed_at||ticket.created_at));
  await channel.send({embeds:[embed],files:[{attachment:gzipSync(Buffer.from(html,'utf8')) ,name:`${ticket.public_id}.html.gz`}],allowedMentions:{parse:[]}});
}
const date=(s:Date,locale:'en'|'es')=>s.toLocaleString(locale==='en'?'en-US':'es-UY',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'});
export async function generateTranscript(ticket:Ticket,channel:TextChannel,actorId:string):Promise<string> {
  const pages:string[][]=[]; let before:string|undefined,truncated=false,count=0;
  // Render each page immediately and cap retained messages to keep peak memory bounded.
  for(let i=0;i<20;i++) {
    const batch=await channel.messages.fetch({limit:100,...(before?{before}:{})});
    if(!batch.size) break;
    const fetched=[...batch.values()];before=fetched[fetched.length-1]?.id;
    const rows=fetched.reverse();
    pages.push(rows.map(m=>{
      const files=[...m.attachments.values()].map(a=>`<a href="${esc(a.url)}" rel="noreferrer">${esc(a.name||'Attachment')}</a>`).join(' · ');
      const content=esc(m.content||'').replace(/\n/g,'<br>');
      const embeds=m.embeds.map(e=>`<aside class="embedded">${e.title?`<strong>${esc(e.title)}</strong>`:''}${e.description?`<p>${esc(e.description).replace(/\n/g,'<br>')}</p>`:''}${e.url?`<a href="${esc(e.url)}" rel="noreferrer">${esc(e.url)}</a>`:''}</aside>`).join('');
      return `<article class="message"><header><span class="author"><img src="${esc(m.author.displayAvatarURL({size:64}))}" alt=""><b>${esc(m.author.tag)}</b></span><time>${esc(date(m.createdAt,ticket.language))}</time></header><p>${content||'<i>(no text)</i>'}</p>${embeds}${files?`<footer>Attachments: ${files}</footer>`:''}</article>`;
    }));
    count+=rows.length;
    if(batch.size<100) break;
    if(i===19)truncated=true;
  }
  const messages=pages.reverse().flat().join('\n');
  const category=db.prepare('SELECT name,emoji FROM categories WHERE id=?').get(ticket.category_id) as {name:string;emoji:string}|undefined;
  const display=category?categoryText(ticket.category_id,category.name,'',ticket.language):null;
  const t=(es:string,en:string)=>localized(ticket.language,es,en),fmt=(s:Date)=>date(s,ticket.language);
  const html=`<!doctype html><html lang="${ticket.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark light"><title>${esc(t('Transcripción','Transcript'))} ${esc(ticket.public_id)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1120;color:#e5eaf3;font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1000px;margin:36px auto;padding:0 20px}.head,.message{background:#121b2d;border:1px solid #25334a;border-radius:14px;padding:20px;margin:14px 0;box-shadow:0 8px 24px #0002}.head h1{margin:0;font-size:25px}.brand{color:#91a0b8;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:20px}.meta>div{background:#0b1120;border:1px solid #25334a;border-radius:10px;padding:12px;overflow-wrap:anywhere}.meta span{display:block;color:#91a0b8;font-size:12px;margin-bottom:3px}.message header{display:flex;align-items:center;justify-content:space-between;gap:16px;color:#9cb7e8}.message header b{color:#f4f7fc}.message p{margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.message footer{margin-top:10px;padding-top:8px;border-top:1px solid #25334a;color:#a9b7cc;font-size:13px}.author{display:flex;align-items:center;gap:10px}.author img{width:34px;height:34px;border-radius:50%}.embedded{margin-top:10px;padding:12px;border-left:3px solid #6b8cff;background:#0b1120;border-radius:6px;overflow-wrap:anywhere}.embedded p{margin:6px 0}a{color:#74aaff}time{font-size:12px;color:#91a0b8}.notice{border-left:3px solid #f5b942;color:#cbd5e1}@media(max-width:600px){.wrap{margin:16px auto;padding:0 12px}.head,.message{padding:15px}.head h1{font-size:20px}}@media print{body{background:white;color:#111}.head,.message{background:white;color:#111;border-color:#ddd;box-shadow:none}.meta>div,.embedded{background:white;border-color:#ddd}.meta span,time{color:#555}}
  </style></head><body><main class="wrap"><section class="head"><div class="brand">Run a Police · ${esc(t('Transcripción de ticket','Ticket transcript'))}</div><h1>${esc(ticket.public_id)}</h1><div class="meta"><div><span>${esc(t('Usuario','User'))}</span>${esc(ticket.owner_id)}</div><div><span>${esc(t('Categoría','Category'))}</span>${esc(`${category?.emoji||'🎫'} ${display?.name||ticket.category_id}`)}</div><div><span>${esc(t('Creado','Created'))}</span>${esc(fmt(new Date(ticket.created_at)))}</div><div><span>${esc(t('Cerrado','Closed'))}</span>${esc(ticket.closed_at?fmt(new Date(ticket.closed_at)):t('Abierto','Open'))}</div><div><span>${esc(t('Responsable','Assigned to'))}</span>${esc(ticket.closed_by||'—')}</div><div><span>${esc(t('Motivo','Reason'))}</span>${esc(ticket.close_reason||'—')}</div></div></section>${truncated?`<p class="head notice">${esc(t('Se muestran los 2.000 mensajes más recientes. Los mensajes anteriores se omitieron por el límite de transcript.','Showing the 2,000 most recent messages. Earlier messages were omitted due to the transcript limit.'))}</p>`:''}<section>${messages||`<p class="head">${esc(t('No hay mensajes en el canal.','There are no messages in this channel.'))}</p>`}</section></main></body></html>`;
  db.prepare('INSERT INTO transcripts(ticket_id,html,created_at) VALUES(?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET html=excluded.html,created_at=excluded.created_at')
    .run(ticket.id,gzipSync(Buffer.from(html,'utf8')),new Date().toISOString());
  addTicketEvent(ticket,actorId,'transcript_generated',String(count));
  return html;
}
