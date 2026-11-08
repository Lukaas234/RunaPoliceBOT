import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { db, getSetting } from './db';
import { Client, PermissionFlagsBits } from 'discord.js';

export type AuthUser={id:string;username:string;avatar:string|null;csrfToken:string;role:'admin'|'supervisor'|'support'|'readonly'};
declare global { namespace Express { interface Request { authUser?:AuthUser } } }
const sha=(x:string)=>crypto.createHash('sha256').update(x).digest('hex');
export function startOAuth():{url:string;state:string} {
  const state=crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO oauth_states(state,expires_at) VALUES(?,?)').run(sha(state),Date.now()+10*60_000);
  const u=new URL('https://discord.com/oauth2/authorize');
  u.searchParams.set('client_id',config.DISCORD_CLIENT_ID);u.searchParams.set('redirect_uri',config.DISCORD_REDIRECT_URI);
  u.searchParams.set('response_type','code');u.searchParams.set('scope','identify');u.searchParams.set('state',state);
  return {url:u.toString(),state};
}
export async function finishOAuth(client:Client,code:string,state:string):Promise<{cookie:string;user:AuthUser}> {
  const stateHash=sha(state);
  const valid=db.prepare('SELECT state FROM oauth_states WHERE state=? AND expires_at>?').get(stateHash,Date.now());
  db.prepare('DELETE FROM oauth_states WHERE expires_at<=?').run(Date.now());
  if(!valid) throw new Error('Your login session expired or is invalid.');
  db.prepare('DELETE FROM oauth_states WHERE state=?').run(stateHash);
  const tokenResponse=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:config.DISCORD_CLIENT_ID,client_secret:config.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:config.DISCORD_REDIRECT_URI})});
  if(!tokenResponse.ok) throw new Error('Discord rejected the authorization request.');
  const token=await tokenResponse.json() as {access_token:string};
  const userResponse=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});
  if(!userResponse.ok) throw new Error('Could not verify your Discord identity.');
  const profile=await userResponse.json() as {id:string;username:string;avatar:string|null};
  const guild=await client.guilds.fetch(config.DISCORD_GUILD_ID);
  const member=guild.members.cache.get(profile.id)||await guild.members.fetch(profile.id).catch(()=>null);
  if(!member) throw new Error('Only Run a Police members can access the dashboard.');
  const role=getRole([...member.roles.cache.keys()],member.permissions.has(PermissionFlagsBits.Administrator));
  if(!role) throw new Error('Your account does not have a role authorized to access the dashboard.');
  const cookie=crypto.randomBytes(32).toString('base64url');
  const csrfToken=crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,username,avatar,csrf_token,expires_at) VALUES(?,?,?,?,?,?)')
    .run(sha(cookie),profile.id,profile.username,profile.avatar,csrfToken,Date.now()+12*60*60_000);
  return {cookie,user:{id:profile.id,username:profile.username,avatar:profile.avatar,csrfToken,role}};
}
function getRole(roles:string[],administrator:boolean):AuthUser['role']|null {
  if(administrator||roles.some(id=>config.bootstrapAdminRoleIds.includes(id))) return 'admin';
  const groups:[AuthUser['role'],string[]][]=[['admin',getSetting('adminRoleIds',[])],['supervisor',getSetting('supervisorRoleIds',[])],['support',getSetting('supportRoleIds',[])],['readonly',getSetting('readonlyRoleIds',[])]];
  for(const [name,ids] of groups) if(roles.some(id=>ids.includes(id))) return name;
  return null;
}
export async function requireAuth(client:Client,req:Request,res:Response,next:NextFunction) {
  try {
    const raw=req.cookies?.['__Host-rap_session'] || req.cookies?.['rap_session'];
    if(!raw) return res.status(401).json({error:'Sign in with Discord.'});
    const row=db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(sha(raw),Date.now()) as {user_id:string;username:string;avatar:string|null;csrf_token:string}|undefined;
    if(!row) return res.status(401).json({error:'Your session has expired.'});
    const guild=await client.guilds.fetch(config.DISCORD_GUILD_ID);
    const member=guild.members.cache.get(row.user_id)||await guild.members.fetch(row.user_id).catch(()=>null);
    if(!member) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(raw)); return res.status(403).json({error:'You are no longer a member of Run a Police.'}); }
    const role=getRole([...member.roles.cache.keys()],member.permissions.has(PermissionFlagsBits.Administrator));
    if(!role) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(raw)); return res.status(403).json({error:'Your role no longer has access.'}); }
    req.authUser={id:row.user_id,username:row.username,avatar:row.avatar,csrfToken:row.csrf_token,role};
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.get('x-csrf-token')!==row.csrf_token) return res.status(403).json({error:'Invalid CSRF token.'});
    next();
  } catch(e) { next(e); }
}
export function requireRole(...roles:AuthUser['role'][]) {
  return (req:Request,res:Response,next:NextFunction)=>{
    const order:AuthUser['role'][]=['readonly','support','supervisor','admin'];
    const current=req.authUser?.role;
    if(!current||Math.max(...roles.map(r=>order.indexOf(r)))>order.indexOf(current)) return res.status(403).json({error:'You are not allowed to perform this action.'});
    next();
  };
}
export function setSessionCookie(res:Response,cookie:string) {
  res.cookie(config.secureCookies?'__Host-rap_session':'rap_session',cookie,{httpOnly:true,secure:config.secureCookies,sameSite:'lax',path:'/',maxAge:12*60*60_000});
}
export function clearSession(req:Request,res:Response) {
  const raw=req.cookies?.['__Host-rap_session'] || req.cookies?.['rap_session'];
  if(raw) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(raw));
  res.clearCookie(config.secureCookies?'__Host-rap_session':'rap_session',{httpOnly:true,secure:config.secureCookies,sameSite:'lax',path:'/'});
}
