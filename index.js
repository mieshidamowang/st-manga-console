// SPDX-License-Identifier: MIT
import { ComicDirector } from './director.js';
import { startComicConsole } from './comic-engine.js';
let instance, director, starting, timer, status, stopped=false;
const ctx=()=>window.SillyTavern?.getContext?.();
function helper(name){const owner=window.TavernHelper;if(typeof owner?.[name]==='function')return owner[name].bind(owner);return typeof window[name]==='function'?window[name].bind(window):null;}
export function nativeChatAdapter(getContext=ctx){return name=>{
 if(name==='getChatMessages')return async id=>{const chat=getContext().chat;const ids=id==null?chat.map((_,i)=>i):[Number(id)];return ids.filter(i=>chat[i]).map(i=>({message_id:i,message:chat[i].mes,role:chat[i].is_user?'user':'assistant'}));};
 if(name==='setChatMessages')return async rows=>{
  const context=getContext(),chat=context.chat,chatId=context.getCurrentChatId();
  const backups=rows.map(r=>({id:r.message_id,mes:chat[r.message_id]?.mes,swipes:structuredClone(chat[r.message_id]?.swipes)}));
  if(rows.some(r=>!chat[r.message_id]||chat[r.message_id].is_user))throw new Error('目标模型消息不存在');
  try{for(const row of rows){const m=chat[row.message_id];m.mes=row.message;if(Array.isArray(m.swipes)&&Number.isInteger(m.swipe_id))m.swipes[m.swipe_id]=row.message;}await context.saveChat();if(getContext().chat===chat&&getContext().getCurrentChatId()===chatId)for(const row of rows)context.updateMessageBlock?.(row.message_id,chat[row.message_id]);}
  catch(error){for(const old of backups){chat[old.id].mes=old.mes;if(old.swipes)chat[old.id].swipes=old.swipes;}throw error;}
 };
 return helper(name);
};}
const show=text=>{if(status)status.textContent=text;};
export async function start(){
 if(starting)return starting;if(instance){instance.open();return instance;}stopped=false;
 starting=(async()=>{const c=ctx();if(!c?.eventSource||!c.saveChat||!c.getCurrentChatId){show('等待酒馆初始化，或请更新到支持 getContext 的版本。');return;}director=new ComicDirector(ctx,nativeChatAdapter());await director.init();instance=await startComicConsole({director});director.engine=instance;show('漫画台开源版已启动。先配置编剧与生图连接，再打开聊天进行漫画生成。');return instance;})();
 try{return await starting;}catch(error){director?.destroy();director=null;show('启动失败：'+error.message);console.error('[manga-console]',error);}finally{starting=null;}
}
export async function stop(){stopped=true;clearInterval(timer);if(starting)await starting;instance?.destroy();instance=null;director?.destroy();director=null;show('已停止，可点击启动恢复。');}
function mount(){const host=document.querySelector('#extensions_settings2, #extensions_settings');if(!host)return false;if(document.getElementById('st-manga-console-open'))return true;const root=document.createElement('details');root.id='st-manga-console-open';root.className='manga-extension';const title=document.createElement('summary');title.textContent='漫画台插件版0.1版本';status=document.createElement('p');status.setAttribute('role','status');root.append(title,status);for(const [name,action]of [['打开漫画台',start],['停止漫画台',stop]]){const b=document.createElement('button');b.className='menu_button';b.textContent=name;b.onclick=()=>action();root.append(b);}host.append(root);return true;}
function initialize(){let attempts=0;const attempt=async()=>{if(stopped||++attempts>60){clearInterval(timer);return;}if(mount()&&ctx()?.saveChat){await start();if(instance)clearInterval(timer);}};timer=setInterval(attempt,1000);attempt();window.addEventListener('pagehide',()=>{stop();},{once:true});}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();}
