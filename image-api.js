// SPDX-License-Identifier: MIT
// Original parser and transport implementation; no preset engine code is bundled.
export const IMAGE_DEFAULTS={baseUrl:'https://image.novelai.net',model:'nai-diffusion-4-5-full',width:832,height:1216,steps:28,scale:5,sampler:'k_euler_ancestral',schedule:'karras',seed:-1,timeout:180,negative:'lowres, blurry, bad anatomy',style:'',pages:2,panels:3,color:'全彩',language:'中文',layout:'从左到右，从上到下',whitespace:'正常留白'};
export function parseImageBlock(raw){
    try{
        const result={ok:true,structured:true,positionMode:'auto',base:{prompt:''},characters:[],panels:[]};
        let seenPage=false,panel=null,character=null,write=null;
        for(const line of String(raw).trim().split(/\r?\n/)){
            const marker=/^\s*@(position|page|panel|character|negative|center|non_character)\b\s*(.*?)\s*$/.exec(line);
            if(!marker){if(line.trim()){if(!write)throw new Error('文本缺少所属标记');write(line.trim());}continue;}
            const [,type,value]=marker;write=null;
            if(type==='position'){if(seenPage||!['auto','manual'].includes(value))throw new Error('position 应在 page 前写 auto 或 manual');result.positionMode=value;}
            if(type==='page'){if(seenPage||value)throw new Error('每页只能有一个独占行 @page');seenPage=true;write=s=>result.base.prompt+=(result.base.prompt?'\n':'')+s;}
            if(type==='panel'){if(!seenPage||!value||/\s/.test(value))throw new Error('panel 需要一个无空格编号');if(result.panels.some(p=>p.id===value))throw new Error('画格编号重复');panel={id:value,prompt:''};result.panels.push(panel);character=null;write=s=>panel.prompt+=(panel.prompt?'\n':'')+s;}
            if(type==='character'){if(!panel||!value||/\s/.test(value))throw new Error('character 必须在画格内并填写无空格编号');character={id:panel.id+'-'+result.characters.length,characterId:value,panel:panel.id,positive:'',negative:'',center:null};result.characters.push(character);write=s=>character.positive+=(character.positive?'\n':'')+s;}
            if(type==='negative'){if(!character||value)throw new Error('negative 只能跟随人物且独占一行');write=s=>character.negative+=(character.negative?'\n':'')+s;}
            if(type==='center'){if(!character||result.positionMode!=='manual')throw new Error('center 仅用于手动定位人物');const pair=value.split(',').map(s=>s.trim());if(pair.length!==2||pair.some(s=>!s||!Number.isFinite(Number(s))||Number(s)<0||Number(s)>1))throw new Error('center 必须是 0 至 1 的 x,y');character.center={x:Number(pair[0]),y:Number(pair[1])};}
            if(type==='non_character'){if(!seenPage||value)throw new Error('non_character 必须独占一行');const object=panel||result.base;const key=panel?'prompt':'prompt';character=null;write=s=>object[key]+='\n'+s;}
        }
        if(!seenPage||!result.base.prompt||!result.panels.length)throw new Error('缺少页面描述或画格');
        if(result.characters.length>6)throw new Error('每页最多六个人物实例，请减少画格或拆页');
        for(const entry of result.characters){if(!entry.positive)throw new Error('人物提示词为空');if(result.positionMode==='manual'&&!entry.center)throw new Error('手动定位人物缺少 center');entry.center||={x:.5,y:.5};}
        result.base.prompt=[result.base.prompt,...result.panels.map(p=>`[${p.id}] ${p.prompt}`)].join(', ');
        return result;
    }catch(error){return {ok:false,reason:error.message};}
}
export function imageEndpoint(base){
    const u=new URL(String(base).trim());
    if(u.username||u.password||u.search||u.hash)throw new Error('生图地址不要包含认证、查询或片段');
    if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw new Error('远程生图接口须使用 HTTPS');
    u.pathname=u.pathname.replace(/\/+$/,'').replace(/\/ai\/generate-image$/,'')+'/ai/generate-image';return u.href;
}
export function buildImageRequest(parsed,config,library){
    if(!parsed.ok)throw new Error(parsed.reason);
    const c={...IMAGE_DEFAULTS,...config};
    for(const k of ['width','height'])if(!Number.isInteger(Number(c[k]))||c[k]<64||c[k]>2048||c[k]%64)throw new Error('图片宽高须为 64 的倍数，范围 64–2048');
    if(c.width*c.height>3145728)throw new Error('图片总像素不能超过 3145728');
    if(!Number.isInteger(Number(c.steps))||c.steps<1||c.steps>50)throw new Error('步数范围为 1–50');
    if(!Number.isFinite(Number(c.scale))||c.scale<0||c.scale>20)throw new Error('CFG 范围为 0–20');
    if(!Number.isInteger(Number(c.seed))||c.seed< -1||c.seed>4294967295)throw new Error('种子须为 -1 或 0–4294967295 的整数');
    if(!String(c.model).trim())throw new Error('请填写生图模型 ID');
    const data=library?library.apply(parsed):structuredClone(parsed);
    const prompt=[c.style,data.base.prompt].filter(Boolean).join(', '),coords=data.positionMode==='manual';
    const seed=Number(c.seed)<0?crypto.getRandomValues(new Uint32Array(1))[0]:Number(c.seed);
    const captions=data.characters.map(e=>({char_caption:e.positive,centers:[e.center]}));
    const negatives=data.characters.map(e=>({char_caption:e.negative||'',centers:[e.center]}));
    return {input:prompt,model:String(c.model).trim(),action:'generate',parameters:{params_version:3,width:Number(c.width),height:Number(c.height),steps:Number(c.steps),scale:Number(c.scale),seed,sampler:c.sampler,noise_schedule:c.schedule,n_samples:1,negative_prompt:c.negative,qualityToggle:false,ucPreset:0,sm:false,sm_dyn:false,dynamic_thresholding:false,legacy:false,legacy_v3_extend:false,add_original_image:false,uncond_scale:1,use_coords:coords,characterPrompts:data.characters.map(e=>({prompt:e.positive,uc:e.negative||'',center:e.center,enabled:true})),v4_prompt:{caption:{base_caption:prompt,char_captions:captions},use_coords:coords,use_order:true},v4_negative_prompt:{caption:{base_caption:c.negative,char_captions:negatives}},reference_image_multiple:[],reference_information_extracted_multiple:[],reference_strength_multiple:[]}};
}
const pngMagic=[137,80,78,71,13,10,26,10];
export function isPng(bytes){return pngMagic.every((b,i)=>bytes[i]===b);}
export function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
// Read one PNG from ZIP using its central directory (including data-descriptor archives).
export async function extractPng(buffer){
    const bytes=new Uint8Array(buffer);if(bytes.length>64*1024*1024)throw new Error('图片响应超过 64 MB');if(isPng(bytes))return bytes;
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
    if(end<0)throw new Error('接口没有返回 PNG 或 ZIP');
    if(view.getUint16(end+4,true)||view.getUint16(end+6,true))throw new Error('不支持分卷 ZIP');
    const count=view.getUint16(end+10,true);let at=view.getUint32(end+16,true);
    for(let i=0;i<count;i++){
        if(at+46>bytes.length||view.getUint32(at,true)!==0x02014b50)throw new Error('ZIP 目录损坏');
        const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),crc=view.getUint32(at+16,true),size=view.getUint32(at+20,true),unpacked=view.getUint32(at+24,true),len=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true),local=view.getUint32(at+42,true);
        const name=new TextDecoder().decode(bytes.subarray(at+46,at+46+len));at+=46+len+extra+comment;
        if(!name.toLowerCase().endsWith('.png'))continue;
        if(flags&1||unpacked>32*1024*1024)throw new Error('加密 ZIP 或图片解压大小超限');
        if(local+30>bytes.length||view.getUint32(local,true)!==0x04034b50)throw new Error('ZIP 图片记录损坏');
        const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
        if(start+size>bytes.length)throw new Error('ZIP 图片被截断');
        let image=bytes.slice(start,start+size);
        if(method===8){const reader=new Blob([image]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks=[];let total=0;try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>unpacked||total>32*1024*1024)throw new Error('ZIP 解压数据超限');chunks.push(value);}}finally{await reader.cancel();}image=new Uint8Array(total);let offset=0;for(const part of chunks){image.set(part,offset);offset+=part.length;}}
        else if(method!==0)throw new Error('不支持的 ZIP 压缩方式');
        if(image.length!==unpacked||crc32(image)!==crc||!isPng(image))throw new Error('ZIP 图片校验失败');return image;
    }
    throw new Error('ZIP 中没有 PNG');
}
export function toBase64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export async function fetchImage(config,key,payload,signal){
    if(!key.trim())throw new Error('请在生图连接中填写 API Key');
    const response=await fetch(imageEndpoint(config.baseUrl),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key.trim()},body:JSON.stringify(payload),signal});
    if(!response.ok)throw new Error(`生图 HTTP ${response.status}；检查地址、模型、额度及浏览器跨域支持`);
    const bytes=await extractPng(await response.arrayBuffer());if(signal.aborted)throw new DOMException('已中止','AbortError');return bytes;
}
