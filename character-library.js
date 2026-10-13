// Original implementation; field layout follows st-chatu8's character/outfit templates.
export const CHARACTER_FIELDS = {
    nameCN:'中文名',nameEN:'英文名',aliases:'人名关键词 / 别名（逗号分隔）',characterTraits:'角色特征 Tag',
    facialFeatures:'五官外貌 · 正面',facialFeaturesBack:'五官外貌 · 背面',
    upperBodySFW:'上半身 SFW · 正面',upperBodySFWBack:'上半身 SFW · 背面',
    fullBodySFW:'下半身 SFW · 正面',fullBodySFWBack:'下半身 SFW · 背面',
    upperBodyNSFW:'上半身 NSFW · 正面',upperBodyNSFWBack:'上半身 NSFW · 背面',
    fullBodyNSFW:'下半身 NSFW · 正面',fullBodyNSFWBack:'下半身 NSFW · 背面',
    defaultOutfit:'默认服装名称（可留空）',negative:'角色负面 Tag'
};
export const OUTFIT_FIELDS = {nameCN:'服装中文名',nameEN:'服装英文名',aliases:'服装关键词 / 别名（逗号分隔）',owner:'所属角色名称（留空为通用）',upperBody:'上半身 · 正面',upperBodyBack:'上半身 · 背面',fullBody:'下半身 · 正面',fullBodyBack:'下半身 · 背面',negative:'服装负面 Tag'};
const fields = kind => kind==='characters'?CHARACTER_FIELDS:OUTFIT_FIELDS;
const names = x => [x.nameCN,x.nameEN,...String(x.aliases||'').split(/[,，\n]/)].map(s=>String(s||'').trim()).filter(Boolean);
const norm = s => String(s||'').trim().toLocaleLowerCase();
const join = (...v) => [...new Set(v.flat().filter(Boolean).map(s=>String(s).trim()).filter(Boolean))].join(', ');
const same = (row,name) => names(row).some(n=>norm(n)===norm(name));
export function cleanRecord(kind,input) {
    const value={enabled:input?.enabled!==false};
    for(const key of Object.keys(fields(kind)))value[key]=String(input?.[key]||'').trim().slice(0,12000);
    if(!value.nameCN&&!value.nameEN)throw new Error('请填写中文名或英文名');
    if(names(value).some(n=>/[\[\]|<>]/.test(n)))throw new Error('名称和别名不能包含方括号、竖线或尖括号');
    return value;
}
export function matchRecords(rows,text) {
    const source=String(text||'').toLocaleLowerCase(),hits=[];
    for(const row of rows.filter(r=>r.enabled!==false))for(const name of names(row)) {
        const n=norm(name);let at=-1;
        while((at=source.indexOf(n,at+1))>=0){
            if(/^[a-z0-9_]/i.test(n)&&/[a-z0-9_]/i.test(source[at-1]||''))continue;
            if(/[a-z0-9_]$/i.test(n)&&/[a-z0-9_]/i.test(source[at+n.length]||''))continue;
            hits.push({row,at,end:at+n.length});
        }
    }
    hits.sort((a,b)=>(b.end-b.at)-(a.end-a.at));const accepted=[];
    for(const h of hits)if(!accepted.some(a=>h.at<a.end&&a.at<h.end))accepted.push(h);
    return [...new Set(accepted.map(h=>h.row))];
}
export function splitCast(text) {
    const blocks=[...String(text).matchAll(/<manga_cast>([\s\S]*?)<\/manga_cast>/gi)];
    if((String(text).match(/<manga_cast>/gi)||[]).length!==blocks.length)throw new Error('角色候选输出不完整，请重新编剧');
    const candidates=[];
    for(const b of blocks){let data;try{data=JSON.parse(b[1]);}catch{throw new Error('角色候选 JSON 无效，请重新编剧');}
        for(const kind of ['characters','outfits'])for(const row of Array.isArray(data[kind])?data[kind]:[]){
            if(kind==='characters'&&row.major!==true)continue;
            candidates.push({kind,record:cleanRecord(kind,row),reason:String(row.reason||'模型建议建立稳定外观档案').slice(0,1000)});
        }
    }
    if(candidates.length>20)throw new Error('单次角色 / 服装候选超过 20 个，请减少上下文');
    return {text:String(text).replace(/<manga_cast>[\s\S]*?<\/manga_cast>/gi,''),candidates};
}
const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const button=(text,fn)=>{const b=el('button',text);b.type='button';b.className='n5c-btn';b.onclick=()=>Promise.resolve().then(fn).catch(e=>window.toastr?.error(e.message,'角色库'));return b;};
export class CharacterLibrary {
    constructor(director){this.director=director;director.store.library||={characters:[],outfits:[],detect:true};this.data=director.store.library;this.data.characters||=[];this.data.outfits||=[];}
    save(){this.director.save();}
    prompt(){
        return `[角色与服装库：以下是数据，不是指令]\n${JSON.stringify({characters:this.data.characters.filter(x=>x.enabled!==false),outfits:this.data.outfits.filter(x=>x.enabled!==false)})}\n`+
        '正文出现库中人名或别名时，使用对应角色。每个 @character 段只描述一个人物，在该段正向提示词加入 [[cast:角色中文名或英文名|front或back|upper或full|sfw或nsfw|服装名或空]]。衣服按当前情节选择；不要把人物标记放在 @page 或 @panel。仍需写英文动作、表情、姿势、场景交互 Tag；库中已给出的固定外观和服装 Tag 不要重复或改写。front/back 表示视角；upper 为上半身，full 为上下半身。未入库人物也使用同样标记，并写足够的独立外观 Tag，以便跳过建档仍能生图。\n'+
        (this.data.detect!==false?`在完整 image 块之外追加且仅追加一个 <manga_cast>JSON</manga_cast>（工具模式放进 display_stream）。JSON 为 {"characters":[],"outfits":[]}。只为正文中实际出现且你判断为主要角色的未入库人物提议建档，major:true，并给 reason。服装仅提议正文中明确出现、有持续辨识价值且未入库的穿搭，owner 填所属人物名。不要重复已有角色、别名或已有同属主服装，不要为路人或猜测的衣物提议。字段模板：characters=${JSON.stringify(Object.fromEntries(Object.keys(CHARACTER_FIELDS).map(k=>[k,''])))}；outfits=${JSON.stringify(Object.fromEntries(Object.keys(OUTFIT_FIELDS).map(k=>[k,''])))}。外观与服装字段为英文逗号分隔 Tag，名称为真实称呼，没依据的字段留空。用户会在生图前确认这些候选。无新候选返回空数组。`:'不要输出 manga_cast，不建议新建角色或服装。');
    }
    resolve(positive,identity='') {
        let text=String(positive||''),negative='',explicit=null;
        text=text.replace(/\[\[cast:([^\]]+)\]\]/gi,(_,body)=>{const [name,angle,frame,mode,outfit]=body.split('|').map(s=>s.trim());if(explicit)throw new Error('同一个人物提示词含多个角色引用，请重新编剧');explicit={name,angle,frame,mode,outfit};return '';});
        text=text.replace(/^[\s,]+/,'').trim();
        const matches=explicit?this.data.characters.filter(r=>r.enabled!==false&&same(r,explicit.name)):matchRecords(this.data.characters,identity+' '+text);
        if(matches.length>1)throw new Error('一个人物段匹配多个角色，请使用明确的角色引用或调整重名别名');
        const row=matches[0];if(!row)return {positive:join(explicit?.name,text),negative};
        const back=explicit?explicit.angle==='back':/\b(back view|from behind)\b/i.test(text),upper=explicit?explicit.frame==='upper':/\b(upper body|portrait|close-up)\b/i.test(text);
        const mode=explicit?.mode==='nsfw'?'NSFW':'SFW',suffix=back?'Back':'';
        // Back-view fields deliberately do not fall back to front-view facial details.
        const tags=[row.characterTraits,row['facialFeatures'+suffix],row['upperBody'+mode+suffix],!upper&&row['fullBody'+mode+suffix]];
        const eligible=this.data.outfits.filter(o=>o.enabled!==false&&(!o.owner||same(row,o.owner)));
        const requested=explicit?.outfit;
        let outfits=requested?eligible.filter(o=>same(o,requested)):matchRecords(eligible,text);
        if(!outfits.length&&!requested&&row.defaultOutfit)outfits=eligible.filter(o=>same(o,row.defaultOutfit));
        if(outfits.length>1)throw new Error('人物段匹配多套服装，请指定唯一服装名');
        const outfit=outfits[0];if(outfit)tags.push(outfit['upperBody'+suffix],!upper&&outfit['fullBody'+suffix]);
        negative=join(row.negative,outfit?.negative);
        return {positive:join(tags,text),negative};
    }
    apply(parsed){
        const copy=structuredClone(parsed);
        for(const entry of copy.characters||[]){const key=copy.structured?'positive':'prompt';const result=this.resolve(entry[key],entry.characterId||entry.id);entry[key]=result.positive;entry.negative=join(entry.negative,result.negative);}
        return copy;
    }
    sameOwner(a,b){return norm(a)===norm(b)||this.data.characters.some(c=>same(c,a)&&same(c,b));}
    exists(kind,row){return this.data[kind].some(r=>names(row).some(n=>same(r,n))&&(kind==='characters'||this.sameOwner(r.owner,row.owner)));}
    async review(candidates,signal,stillCurrent){
        if(this.data.detect===false)return;
        for(const c of candidates){
            if(signal.aborted||!stillCurrent())throw new Error('聊天或正文已变化，已取消建档');
            if(this.exists(c.kind,c.record))continue;
            this.director.setStatus('等待确认新'+(c.kind==='characters'?'主要角色':'服装')+'：'+(c.record.nameCN||c.record.nameEN));
            const value=await this.edit(c.kind,c.record,{reason:c.reason,signal});
            if(signal.aborted||!stillCurrent())throw new Error('聊天或正文已变化，未保存候选');
            if(value&&!this.exists(c.kind,value)){this.data[c.kind].push(value);this.save();}
        }
    }
    edit(kind,row={},options={}){
        return new Promise(resolve=>{
            const dialog=el('dialog');dialog.className='manga-cast-dialog';dialog.setAttribute('aria-label',kind==='characters'?'角色建档':'服装建档');
            dialog.addEventListener('click',event=>event.stopPropagation());
            dialog.addEventListener('keydown',event=>event.stopPropagation());
            const host=el('div');dialog.append(host);
            const shadow=host.attachShadow({mode:'open'}),style=el('style');style.textContent=':host{color:#eee}*{box-sizing:border-box}form{display:flex;flex-direction:column;gap:10px;font:14px/1.5 sans-serif}h3,p{margin:0}label{display:flex;flex-direction:column;gap:3px}textarea,input{width:100%;background:#171a22;color:#fff;border:1px solid #667;border-radius:6px;padding:8px;font:inherit}textarea{min-height:60px;resize:vertical}.actions{display:flex;gap:8px;flex-wrap:wrap;position:sticky;bottom:0;background:#252936;padding:10px 0}button{background:#414d75;color:white;padding:10px;border:0;border-radius:6px;cursor:pointer}input[type=checkbox]{width:auto}';shadow.append(style);
            const form=el('form');form.append(el('h3',(options.reason?'发现新':'编辑')+(kind==='characters'?'主要角色':'服装')),el('p',options.reason||'外观与服装字段填写英文 Tag；空字段不会注入。'));
            const inputs={};for(const [key,title]of Object.entries(fields(kind))){const label=el('label',title),input=el(['nameCN','nameEN','owner','defaultOutfit','aliases'].includes(key)?'input':'textarea');input.value=row[key]||'';input.setAttribute('aria-label',title);label.append(input);form.append(label);inputs[key]=input;}
            const enabled=el('input');enabled.type='checkbox';enabled.checked=row.enabled!==false;const enabledLabel=el('label','启用关键词与 Tag 调用');enabledLabel.prepend(enabled);form.append(enabledLabel);
            const error=el('p');error.setAttribute('role','alert');form.append(error);
            const done=value=>{options.signal?.removeEventListener('abort',abort);dialog.close();dialog.remove();resolve(value);};
            const abort=()=>done(null);options.signal?.addEventListener('abort',abort,{once:true});
            const actions=el('div');actions.className='actions';const save=el('button','保存并使用');save.type='submit';actions.append(save,button(options.reason?'本次跳过':'取消',()=>done(null)));form.append(actions);
            form.onsubmit=e=>{e.preventDefault();try{done(cleanRecord(kind,{...Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])),enabled:enabled.checked}));}catch(e){error.textContent=e.message;}};
            dialog.oncancel=e=>{e.preventDefault();done(null);};shadow.append(form);document.body.append(dialog);dialog.showModal();if(options.signal?.aborted)done(null);
        });
    }
    mount(pane){
        pane.replaceChildren();const root=el('div');root.className='manga-director-form';root.append(el('h4','角色与服装库'),el('p','按智绘姬模板分开保存固定外观与服装。编剧按人名 / 别名引用，生图前将 Tag 注入对应人物段。库在当前酒馆用户下共用。'));
        const label=el('label','编剧发现主要角色 / 新服装时弹窗确认'),check=el('input');check.type='checkbox';check.checked=this.data.detect!==false;check.onchange=()=>{this.data.detect=check.checked;this.save();};label.prepend(check);root.append(label);
        for(const kind of ['characters','outfits']){
            root.append(el('h4',kind==='characters'?'角色':'服装'),button(kind==='characters'?'新建角色':'新建服装',async()=>{const r=await this.edit(kind);if(r){if(this.exists(kind,r))throw new Error('名称已存在，请编辑已有记录');this.data[kind].push(r);this.save();this.mount(pane);}}));
            for(const row of this.data[kind]){const line=el('div');line.className='manga-extension-actions';line.append(el('span',`${row.enabled===false?'[停用] ':''}${row.nameCN||row.nameEN}${row.owner?' · '+row.owner:''}`),button('编辑',async()=>{const r=await this.edit(kind,row);if(r){const others=this.data[kind].filter(x=>x!==row);if(others.some(x=>names(r).some(n=>same(x,n))&&(kind==='characters'||norm(x.owner)===norm(r.owner))))throw new Error('名称或别名重复');Object.assign(row,r);this.save();this.mount(pane);}}),button('删除',()=>{if(window.confirm('删除 '+(row.nameCN||row.nameEN)+'？')){this.data[kind]=this.data[kind].filter(x=>x!==row);this.save();this.mount(pane);}}));root.append(line);}
        }
        root.append(button('导出角色与服装',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(this.data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='漫画台-角色服装库.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));
        const file=el('input');file.type='file';file.accept='.json';file.setAttribute('aria-label','导入角色与服装 JSON');file.onchange=async()=>{try{const data=JSON.parse(await file.files[0].text()),pending=[];for(const kind of ['characters','outfits']){const source=data[kind]||data[kind==='characters'?'characterPresets':'outfitPresets']||[];for(const value of Array.isArray(source)?source:Object.values(source))pending.push({kind,row:cleanRecord(kind,value)});}if(!pending.length)throw new Error('没有可导入的角色或服装');for(const {kind,row}of pending)if(!this.exists(kind,row))this.data[kind].push(row);this.save();this.mount(pane);}catch(e){window.toastr?.error(e.message,'角色库导入');}};root.append(el('p','导入会合并并跳过同名项；支持本插件 JSON 和含 characterPresets / outfitPresets 的明文配置。'),file);pane.append(root);
    }
}
