import { startComicConsole } from './comic-engine.js';
import { ComicDirector } from './director.js';

const ID = 'st-manga-console';
const REQUIRED = ['getChatMessages', 'setChatMessages'];
let director = null;
let instance = null;
let pending = null;
let status;
let root;
let readinessTimer = null;

function context() { return window.SillyTavern?.getContext?.(); }
function helperFunction(name) {
    const helper = window.TavernHelper;
    if (typeof helper?.[name] === 'function') return helper[name].bind(helper);
    if (typeof window[name] === 'function') return window[name].bind(window);
    return null;
}
export function missingDependencies() {
    const missing = REQUIRED.filter(name => !helperFunction(name));
    if (!context()?.eventSource) missing.unshift('SillyTavern.getContext().eventSource');
    return missing;
}
function createBridge() {
    const ctx = context();
    const bridge = Object.fromEntries(REQUIRED.map(name => [name, (...args) => {
        const fn = helperFunction(name);
        if (!fn) throw new Error(`酒馆助手接口 ${name} 不可用，请更新并启用酒馆助手`);
        return fn(...args);
    }]));
    // Script-scoped helpers cannot be called from a native extension.
    Object.assign(bridge, {
        getPreset: () => director.getPreset(),
        getLoadedPresetName: () => '漫画台独立模块',
        updatePresetWith: (...args) => director.updatePreset(...args),
        replacePreset: (...args) => director.replacePreset(...args),
        getChatMessages: (...args) => director.readMessages(...args),
        setChatMessages: (...args) => director.writeMessages(...args),
        getLastMessageId: () => director.latest(),
        director,
        getScriptId: null, getButtonEvent: null,
        tavern_events: ctx.eventTypes,
        eventOn(event, listener) {
            const activeDirector = director;
            const wrapped = event === ctx.eventTypes.MESSAGE_RECEIVED ? (id) => {
                if (!activeDirector.config.auto) return;
                const msg = context().chat[Number(id)];
                if (!msg || msg.is_user || msg.is_system) return;
                activeDirector.ensurePlan(Number(id)).then(() => activeDirector.engine.renderMessage(Number(id),{})).then(r => activeDirector.setStatus(`自动漫画完成：${r.done||0} 页，失败 ${r.failed||0} 页`)).catch(e => activeDirector.setStatus(e.message));
            } : listener;
            ctx.eventSource.on(event, wrapped);
            return { stop: () => ctx.eventSource.removeListener(event, wrapped) };
        },
    });
    return bridge;
}
function show(message) { if (status) status.textContent = message; }
async function seedSettings() {
    const keys = ['nai5Comic.state.v1.2','nai5Comic.state.v1.0','nai5Comic.state.v8.8','nai5Comic.state.v8.7','nai5Comic.state.v8.6','nai5Comic.state.v8.5','nai5Comic.state.v8.4'];
    if (keys.some(key => localStorage.getItem(key))) return;
    const response = await fetch(new URL('./defaults.json', import.meta.url));
    if (!response.ok) throw new Error('初始配置读取失败');
    localStorage.setItem(keys[0], JSON.stringify(await response.json()));
}
export async function start() {
    if (pending) return pending;
    pending = (async () => {
        if (instance) { instance.open(); return instance; }
        const missing = missingDependencies();
        if (missing.length) {
            show('等待酒馆助手：' + missing.join('、') + '。启用或更新后点击“启动 / 重新检查”。');
            return null;
        }
        await seedSettings();
        director = new ComicDirector(context, helperFunction);
        await director.init();
        instance = await startComicConsole(createBridge());
        director.engine = instance;
        show('已启动通用漫画台。任意正文预设可用；在“编剧”配置独立模型，在“连接”配置生图。');
        return instance;
    })();
    try { return await pending; }
    catch (error) { director?.destroy(); show('启动失败：' + error.message); console.error('[漫画台扩展]', error); return null; }
    finally { pending = null; }
}
function stop() {
    clearInterval(readinessTimer);
    readinessTimer = null;
    instance?.destroy();
    director?.destroy();
    director = null;
    instance = null;
    show('漫画台已停止，当前生成任务已取消。点击启动可恢复。');
}
function mount() {
    const host = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!host || document.getElementById(ID)) return false;
    root = document.createElement('div'); root.id = ID; root.className = 'extension_container';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '漫画台 · 扩展管理';
    const description = document.createElement('p');
    description.textContent = '任意正文预设 → 独立编剧模型 → 漫画生图。漫画规则已内置，不需要切换到漫画预设；需要酒馆助手，数据库联动需要原数据库插件。';
    status = document.createElement('p'); status.setAttribute('role','status');
    const actions = document.createElement('div'); actions.className = 'manga-extension-actions';
    const startButton = document.createElement('button'); startButton.className = 'menu_button'; startButton.textContent = '启动 / 重新检查';
    startButton.onclick = () => start();
    const stopButton = document.createElement('button'); stopButton.className = 'menu_button'; stopButton.textContent = '停止漫画台';
    stopButton.onclick = async () => { if(pending) await pending; stop(); };
    const download = document.createElement('a'); download.className='menu_button'; download.textContent='下载配套预设';
    download.textContent='下载原版配套预设（可选）'; download.href=new URL('./presets/manga-companion.json',import.meta.url).href; download.download='漫画台-插件配套预设.json';
    actions.append(startButton,stopButton,download);
    details.append(summary,description,actions,status); root.append(details); host.append(root);
    return true;
}
async function initialize() {
    if (!mount()) return;
    await start();
    // Extension loading is asynchronous. Retry readiness without executing helper scripts.
    if (!instance) {
        let attempts = 0;
        readinessTimer = setInterval(async () => {
            if (++attempts >= 30 || instance) { clearInterval(readinessTimer); return; }
            if (!missingDependencies().length) { clearInterval(readinessTimer); await start(); }
        },1000);
        window.addEventListener('pagehide',()=>clearInterval(readinessTimer),{once:true});
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true});
else initialize();
