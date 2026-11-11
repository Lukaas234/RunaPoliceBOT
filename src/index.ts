import { config } from './config';
import { DATABASE_FILE, db, setSetting } from './db';
import { client, ensureTicketResponderRoleAccess, refreshPanel, registerCommands, startDiscord } from './discord';
import { createWebApp } from './web';
import { recordSystemError } from './audit';

async function main() {
  console.log(`Persistent SQLite database: ${DATABASE_FILE}`);
  if(config.bootstrapAdminRoleIds.length) setSetting('bootstrapAdminRoleIds',config.bootstrapAdminRoleIds);
  await startDiscord();
  await ensureTicketResponderRoleAccess(client);
  await registerCommands();
  void refreshPanel(client).catch(error=>recordSystemError(client,error,'Default ticket panel setup'));
  const app=createWebApp(client);
  const server=app.listen(config.PORT,config.HOST,()=>console.log(`Web panel listening on ${config.HOST}:${config.PORT}`));
  const stop=async(signal:string)=>{
    console.log(`Received ${signal}; shutting down cleanly.`);
    server.close();
    await client.destroy();
    try { db.pragma('wal_checkpoint(TRUNCATE)');db.close(); } catch(e) {console.error('Database shutdown issue',e);}
    process.exit(0);
  };
  process.once('SIGTERM',()=>void stop('SIGTERM'));
  process.once('SIGINT',()=>void stop('SIGINT'));
  process.on('unhandledRejection',e=>recordSystemError(client,e,'Unhandled rejection'));
  process.on('uncaughtException',e=>{recordSystemError(client,e,'Uncaught exception');process.exit(1);});
}
main().catch(error=>{console.error('Application startup failed',error);process.exit(1);});
