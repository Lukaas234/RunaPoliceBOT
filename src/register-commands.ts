import { registerCommands } from './discord';
registerCommands().then(()=>{console.log('Guild commands registered.');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)});
