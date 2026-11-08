import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from 'discord.js';
import Database from 'better-sqlite3';
import { gzipSync } from 'node:zlib';

const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'rap-ticket-test-'));
process.env.NODE_ENV='test';
process.env.PORT='3000';
process.env.SERVER_PORT='4123';
process.env.HOST='127.0.0.1';
process.env.DATABASE_PATH=path.join(tempDir,'tickets.sqlite');
process.env.DISCORD_TOKEN='test-token';
process.env.DISCORD_CLIENT_ID='123456789012345678';
process.env.DISCORD_CLIENT_SECRET='test-secret';
process.env.DISCORD_REDIRECT_URI='http://localhost:3000/auth/callback';
process.env.DISCORD_GUILD_ID='123456789012345678';
process.env.SESSION_SECRET=crypto.randomBytes(32).toString('hex');
process.env.APP_BASE_URL='http://localhost:3000';

test('persiste el estado, eventos y prioridad de un ticket durante el ciclo de vida',async()=>{
  const {db}=await import('../src/db');
  const {config}=await import('../src/config');
  assert.equal(config.PORT,4123);
  const {getTicket,toggleClaim,updateTicket}=await import('../src/tickets');
  const result=db.prepare('INSERT INTO tickets(public_id,guild_id,channel_id,owner_id,category_id,created_at) VALUES(?,?,?,?,?,?)')
    .run('RAP-900001','123456789012345678','999999999999999901','888888888888888801','general',new Date().toISOString());
  const ticket=getTicket('rap-900001');assert.ok(ticket);assert.equal(ticket.status,'open');
  updateTicket(ticket,'777777777777777701','claimed');
  let current=getTicket('RAP-900001');assert.equal(current?.status,'claimed');assert.equal(current?.claimed_by,'777777777777777701');
  updateTicket(current!,'777777777777777701','priority','urgent');
  current=getTicket('RAP-900001');assert.equal(current?.priority,'urgent');
  updateTicket(current!,'777777777777777701','closed','Resuelto');
  current=getTicket('RAP-900001');assert.equal(current?.status,'closed');assert.equal(current?.close_reason,'Resuelto');assert.ok(current?.closed_at);
  updateTicket(current!,'777777777777777701','reopened');
  current=getTicket('RAP-900001');assert.equal(current?.status,'open');assert.equal(current?.closed_at,null);
  const events=db.prepare('SELECT type FROM ticket_events WHERE ticket_id=? ORDER BY id').all(result.lastInsertRowid) as Array<{type:string}>;
  assert.deepEqual(events.map(e=>e.type),['claimed','priority','closed','reopened']);
  assert.equal(toggleClaim(current!,'777777777777777701'),'claimed');
  assert.equal(toggleClaim(current!,'777777777777777702'),'conflict');
  assert.equal(toggleClaim(current!,'777777777777777701'),'released');
  const backupPath=path.join(tempDir,'backup.sqlite');await db.backup(backupPath);
  const backup=new Database(backupPath,{readonly:true});
  assert.equal((backup.prepare('SELECT status FROM tickets WHERE public_id=?').get('RAP-900001') as {status:string}).status,'open');
  backup.close();
});

test('expone health y panel estático, y exige sesión en la API administrativa',async()=>{
  const {db}=await import('../src/db');
  const {createWebApp}=await import('../src/web');
  const member={permissions:{has:()=>true},roles:{cache:new Map()}};
  const fakeGuild={id:'123456789012345678',name:'Run a Police',members:{cache:new Map(),fetch:async()=>member}};
  const fakeClient={guilds:{cache:new Map([[fakeGuild.id,fakeGuild]]),fetch:async()=>fakeGuild},users:{cache:new Map()},channels:{fetch:async()=>null}};
  const app=createWebApp(fakeClient as unknown as Client);
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  try {
    const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).status,'ok');
    const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(await page.text(),/Run a Police Tickets/);
    const api=await fetch(base+'/api/dashboard');assert.equal(api.status,401);
    const cookie='test-session-cookie',csrf='csrf-token-for-integration-test';
    db.prepare('INSERT INTO sessions(token_hash,user_id,username,avatar,csrf_token,expires_at) VALUES(?,?,?,?,?,?)')
      .run(crypto.createHash('sha256').update(cookie).digest('hex'),'888888888888888801','Test Admin',null,csrf,Date.now()+60000);
    const authHeaders={Cookie:`rap_session=${cookie}`,'x-csrf-token':csrf,'Content-Type':'application/json'};
    const me=await fetch(base+'/api/me',{headers:authHeaders});assert.equal(me.status,200);assert.equal((await me.json()).user.role,'admin');
    const noCsrf=await fetch(base+'/api/categories',{method:'POST',headers:{Cookie:`rap_session=${cookie}`,'Content-Type':'application/json'},body:'{}'});assert.equal(noCsrf.status,403);
    db.prepare('INSERT INTO ratings(ticket_id,user_id,staff_id,score,comment,created_at) VALUES(?,?,?,?,?,?)')
      .run(1,'888888888888888801','777777777777777701',5,'Muy buena atención',new Date().toISOString());
    const dashboard=await fetch(base+'/api/dashboard',{headers:authHeaders});assert.equal((await dashboard.json()).satisfaction,5);
    db.prepare('INSERT INTO transcripts(ticket_id,html,created_at) VALUES(?,?,?)').run(1,gzipSync(Buffer.from('<html>Transcript QA</html>')),new Date().toISOString());
    const transcript=await fetch(base+'/api/tickets/RAP-900001/transcript',{headers:authHeaders});assert.equal(transcript.status,200);assert.match(await transcript.text(),/Transcript QA/);
    const category=await fetch(base+'/api/categories',{method:'POST',headers:authHeaders,body:JSON.stringify({id:'api-test',name:'API Test',description:'Category endpoint check',emoji:'🧪',discordCategoryId:null,supportRoleIds:[]})});
    assert.equal(category.status,201);
    const listed=await fetch(base+'/api/categories',{headers:authHeaders});assert.equal(listed.status,200);assert.ok((await listed.json()).some((x:{id:string})=>x.id==='api-test'));
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    db.close();
  }
});

after(()=>fs.rmSync(tempDir,{recursive:true,force:true}));
