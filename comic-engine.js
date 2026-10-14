// SPDX-License-Identifier: MIT
import { IMAGE_DEFAULTS, parseImageBlock, buildImageRequest, fetchImage, toBase64 } from './image-api.js';

const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const clone=x=>structuredClone(x);
function safePath(path){const url=new URL(String(path),location.origin);if(url.origin!==location.origin||!/^\/(?:user\/images|user\/files)\//.test(url.pathname))throw new Error('酒馆返回了无效图片路径');return url.pathname+url.search;}
function imageMarkup(items){return items.filter(Boolean).map((item,i)=>{const box=el('div');box.className='n5c-page';box.dataset.mangaOpenPage=String(i);const img=el('img');img.src=safePath(item.url);img.alt='漫画第 '+(i+1)+' 页';box.append(img);return box.outerHTML;}).join('\n');}
export class ComicEngine {
    constructor(director){this.director=director;this.controller=null;this.destroyed=false;this.unbind=[];this.views=new Set();this.autoPending=false;this.state={...IMAGE_DEFAULTS,...director.store.image};this.key='';}
    get busy(){return !!this.controller;}
    save(){this.director.store.image=clone(this.state);this.director.save();}
    parseImageBlock(text){return parseImageBlock(text);}
    directions(){const s=this.state;if(!Number.isInteger(Number(s.pages))||s.pages<1||s.pages>20||!Number.isInteger(Number(s.panels))||s.panels<1||s.panels>6)throw new Error('页数应为 1–20，画格数应为 1–6');return `本次漫画参数：${s.pages} 页，每页约 ${s.panels} 格，${s.color}，对白语言 ${s.language}，阅读顺序 ${s.layout}，${s.whitespace}。风格补充：${s.style||'清楚易读的漫画线条'}。按事件自然分配画格，每页最多六个人物实例，不足以表现正文时优先保留关键动作。`;}
    async init(){
        this.save();
        try{const r=await fetch('/user/files/manga-open-image-connection.json',{cache:'no-store'});if(r.ok){const c=await r.json();if(c.baseUrl===this.state.baseUrl)this.key=String(c.key||'');}}catch{/* Optional saved connection. */}
        const c=this.director.ctx(),event=c.eventTypes?.GENERATION_ENDED||c.eventTypes?.MESSAGE_RECEIVED;
        if(event){const fn=async()=>{if(!this.director.config.auto||this.autoPending||this.busy||this.director.controller||this.destroyed)return;this.autoPending=true;try{await this.director.generate();}catch(error){this.director.setStatus(error.message);}finally{this.autoPending=false;}};c.eventSource.on(event,fn);this.unbind.push(()=>c.eventSource.removeListener(event,fn));}
        const r=await fetch(new URL('./style.css',import.meta.url));if(!r.ok)throw new Error('漫画台样式加载失败');this.css=await r.text();
        this.dialog=el('dialog');this.dialog.className='manga-open-panel';this.dialog.setAttribute('aria-label','漫画台插件版0.1版本');
        const host=el('div'),shadow=host.attachShadow({mode:'open'});this.dialog.append(host);const style=el('style');style.textContent=this.css;shadow.append(style);
        const title=el('header'),heading=el('h2','漫画台插件版0.1版本');title.append(heading,this.button('关闭',()=>this.dialog.close()));shadow.append(title);
        const tabs=el('nav');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','漫画台功能');this.tabs=new Map();
        for(const [key,label]of [['home','控制台'],['director','编剧'],['cast','角色 / 服装'],['options','漫画参数'],['connection','生图连接'],['gallery','图片历史']]){const b=this.button(label,()=>this.switchTab(key));b.setAttribute('role','tab');b.id='manga-tab-'+key;tabs.append(b);this.tabs.set(key,b);}
        shadow.append(tabs);this.pane=el('section');this.pane.setAttribute('role','tabpanel');shadow.append(this.pane);document.body.append(this.dialog);this.switchTab('home');
        this.orb=this.button('漫画台 0.1',()=>this.open());this.orb.className='manga-open-launcher';document.body.append(this.orb);
        return this;
    }
    button(text,action){const b=el('button',text);b.type='button';b.className='n5c-btn';b.onclick=()=>Promise.resolve().then(action).catch(e=>{this.director.setStatus(e.message);window.toastr?.error(e.message,'漫画台');});return b;}
    open(){if(!this.dialog.open)this.dialog.showModal();}
    stop(){this.controller?.abort();this.director.cancel();}
    destroy(){this.destroyed=true;this.stop();for(const fn of this.unbind)fn();for(const view of this.views)view.remove();this.views.clear();this.dialog?.remove();this.orb?.remove();}
    async saveKey(){const value=toBase64(new TextEncoder().encode(JSON.stringify({baseUrl:this.state.baseUrl,key:this.key})));const r=await fetch('/api/files/upload',{method:'POST',headers:this.director.ctx().getRequestHeaders(),body:JSON.stringify({name:'manga-open-image-connection.json',data:value})});if(!r.ok)throw new Error('生图连接保存失败');this.director.setStatus('生图 Key 已保存到当前酒馆用户文件');}
    async renderMessage(id,options={},progress=()=>{}){
        if(this.busy)throw new Error('已有生图任务，等待完成或先中止');
        if(this.destroyed)throw new Error('漫画台已停止');
        const d=this.director,record=d.validRecord(id);if(!record)throw new Error('请先生成有效分镜');
        const blocks=[...record.plan.matchAll(/<image>([\s\S]*?)<\/image>/gi)].map(m=>m[1]);
        if(!blocks.length||blocks.length>20)throw new Error('分镜页数必须在 1–20 范围内');
        if(options.page!=null&&(!Number.isInteger(options.page)||options.page<0||options.page>=blocks.length))throw new Error('页码不存在');
        const config=clone(this.state),key=this.key;const url=config.baseUrl;
        if(!Number.isFinite(Number(config.timeout))||config.timeout<1)throw new Error('生图超时必须大于 0');
        const controller=new AbortController();this.controller=controller;const chatId=d.chatId();
        const current=()=>!controller.signal.aborted&&!this.destroyed&&chatId===d.chatId()&&d.validRecord(id)===record;
        const assertCurrent=()=>{if(!current())throw new DOMException('已取消或聊天 / 正文 / 分镜已变化','AbortError');};
        const result={done:0,skipped:0,failed:0};
        try{
            // Validate all payloads before making a paid request. Snapshot tags for this run.
            const payloads=blocks.map(raw=>buildImageRequest(parseImageBlock(raw),config,d.library));
            for(let page=0;page<blocks.length;page++){
                if(options.page!=null&&page!==options.page)continue;
                if(record.images?.[page]&&!options.force){result.skipped++;continue;}
                assertCurrent();progress({phase:'请求生图',page:page+1});const timeout=setTimeout(()=>controller.abort(),Number(config.timeout)*1000);
                try{
                    const bytes=await fetchImage({...config,baseUrl:url},key,payloads[page],controller.signal);assertCurrent();
                    const upload=await fetch('/api/images/upload',{method:'POST',headers:d.ctx().getRequestHeaders(),body:JSON.stringify({image:toBase64(bytes),format:'png',ch_name:'manga-console-open',filename:crypto.randomUUID()+'.png'}),signal:controller.signal});
                    if(!upload.ok)throw new Error('图片生成成功，但保存到酒馆失败');const image={url:safePath((await upload.json()).path),created:Date.now(),page:page+1,model:config.model,seed:payloads[page].parameters.seed};assertCurrent();
                    // Keep a server-file history even if later chat persistence fails.
                    d.store.gallery=[image,...(d.store.gallery||[])].slice(0,100);d.save();
                    const previous=record.images;const images=[...(previous||[])];images[page]=image;record.images=images;
                    try{await d.writeMessages([{message_id:id,message:record.plan+'\n'+imageMarkup(images)}],{},current);}catch(e){record.images=previous;throw e;}
                    assertCurrent();result.done++;progress({phase:'已保存',page:page+1});
                }catch(error){if(error.name==='AbortError'||controller.signal.aborted)throw error;result.failed++;result.error=error.message;progress({phase:'失败',page:page+1,error:error.message});break;}
                finally{clearTimeout(timeout);}
            }
            return result;
        }catch(error){if(error.name==='AbortError'){result.error='已中止、超时或正文发生变化';return result;}throw error;}
        finally{if(this.controller===controller)this.controller=null;if(this.activeTab==='home')this.switchTab('home');}
    }
    switchTab(key){
        this.activeTab=key;for(const [k,b]of this.tabs)b.setAttribute('aria-selected',String(k===key));this.pane.setAttribute('aria-labelledby','manga-tab-'+key);this.pane.replaceChildren();
        if(key==='director')this.director.mount(this.pane);
        else if(key==='cast')this.director.library.mount(this.pane);
        else if(key==='connection')this.connectionPane();
        else if(key==='options')this.optionsPane();
        else if(key==='gallery')this.galleryPane();
        else this.homePane();
    }
    field(root,title,key,type='text'){
        const label=el('label',title),input=el(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.value=this.state[key];input.onchange=()=>{const v=type==='number'?Number(input.value):input.value;if(type==='number'&&!Number.isFinite(v))return;this.state[key]=v;this.save();};label.append(input);root.append(label);return input;
    }
    status(root){const node=el('p',this.director.log);node.setAttribute('role','status');this.director.statusNodes.add(node);root.append(node);}
    homePane(){
        const root=el('div');root.className='manga-director-form';root.append(el('p','先用正文预设写故事，再让独立编剧生成分镜。编剧与生图分别使用自己的模型连接。'));
        root.append(this.button('正文转漫画并生图',()=>this.director.generate()),this.button('仅生成 / 重编分镜',()=>this.director.plan(this.director.latest(),true)),this.button('重画最新楼层',()=>this.director.generate({force:true})),this.button('中止任务',()=>this.stop()));
        const label=el('label','正文完成后自动编剧并生图（会调用两个 API）'),check=el('input');check.type='checkbox';check.checked=this.director.config.auto;check.onchange=()=>{this.director.config.auto=check.checked;this.director.save();};label.prepend(check);root.append(label);this.status(root);
        try{const id=this.director.latest(),record=this.director.validRecord(id);if(record){const count=[...record.plan.matchAll(/<image>/gi)].length;root.append(el('p',`楼层 #${id}：${count} 页，已生成 ${(record.images||[]).filter(Boolean).length} 页`));for(let i=0;i<count;i++){const row=el('div');row.className='manga-extension-actions';row.append(el('span','第 '+(i+1)+' 页'),this.button('生成 / 重画本页',()=>this.director.generate({page:i,force:true})));if(record.images?.[i])row.append(this.button('查看图片',()=>this.preview(record.images[i])));root.append(row);}}
        }catch{/* No chat selected. */}this.pane.append(root);
    }
    connectionPane(){
        const root=el('div');root.className='manga-director-form';root.append(el('h3','NovelAI 生图连接'),el('p','使用支持 NovelAI /ai/generate-image 协议的接口，模型 ID 可编辑。远程接口须允许浏览器跨域请求。'));
        this.field(root,'生图 API 基础地址','baseUrl');const label=el('label','生图 API Key'),input=el('input');input.type='password';input.autocomplete='off';input.value=this.key;input.oninput=()=>this.key=input.value.trim();label.append(input);root.append(label);
        this.field(root,'生图模型 ID','model');this.field(root,'宽度','width','number');this.field(root,'高度','height','number');this.field(root,'采样步数','steps','number');this.field(root,'CFG','scale','number');this.field(root,'采样器','sampler');this.field(root,'噪声调度','schedule');this.field(root,'种子（-1 随机）','seed','number');this.field(root,'生图超时（秒）','timeout','number');this.field(root,'全局负面 Tag','negative','textarea');
        root.append(this.button('保存生图连接（含 Key）',()=>this.saveKey()),el('p','保存设置不会请求生图。未保存的 Key 仅在本页面内保留；导出不包含 Key。'));this.status(root);this.pane.append(root);
    }
    optionsPane(){
        const root=el('div');root.className='manga-director-form';root.append(el('h3','原创漫画参数'));
        this.field(root,'目标页数（1–20）','pages','number');this.field(root,'每页画格数（1–6）','panels','number');
        for(const [key,title,values]of [['color','色彩',['全彩','黑白']],['whitespace','留白',['正常留白','紧凑排版','宽松留白']]]){const label=el('label',title),select=el('select');for(const v of values)select.append(new Option(v,v));select.value=this.state[key];select.onchange=()=>{this.state[key]=select.value;this.save();};label.append(select);root.append(label);}
        this.field(root,'对白语言','language');this.field(root,'阅读顺序','layout');this.field(root,'画风 Tag / 补充画面要求','style','textarea');root.append(el('p','页数、画格、色彩等由编剧模型执行；重编分镜后生效。已有图片不会自动重画。'));
        this.director.mountEditor(root);this.status(root);this.pane.append(root);
    }
    galleryPane(){
        const root=el('div');root.className='manga-director-form';root.append(el('p','最近 100 张图片索引。图片文件保存在当前酒馆用户的图片目录；刷新后仍可查看。移除记录不会删除服务器文件。'));
        const grid=el('div');grid.className='manga-gallery';for(const item of this.director.store.gallery||[]){try{safePath(item.url);}catch{continue;}const card=el('article'),img=el('img');img.src=item.url;img.alt=`第 ${item.page} 页`;img.loading='lazy';const preview=this.button('查看第 '+item.page+' 页',()=>this.preview(item));preview.setAttribute('aria-label','查看第 '+item.page+' 页');preview.prepend(img);card.append(preview,el('small',new Date(item.created).toLocaleString()),this.button('移除记录',()=>{this.director.store.gallery=this.director.store.gallery.filter(x=>x!==item);this.director.save();this.galleryPaneRefresh();}));grid.append(card);}root.append(grid);this.pane.append(root);
    }
    galleryPaneRefresh(){this.pane.replaceChildren();this.galleryPane();}
    preview(item){
        const path=safePath(item.url),dialog=el('dialog');dialog.className='manga-open-viewer';dialog.setAttribute('aria-label','漫画图片预览');const img=el('img');img.src=path;img.alt='漫画第 '+item.page+' 页';const close=()=>{dialog.close();dialog.remove();this.views.delete(dialog);};const link=el('a','下载原图');link.href=path;link.download='comic-'+item.created+'.png';dialog.append(this.button('关闭预览',close),link,img);dialog.oncancel=e=>{e.preventDefault();close();};document.body.append(dialog);this.views.add(dialog);dialog.showModal();
    }
}
export async function startComicConsole({director}){return new ComicEngine(director).init();}
