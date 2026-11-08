export type AppLanguage='es'|'en';
export const tr=(spanish:string,english:string):string=>english;
export const localized=(locale:AppLanguage,spanish:string,english:string):string=>locale==='es'?spanish:english;
