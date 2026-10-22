import {createHook,errText} from './state.mjs';
export const PROVIDERS = Object.freeze(['local','gdrive','icloud','dropbox']);
export const PROVIDER_LABELS = Object.freeze({local:'Local only',gdrive:'Drive snapshot',icloud:'iCloud folder',dropbox:'Dropbox folder'});
// Translated labels for the same four providers, keyed by locale (src/config.mjs LOCALES: en, zh-TW, pt).
export const PROVIDER_LABELS_I18N = Object.freeze({
 en: PROVIDER_LABELS,
 'zh-TW': Object.freeze({local:'僅本機',gdrive:'Drive 快照',icloud:'iCloud 資料夾',dropbox:'Dropbox 資料夾'}),
 pt: Object.freeze({local:'Somente local',gdrive:'Snapshot do Drive',icloud:'Pasta do iCloud',dropbox:'Pasta do Dropbox'}),
});
export function providerLabel(provider,locale='en'){return (PROVIDER_LABELS_I18N[locale]||PROVIDER_LABELS_I18N.en)[provider]||provider;}
export function useSettings(api){
 const service=api.services?.settings;const available=['get','suggestFolders','validate','save'].every(k=>typeof service?.[k]==='function');
 const h=createHook({available,settings:{provider:'local',folder:null,device:'device'},suggestions:{},busy:false,message:'',error:'',theme:'light'});
 async function load(){if(!available)return;try{const [settings,suggestions]=await Promise.all([service.get(),service.suggestFolders()]);h.set({settings:{provider:'local',folder:null,device:'device',...settings},suggestions:suggestions||{},error:''});}catch(e){h.set({error:errText(e)});}}
 function change(patch){h.set({settings:{...h.get().settings,...patch},message:'',error:''});}
 async function execute(op){if(!available)return false;h.set({busy:true,message:'',error:''});try{const s=h.get().settings;const result=await service[op]({...s,folder:s.provider==='local'?null:s.folder});h.set({busy:false,message:result.message|| (result.ok?'Success':'Operation failed'),error:result.ok?'':(result.message||'Operation failed')});return !!result.ok;}catch(e){h.set({busy:false,error:errText(e)});return false;}}
 function setTheme(theme){if(!['light','dark'].includes(theme))return;h.set({theme});try{api.access?.prefs?.set?.('theme',theme);}catch(e){h.set({error:errText(e)});}}
 async function loadTheme(){try{const t=await api.access?.prefs?.get?.('theme');if(t==='dark'||t==='light')h.set({theme:t});}catch{}}
 return {...h,load,change,validate:()=>execute('validate'),save:()=>execute('save'),setTheme,loadTheme};
}
