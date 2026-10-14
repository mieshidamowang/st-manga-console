// Migrated from the user-provided 1111 preset; original core retained.
export async function startComicConsole(hostApi = {}) {
  // ES modules run in strict mode.

  /* ============================================================
   * 漫画台
   *
   * 三层分工：
   *   shujuku     → 剧情资料、角色档案与两阶段检索推进
   *   预设        → 页面详情、角色锚点、分格描述与 Text 块
   *   本脚本      → 管理配套资产、追加画风与负面词、调 NovelAI V5
   * ============================================================ */

  var APP_ID = "nai5-comic-console";
  var STYLE_ID = APP_ID + "-style";
  var STORAGE_KEY = "nai5Comic.state.v1.2";
  var INHERITED_STORAGE_KEY = "nai5Comic.state.v1.0";
  var CONNECTION_FILE = "manga-console_nai_configs.json";
  // 只读继承旧版设置；所有写入只使用当前预设命名空间。
  var PREVIOUS_STORAGE_KEY = "nai5Comic.state.v8.8";
  var LEGACY_STORAGE_KEY = "nai5Comic.state.v8.7";
  var OLDER_STORAGE_KEY = "nai5Comic.state.v8.6";
  var OLDEST_STORAGE_KEY = "nai5Comic.state.v8.5";
  var ANCIENT_STORAGE_KEY = "nai5Comic.state.v8.4";
  var VERSION = "2.1.0";
  var LOG = "[漫画台]";
  var REROLL_PRESET_NAME = "漫画台 v1.3.1";

  /* shujuku 表名与列名；仅内嵌角色模板更名，不导入已安装表。 */
  var TABLE_CHRONICLE = "纪要表";
  var TABLE_CHARACTER = "角色DNA表";
  var TABLE_ITEM = "物品提示词表";
  var TABLE_SCENE = "场景提示词表";
  var TABLE_NPC = "重要角色表";
  var TABLE_HERO = "主角信息表";
  var COL_NAME = "姓名";
  var COL_POS = "NAI外观提示词";
  var COL_NEG = "NAI负面提示词";

  /* ------------------------------------------------------------
   * 负面提示词守卫
   *
   * NovelAI 内置的 UC 预设一律不可用于分格漫画。V5 的 heavy 档含
   * screentone / halftone / dithering / multiple views，这四个正是
   * 网点纸、半调、多视图分格的构成要素；furryFocus 档更直接含
   * comic 与 multiple scenes。任何一档都会把分镜和网点压掉。
   *
   * 预设里的负面词库已经剔除过这些词，但用户临时追加的仍要过一遍。
   * ---------------------------------------------------------- */

  function sanitizeNegative(raw) {
    return { value: String(raw || "").trim(), dropped: [] };
  }

  /* ------------------------------------------------------------
   * NAI 参数
   * V5 不支持 skip_cfg_above_sigma，ddim_v3 采样器也已移除。
   * ---------------------------------------------------------- */
  var NAI_DEFAULTS = {
    model: "nai-diffusion-5-full",
    width: 832,
    height: 1216,
    scale: 4.7,
    sampler: "k_euler",
    noise_schedule: "karras",
    steps: 28,
    cfg_rescale: 0.25,
  };

  var NAI_MODELS = [
    { id: "nai-diffusion-5-full", label: "nai-diffusion-5-full" },
  ];

  var NAI_SAMPLERS = ["k_euler", "k_euler_ancestral", "k_dpmpp_2s_ancestral", "k_dpmpp_2m_sde", "k_dpmpp_2m", "k_dpmpp_sde"];
  var NAI_DROPPED_SAMPLERS = ["ddim_v3", "ddim"];

  /* Opus 对 V5 的免费额度按像素数计费，1024x1024 是分界线 */
  var NAI_SIZES = [
  {
    "group": "标准",
    "w": 832,
    "h": 1216,
    "label": "竖图（832×1216）"
  },
  {
    "group": "标准",
    "w": 1216,
    "h": 832,
    "label": "横图（1216×832）"
  },
  {
    "group": "标准",
    "w": 1024,
    "h": 1024,
    "label": "方图（1024×1024）"
  },
  {
    "group": "大图",
    "w": 1024,
    "h": 1536,
    "label": "竖图（1024×1536）"
  },
  {
    "group": "大图",
    "w": 1536,
    "h": 1024,
    "label": "横图（1536×1024）"
  },
  {
    "group": "大图",
    "w": 1472,
    "h": 1472,
    "label": "方图（1472×1472）"
  },
  {
    "group": "宽图",
    "w": 1088,
    "h": 1920,
    "label": "竖图（1088×1920）"
  },
  {
    "group": "宽图",
    "w": 1920,
    "h": 1088,
    "label": "横图（1920×1088）"
  },
  {
    "group": "小图",
    "w": 512,
    "h": 768,
    "label": "竖图（512×768）"
  },
  {
    "group": "小图",
    "w": 768,
    "h": 512,
    "label": "横图（768×512）"
  },
  {
    "group": "小图",
    "w": 640,
    "h": 640,
    "label": "方图（640×640）"
  }
];

  function isValidImageSize(w, h) {
    return [Number(w), Number(h)].every(function (n) { return Number.isInteger(n) && n >= 64 && n <= 2048 && n % 64 === 0; });
  }

  function isFreeSize(w, h) {
    return Number(w) * Number(h) <= 1024 * 1024;
  }

  var IMAGE_BLOCK_RE = /<image>([\s\S]*?)<\/image>/gi;
  var PAGE_BOX_RE = /<div class="(?:custom-)?n5c-page"[\s\S]*?<\/div>/gi;

  /* ------------------------------------------------------------
   * 运行期状态
   * ---------------------------------------------------------- */
  var state = {
    naiToken: "",
    channel: "official",
    customUrl: "",
    model: NAI_DEFAULTS.model,
    width: NAI_DEFAULTS.width,
    height: NAI_DEFAULTS.height,
    sizeMode: "",
    scale: NAI_DEFAULTS.scale,
    sampler: NAI_DEFAULTS.sampler,
    steps: NAI_DEFAULTS.steps,
    /* 三类库都在预设里，这里只存选中块的 identifier */
    styleId: "",
    positiveId: "",
    negativeId: "",
    cfgRescale: NAI_DEFAULTS.cfg_rescale,
    seed: "",
    noiseSchedule: "karras",
    variety: false,
    connectionProfiles: [],
    activeConnectionId: "",
    accountRotationEnabled: false,
    schemaVersion: 3,
    categoryFilter: "",
    enableLog: true,
    logCollapsed: false,
    autoGenerate: true,
    orbPos: null,
    panelPos: null,
    hideOrb: false,
    mergeScope: "chat",
    mergeKeepData: true,
    concurrency: 1,
  };

  var lifecycle = { destroyed: false, unbinds: [] };

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG);
    try { console.log.apply(console, args); } catch (e) {}
  }

  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(LOG);
    try { console.warn.apply(console, args); } catch (e) {}
  }

  /* ------------------------------------------------------------
   * 宿主环境
   * 脚本跑在酒馆助手 iframe 内，宿主对象挂在 window.parent 上。
   * ---------------------------------------------------------- */
  var Env = (function () {
    var pwin = window;
    var pdoc = document;
    try {
      if (window.parent && window.parent !== window && window.parent.document) {
        pwin = window.parent;
        pdoc = window.parent.document;
      }
    } catch (e) {}
    return { win: window, pwin: pwin, pdoc: pdoc };
  })();

  function toast(msg, kind) {
    try {
      var tr = Env.pwin.toastr || window.toastr;
      if (tr && typeof tr[kind || "info"] === "function") {
        tr[kind || "info"](msg, "漫画台");
        return;
      }
    } catch (e) {}
    log(msg);
  }

  function getApi(name) {
    if (Object.prototype.hasOwnProperty.call(hostApi, name)) {
      return { value: hostApi[name], owner: hostApi, source: "extension" };
    }
    var sources = [
      { label: "iframe", object: window },
      { label: "parent", object: Env.pwin },
      { label: "iframe.TavernHelper", object: window.TavernHelper },
      { label: "parent.TavernHelper", object: Env.pwin.TavernHelper },
    ];
    for (var i = 0; i < sources.length; i++) {
      try {
        var src = sources[i];
        if (src.object && typeof src.object[name] !== "undefined") {
          return { value: src.object[name], owner: src.object, source: src.label };
        }
      } catch (e) {}
    }
    return null;
  }

  /* 取到的函数要绑回宿主对象，否则内部 this 会丢 */
  function getBoundFunction(name) {
    var api = getApi(name);
    if (!api || typeof api.value !== "function") return null;
    return { fn: api.value.bind(api.owner), source: api.source };
  }

  function stContext() {
    try {
      var st = getApi("SillyTavern");
      return st && st.value && typeof st.value.getContext === "function" ? st.value.getContext() : null;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------
   * 状态持久化
   * API 连接含 Key 存在酒馆用户文件；普通设置仍使用本地存储/脚本变量。
   * Key 不进聊天变量，旧本地数据仅用于首次迁移。
   * ---------------------------------------------------------- */
  var LOCAL_KEYS = ["naiToken", "channel", "customUrl", "orbPos", "connectionProfiles", "activeConnectionId", "accountRotationEnabled"];
  function bounded(value, min, max, fallback, digits) {
    var n = Number(value);
    if (value == null || value === "" || !Number.isFinite(n)) n = fallback;
    return Number(Math.max(min, Math.min(max, n)).toFixed(digits));
  }
  function normalizeState() {
    state.steps = bounded(state.steps, 1, 50, 28, 0);
    state.scale = bounded(state.scale, 0, 10, 4.7, 1);
    state.cfgRescale = bounded(state.cfgRescale, 0, 1, 0.25, 2);
    state.model = NAI_DEFAULTS.model;
    if (NAI_SAMPLERS.indexOf(state.sampler) < 0) state.sampler = NAI_DEFAULTS.sampler;
    if (!isValidImageSize(state.width, state.height)) {
      state.width = NAI_DEFAULTS.width; state.height = NAI_DEFAULTS.height;
    } else {
      state.width = Number(state.width); state.height = Number(state.height);
    }
    if (state.sizeMode !== "custom" && state.sizeMode !== "preset") {
      state.sizeMode = NAI_SIZES.some(function (x) { return x.w === state.width && x.h === state.height; }) ? "preset" : "custom";
    }
    if (["karras", "exponential", "polyexponential"].indexOf(state.noiseSchedule) < 0) state.noiseSchedule = "karras";
    if (state.seed !== "" && (!/^\d+$/.test(String(state.seed)) || Number(state.seed) > 4294967295)) state.seed = "";
    var c = Number(state.concurrency);
    if (c === -1) state.concurrency = -1;
    else state.concurrency = Math.max(1, isNaN(c) ? 1 : Math.floor(c));
    state.categoryFilter = String(state.categoryFilter || "");
    if (state.enableLog === undefined) state.enableLog = true;
    state.logCollapsed = !!state.logCollapsed; state.schemaVersion = 3;
    if (state.mergeScope !== "global" && state.mergeScope !== "chat") state.mergeScope = "chat";
    if (state.mergeKeepData === undefined) state.mergeKeepData = true;
    else state.mergeKeepData = !!state.mergeKeepData;
    state.accountRotationEnabled = !!state.accountRotationEnabled;
  }
  var Store = {
    scopeOption: function () {
      var getId = getBoundFunction("getScriptId");
      try { return getId ? { type: "script", script_id: getId.fn() } : null; } catch (e) { return null; }
    },
    load: function () {
      // Remove legacy browser credential copies; connections now live in the user file.
      [STORAGE_KEY,INHERITED_STORAGE_KEY,PREVIOUS_STORAGE_KEY,LEGACY_STORAGE_KEY,OLDER_STORAGE_KEY,OLDEST_STORAGE_KEY,ANCIENT_STORAGE_KEY].forEach(function(key){
        try { var old=JSON.parse(Env.pwin.localStorage.getItem(key)||'null');if(!old)return;
          ['naiToken','connectionProfiles','activeConnectionId','customUrl'].forEach(function(k){delete old[k];});
          if(old.styleId==='f4ab343e-9fea-4571-a1ee-23eca9c484d3')old.styleId='';
          Env.pwin.localStorage.setItem(key,JSON.stringify(old));
        } catch(error) {}
      });
      var local = {}, remote = {};
      try { local = JSON.parse(Env.pwin.localStorage.getItem(STORAGE_KEY) || Env.pwin.localStorage.getItem(INHERITED_STORAGE_KEY) || Env.pwin.localStorage.getItem(PREVIOUS_STORAGE_KEY) || Env.pwin.localStorage.getItem(LEGACY_STORAGE_KEY) || Env.pwin.localStorage.getItem(OLDER_STORAGE_KEY) || Env.pwin.localStorage.getItem(OLDEST_STORAGE_KEY) || Env.pwin.localStorage.getItem(ANCIENT_STORAGE_KEY) || "{}") || {}; } catch (e) {}
      var opt = this.scopeOption(), getVars = getBoundFunction("getVariables");
      try { if (opt && getVars) { var vars = getVars.fn(opt) || {}; remote = vars[STORAGE_KEY] || vars[INHERITED_STORAGE_KEY] || vars[PREVIOUS_STORAGE_KEY] || vars[LEGACY_STORAGE_KEY] || vars[OLDER_STORAGE_KEY] || vars[OLDEST_STORAGE_KEY] || vars[ANCIENT_STORAGE_KEY] || {}; } } catch (e) {}
      Object.keys(state).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(local, key)) state[key] = local[key];
        else if (LOCAL_KEYS.indexOf(key) < 0 && Object.prototype.hasOwnProperty.call(remote, key)) state[key] = remote[key];
      });
      state.connectionProfiles = (Array.isArray(state.connectionProfiles) ? state.connectionProfiles : []).filter(function (p) {
        return p && typeof p.id === "string" && typeof p.name === "string";
      }).map(function (p) { return { id: p.id, name: p.name, channel: p.channel === "mirror" ? "mirror" : "official", customUrl: String(p.customUrl || ""), naiToken: String(p.naiToken || "").trim() }; });
      if (!state.connectionProfiles.length && (state.naiToken || state.customUrl)) {
        state.connectionProfiles.push({ id: "legacy", name: "原有连接", channel: state.channel, customUrl: state.customUrl, naiToken: state.naiToken });
        state.activeConnectionId = "legacy";
      }
      var active = state.connectionProfiles.find(function (p) { return p.id === state.activeConnectionId; });
      if (active) { state.channel = active.channel; state.customUrl = active.customUrl; state.naiToken = active.naiToken; }
      else { state.activeConnectionId = ""; state.channel = "official"; state.customUrl = ""; state.naiToken = ""; }
      normalizeState();
    },
    save: function () {
      var saved = true, local = {};
      Object.keys(state).forEach(function (key) {
        if (["naiToken", "channel", "customUrl", "connectionProfiles", "activeConnectionId", "accountRotationEnabled"].indexOf(key) < 0) local[key] = state[key];
      });
      // 迁移未落盘时不可覆盖仍含旧 Key 的本地记录。
      if (!ConnectionStore.serverPersisted && state.connectionProfiles.length) {
        saved = false;
      } else {
        try { Env.pwin.localStorage.setItem(STORAGE_KEY, JSON.stringify(local)); }
        catch (e) { saved = false; setStatus("普通设置本机存储写入失败，仅在本次运行生效", "error"); }
      }
      var opt = this.scopeOption(), assign = getBoundFunction("insertOrAssignVariables");
      if (opt && assign) {
        var shared = {}, payload = {};
        Object.keys(state).forEach(function (key) { if (LOCAL_KEYS.indexOf(key) < 0) shared[key] = state[key]; });
        payload[STORAGE_KEY] = shared;
        try { assign.fn(payload, opt); } catch (e) { warn("普通配置同步失败"); }
      }
      return saved;
    }
  };

  function connectionSnapshot() {
    return {
      schemaVersion: 1,
      privacyReset20261014: true,
      connectionProfiles: state.connectionProfiles.map(function (p) {
        return Object.assign({ id: p.id, name: p.name }, connectionFields(p));
      }),
      activeConnectionId: state.activeConnectionId,
      accountRotationEnabled: !!state.accountRotationEnabled
    };
  }
  function validateConnectionFile(data) {
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.connectionProfiles)
      || typeof data.activeConnectionId !== "string" || typeof data.accountRotationEnabled !== "boolean"
      || !data.connectionProfiles.every(function (p) {
        return p && typeof p.id === "string" && p.id && typeof p.name === "string" && p.name
          && (p.channel === "official" || p.channel === "mirror")
          && typeof p.customUrl === "string" && typeof p.naiToken === "string";
      })) throw new Error("连接配置文件格式无效，已停止写入以免覆盖原数据");
    return data;
  }
  function commitConnections(data) {
    state.connectionProfiles = data.connectionProfiles;
    state.activeConnectionId = data.activeConnectionId;
    state.accountRotationEnabled = data.accountRotationEnabled;
    var active = state.connectionProfiles.find(function (p) { return p.id === state.activeConnectionId; });
    if (!active) state.activeConnectionId = "";
    Object.assign(state, connectionFields(active || {}));
  }
  var ConnectionStore = {
    ready: false,
    serverPersisted: false,
    queue: Promise.resolve(),
    headers: function () {
      var ctx = stContext();
      if (!ctx || typeof ctx.getRequestHeaders !== "function") throw new Error("酒馆请求凭据不可用，无法保存连接");
      return ctx.getRequestHeaders();
    },
    upload: async function (data) {
      var bytes = new TextEncoder().encode(JSON.stringify(data)), binary = "";
      for (var i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      var response, headers = this.headers();
      try {
        response = await Env.pwin.fetch("/api/files/upload", {
          method: "POST", headers: headers,
          body: JSON.stringify({ name: CONNECTION_FILE, data: btoa(binary) })
        });
      } catch (e) { throw new Error("连接配置上传失败（网络）：" + e.message); }
      if (!response.ok) throw new Error("连接配置上传失败（HTTP " + response.status + "）");
    },
    load: async function () {
      var response, headers = this.headers();
      try {
        response = await Env.pwin.fetch("/user/files/" + CONNECTION_FILE + "?t=" + Date.now(), {
          cache: "no-store", headers: headers
        });
      } catch (e) { throw new Error("连接配置读取失败（网络）：" + e.message); }
      if (response.status === 404) {
        if (state.connectionProfiles.length) {
          await this.upload(connectionSnapshot());
          this.serverPersisted = true;
        }
      } else {
        if (!response.ok) throw new Error("连接配置读取失败（HTTP " + response.status + "）");
        var data;
        try { data = validateConnectionFile(await response.json()); }
        catch (e) { throw new Error("连接配置读取失败：" + e.message); }
        if(!data.privacyReset20261014){
          data={schemaVersion:1,privacyReset20261014:true,connectionProfiles:[],activeConnectionId:'',accountRotationEnabled:false};
          await this.upload(data);
        }
        commitConnections(data);
        this.serverPersisted = true;
      }
      this.ready = true;
    },
    update: function (edit) {
      var self = this;
      var job = this.queue.then(async function () {
        if (!self.ready) await self.load();
        var next = connectionSnapshot();
        edit(next);
        validateConnectionFile(next);
        await self.upload(next);
        self.serverPersisted = true;
        commitConnections(next);
        Store.save(); // 普通设置的本地写入失败不影响已确认的服务器保存。
      });
      this.queue = job.catch(function () {});
      return job;
    }
  };

  /* ------------------------------------------------------------
   * shujuku 桥接
   *
   * 只读。queryTableRows 与 querySql 只在 SQLite 模式且 runtime 就绪
   * 后才挂载，原生模式下是 undefined，所以统一走 exportTableAsJson
   * 这条通用路径自己解析。
   * ---------------------------------------------------------- */
  var Shujuku = {
    _cache: null,
    _bound: false,

    api: function () {
      try {
        return Env.pwin.AutoCardUpdaterAPI || window.AutoCardUpdaterAPI || null;
      } catch (e) {
        return null;
      }
    },

    available: function () {
      var api = this.api();
      return !!(api && typeof api.exportTableAsJson === "function");
    },

    tables: function (force) {
      if (this._cache && !force) return this._cache;
      var api = this.api();
      if (!api || typeof api.exportTableAsJson !== "function") return null;
      try {
        this._cache = api.exportTableAsJson() || null;
      } catch (e) {
        warn("读表失败", e);
        this._cache = null;
      }
      return this._cache;
    },

    invalidate: function () {
      this._cache = null;
    },

    /* 表更新后主动失效缓存，避免拿着旧外观继续出图 */
    bind: function () {
      if (this._bound) return;
      var api = this.api();
      if (!api || typeof api.registerTableUpdateCallback !== "function") return;
      var self = this;
      var cb = function () { self.invalidate(); };
      try {
        api.registerTableUpdateCallback(cb);
        this._bound = true;
        lifecycle.unbinds.push(function () {
          try {
            if (typeof api.unregisterTableUpdateCallback === "function") {
              api.unregisterTableUpdateCallback(cb);
            }
          } catch (e) {}
        });
      } catch (e) {
        warn("注册表更新回调失败", e);
      }
    },

    /* 生产环境返回 sheet_* 结构；本地 mock 有时归一成 { 表名: [[...]] } */
    sheetByName: function (name) {
      var all = this.tables();
      if (!all || typeof all !== "object") return null;

      for (var key in all) {
        if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
        var v = all[key];
        if (key.indexOf("sheet_") === 0 && v && v.name === name && Array.isArray(v.content)) {
          return { name: name, content: v.content };
        }
      }
      if (Array.isArray(all[name])) return { name: name, content: all[name] };
      return null;
    },

    rows: function (tableName) {
      var sheet = this.sheetByName(tableName);
      if (!sheet || !Array.isArray(sheet.content) || sheet.content.length < 1) return null;
      return sheet.content;
    },

    /* 在一张表里按姓名找行。行 0 是表头，数据从 1 起 */
    lookupIn: function (tableName, charName) {
      var content = this.rows(tableName);
      if (!content) return null;
      var head = (content[0] || []).map(function (h) { return String(h || "").trim(); });
      var iName = head.indexOf(COL_NAME);
      var iPos = head.indexOf(COL_POS);
      var iNeg = head.indexOf(COL_NEG);
      if (iName < 0) return null;

      var target = String(charName || "").trim();
      for (var r = 1; r < content.length; r++) {
        var row = content[r] || [];
        /* 死亡角色的姓名可能带「（已死亡）」后缀，按前缀宽松匹配 */
        var cell = String(row[iName] || "").trim();
        if (cell !== target && cell.indexOf(target + "（") !== 0) continue;
        return {
          name: target,
          positive: iPos >= 0 ? cleanCell(row[iPos]) : (tableName === TABLE_CHARACTER ? ["身份DNA", "外貌DNA", "穿搭DNA", "差异化特征"] : ["同人作品", "固定身份词", "服装词"]).map(function (column) {
            var index = head.indexOf(column);
            return index >= 0 ? cleanCell(row[index]) : "";
          }).filter(function (value) { return value !== ""; }).join(", "),
          negative: iNeg >= 0 ? cleanCell(row[iNeg]) : "",
        };
      }
      return null;
    },

    /* 配角先查重要角色表，查不到再看主角那一行 */
    lookupChar: function (charName) {
      return this.lookupIn(TABLE_CHARACTER, charName) || this.lookupIn(TABLE_NPC, charName) || this.lookupIn(TABLE_HERO, charName);
    },

    charNames: function () {
      var out = [];
      [TABLE_CHARACTER, TABLE_NPC, TABLE_HERO].forEach(function (table) {
        var content = Shujuku.rows(table);
        if (!content) return;
        var head = (content[0] || []).map(function (h) { return String(h || "").trim(); });
        var iName = head.indexOf(COL_NAME);
        if (iName < 0) return;
        for (var r = 1; r < content.length; r++) {
          var v = String((content[r] || [])[iName] || "").trim();
          if (v && out.indexOf(v) < 0) out.push(v);
        }
      });
      return out;
    },

    plotRowCount: function () {
      var content = this.rows(TABLE_CHRONICLE);
      return content ? Math.max(0, content.length - 1) : 0;
    },
  };

  /* 空值与占位符统一当空处理，填表 AI 常写「无」 */
  function cleanCell(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s || s === "无" || s === "-" || s === "/" || s.toLowerCase() === "none" || s.toLowerCase() === "n/a") return "";
    return s;
  }

  /* ------------------------------------------------------------
   * 预设适配
   *
   * 主路径走酒馆助手的 getPreset / updatePresetWith，旧版本没有这
   * 两个接口时回落到直接操作 Prompt Manager 的 DOM 行。
   * ---------------------------------------------------------- */
  // 酒馆助手运行时 Preset 使用 id/enabled；磁盘导出使用 identifier/prompt_order。
  function presetPromptId(prompt) {
    var id = prompt && (prompt.id || prompt.identifier);
    return typeof id === "string" && id.trim() ? id : "";
  }
  function presetRows(preset) {
    var prompts = (Array.isArray(preset.prompts) ? preset.prompts : []).concat(Array.isArray(preset.prompts_unused) ? preset.prompts_unused : []);
    var ordered = prompts;
    if (Array.isArray(preset.prompt_order)) {
      var byId = {}; prompts.forEach(function (p) { byId[presetPromptId(p)] = p; });
      var orders = preset.prompt_order.reduce(function (best, slot) { return (slot.order || []).length > best.length ? slot.order : best; }, []);
      ordered = orders.map(function (o) { return Object.assign({}, byId[o.identifier] || {}, { id: o.identifier, enabled: o.enabled }); });
    }
    return ordered.map(function (p) {
      return { identifier: presetPromptId(p), name: p.name || presetPromptId(p), role: p.role || "", marker: !!p.marker, content: p.content || "", length: (p.content || "").length, enabled: p.enabled === true };
    }).filter(function (p) { return !!p.identifier; });
  }
      var PresetAdapter = {
    hasApi: function () {
      return !!getBoundFunction("getPreset");
    },

    hasPromptManager: function () {
      try {
        return !!Env.pdoc.querySelector("#completion_prompt_manager_list");
      } catch (e) {
        return false;
      }
    },

    presetName: async function () {
      var api = getBoundFunction("getLoadedPresetName");
      if (!api) return "";
      try {
        return await api.fn();
      } catch (e) {
        return "";
      }
    },

    current: async function () {
      var api = getBoundFunction("getPreset");
      if (!api) return { ok: false, reason: "no-api" };
      try {
        return { ok: true, preset: await api.fn("in_use") };
      } catch (err) {
        return { ok: false, reason: String((err && err.message) || err) };
      }
    },

    listEntries: async function () {
      var res = await this.current();
      if (res.ok) {
        return { ok: true, adapter: "api", rows: presetRows(res.preset || {}) };
      }
      return this.listEntriesFromDom();
    },

    listEntriesFromDom: function () {
      var list = null;
      try {
        list = Env.pdoc.querySelector("#completion_prompt_manager_list");
      } catch (e) {}
      if (!list) return { ok: false, adapter: "dom", reason: "prompt-manager-not-open", rows: [] };

      var rows = Array.prototype.slice.call(list.querySelectorAll("li[data-pm-identifier]")).map(function (li) {
        var nameEl = li.querySelector(".completion_prompt_manager_prompt_name a, .completion_prompt_manager_prompt_name span");
        var toggle = li.querySelector(".prompt-manager-toggle-action");
        var enabled = toggle
          ? toggle.classList.contains("fa-toggle-on")
          : !li.classList.contains("completion_prompt_manager_prompt_disabled");
        return {
          identifier: li.getAttribute("data-pm-identifier"),
          name: (nameEl && nameEl.textContent.trim()) || li.getAttribute("data-pm-identifier"),
          role: "",
          marker: false,
          /* 界面上读不到正文，提示词库在这条路径下不可用 */
          content: "",
          length: 0,
          enabled: enabled,
        };
      });
      return { ok: rows.length > 0, adapter: "dom", rows: rows };
    },

    applyEnabled: async function (desired) {
      if (!desired || !Object.keys(desired).length) return { ok: true, applied: 0, adapter: "none" };

      var updateApi = getBoundFunction("updatePresetWith");
      if (updateApi) {
        var applied = 0;
        try {
          var mutatePreset = function (preset) {
            var rows = presetRows(preset), ids = rows.map(function (r) { return r.identifier; });
            if (Object.keys(desired).some(function (id) { return ids.indexOf(id) < 0; })) throw new Error("当前预设已变化，请重读后再修改");
            var wanted = Object.keys(desired);
            if (Array.isArray(preset.prompt_order)) {
              preset.prompt_order.forEach(function (slot) { (slot.order || []).forEach(function (p) {
                if (Object.prototype.hasOwnProperty.call(desired, p.identifier)) { if (p.enabled !== desired[p.identifier]) applied++; p.enabled = desired[p.identifier]; }
              }); });
            }
            (preset.prompts || []).forEach(function (p) {
              var id = presetPromptId(p);
              if (Object.prototype.hasOwnProperty.call(desired, id)) { if (p.enabled !== desired[id]) applied++; p.enabled = desired[id]; }
            });
            (preset.prompts_unused || []).forEach(function (p) {
              var id = presetPromptId(p);
              if (Object.prototype.hasOwnProperty.call(desired, id) && desired[id] === true) {
                preset.prompts = (preset.prompts || []).concat([Object.assign({}, p, { enabled: true })]);
                p.__n5c_move = true; applied++;
              }
            });
            preset.prompts_unused = (preset.prompts_unused || []).filter(function (p) { return !p.__n5c_move; });
            return preset;
          };

          // 1. 同步更新当前运行期的 in_use，保证当下生成即刻生效
          await updateApi.fn("in_use", mutatePreset);

          // 2. 双写持久化：同步更新具名预设（例如 预设-NAI5分格漫画 v5.11），触发酒馆写盘保存
          var targetName = await this.presetName();
          if (targetName && targetName !== "in_use") {
            try {
              await updateApi.fn(targetName, mutatePreset);
            } catch (namedErr) {
              warn("具名预设写盘持久化跳过或未成功: " + (namedErr && namedErr.message));
            }
          }

          var check = await this.current();
          if (!check.ok) throw new Error("修改后的预设无法读取，请重读确认");
          var actual = {}; presetRows(check.preset || {}).forEach(function (r) { actual[r.identifier] = r.enabled; });
          if (Object.keys(desired).some(function (id) { return actual[id] !== desired[id]; })) throw new Error("预设未保存指定选项，请重试");
          return { ok: true, applied: applied, adapter: "api" };
        } catch (err) { return { ok: false, adapter: "api", reason: err.message || "预设修改失败", applied: 0 }; }
      }
      return this.applyEnabledViaDom(desired);
    },

    applyEnabledViaDom: function (desired) {
      var list = null;
      try {
        list = Env.pdoc.querySelector("#completion_prompt_manager_list");
      } catch (e) {}
      if (!list) return { ok: false, adapter: "dom", reason: "prompt-manager-not-open", applied: 0 };

      var applied = 0;
      Object.keys(desired).forEach(function (id) {
        var li = list.querySelector('li[data-pm-identifier="' + id.replace(/"/g, '\\"') + '"]');
        if (!li) return;
        var toggle = li.querySelector(".prompt-manager-toggle-action");
        if (!toggle) return;
        if (toggle.classList.contains("fa-toggle-on") !== desired[id]) {
          toggle.click();
          applied++;
        }
      });
      return { ok: true, adapter: "dom", applied: applied };
    },

    /* 互斥组：只留 keepId，同组其余关掉 */
    applyExclusive: async function (groupIds, keepId) {
      var desired = {};
      groupIds.forEach(function (id) { desired[id] = id === keepId; });
      return this.applyEnabled(desired);
    },
  };

  /* ------------------------------------------------------------
   * 分档单选组
   *
   * 按 identifier 前缀识别预设里的互斥组。换一张预设就识别不到，
   * 此时显示缺少配套预设的说明。
   * ---------------------------------------------------------- */
  /* ------------------------------------------------------------
   * 提示词库
   *
   * 画师串、固定正面词、固定负面词三类都放在预设里由酒馆原生编辑器
   * 管理，条目默认关闭。禁用只决定要不要发给模型，不影响 getPreset
   * 读到 content，所以脚本照样能取到正文。
   *
   * 识别用块名前缀而不是 identifier：在酒馆里新建条目时 identifier
   * 是系统生成的 UUID、界面上改不了，按它识别的话用户自己加的条目
   * 永远认不出来。
   * ---------------------------------------------------------- */
  var LIB_KINDS = [
    { key: "style", label: "画风", prefixes: ["🎨丨画风-", "画风-", "🎨丨画师串-", "画师串-"] },
  ];

  /* 预设里的说明写在 {{// }} 里，发给模型时会被宏引擎剥掉，但 getPreset
     拿到的是原文。不在这里剥干净，说明文字会被拼进 NAI 请求画进画面。 */
  function stripMacroComments(s) {
    return String(s || "").replace(/\{\{\s*\/\/[\s\S]*?\}\}/g, "").trim();
  }

  function parseStyleContent(content) {
    var raw = stripMacroComments(String(content || ""));
    var negMatch = raw.match(/(?:^|\n)[ \t]*(?:\[(?:负面|NEGATIVE|UC)\]|负面[：:]|NEGATIVE[：:])[ \t]*/i);
    var posText = "", negText = "";
    if (negMatch) {
      posText = raw.slice(0, negMatch.index).trim();
      negText = raw.slice(negMatch.index + negMatch[0].length).trim();
    } else {
      posText = raw.trim();
      negText = "";
    }
    posText = posText.replace(/^[ \t]*(?:\[(?:正面|POSITIVE)\]|正面[：:]|POSITIVE[：:])[ \t]*/i, "").trim();
    return { positive: posText, negative: negText };
  }

  /* STYLE_IMPORT_CORE_BEGIN：只保留画风文本，逐个对象解析以限制图片数据驻留。 */
  function createStyleJsonParser(onRow) {
    var mode = "unknown";
    var arrayPhase = "start", depth = 0, inString = false, escaped = false, pieces = [], count = 0, firstCharacter = true;
    var objectChunks = [];

    function white(c) { return c === " " || c === "\t" || c === "\r" || c === "\n"; }

    function emitArrayEntry(text) {
      var entry = JSON.parse(text);
      if (!entry || Array.isArray(entry) || typeof entry !== "object") throw new Error("画风数组中的每一项必须是对象");
      var name = typeof entry.name === "string" ? entry.name.trim() : "";
      var validText = (entry.positivePrompt === undefined || typeof entry.positivePrompt === "string") && (entry.negativePrompt === undefined || typeof entry.negativePrompt === "string");
      var positive = typeof entry.positivePrompt === "string" ? entry.positivePrompt.trim() : "";
      var negative = typeof entry.negativePrompt === "string" ? entry.negativePrompt.trim() : "";
      var reason = !name ? "名称无效" : !validText ? "提示词字段类型错误" : (!positive && !negative) ? "无提示词" : "";
      var row = JSON.parse(JSON.stringify({ name: name || "未命名项 " + (count + 1), positive: positive, negative: negative, selectable: !reason, reason: reason }));
      count++;
      onRow(row);
    }

    function emitObjectPresets(fullText) {
      var data;
      try {
        data = JSON.parse(fullText);
      } catch (e) {
        throw new Error("JSON 格式错误：" + (e && e.message || "无法解析"));
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.presets || typeof data.presets !== "object" || Array.isArray(data.presets)) {
        throw new Error("文件顶层必须是画风数组，或包含 presets 对象的画风文件");
      }
      var keys = Object.keys(data.presets);
      if (!keys.length) {
        throw new Error("presets 中未找到任何画风条目");
      }
      for (var k = 0; k < keys.length; k++) {
        var pName = keys[k];
        var entry = data.presets[pName];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          var badRow = { name: String(pName || "未命名项 " + (count + 1)).trim(), positive: "", negative: "", selectable: false, reason: "条目格式错误" };
          count++;
          onRow(badRow);
          continue;
        }
        var name = String(pName || "").trim();
        var pos1 = typeof entry.fixedPrompt === "string" ? entry.fixedPrompt.trim() : "";
        var pos2 = typeof entry.fixedPrompt_end === "string" ? entry.fixedPrompt_end.trim() : "";
        var positive = [pos1, pos2].filter(Boolean).join("\n");
        var negative = typeof entry.negativePrompt === "string" ? entry.negativePrompt.trim() : "";
        var validText = (entry.fixedPrompt === undefined || typeof entry.fixedPrompt === "string") &&
                        (entry.fixedPrompt_end === undefined || typeof entry.fixedPrompt_end === "string") &&
                        (entry.negativePrompt === undefined || typeof entry.negativePrompt === "string");
        var reason = !name ? "名称无效" : !validText ? "提示词字段类型错误" : (!positive && !negative) ? "无提示词" : "";
        var row = JSON.parse(JSON.stringify({ name: name || "未命名项 " + (count + 1), positive: positive, negative: negative, selectable: !reason, reason: reason }));
        count++;
        onRow(row);
      }
    }

    return {
      push: function (chunk) {
        for (var i = 0; i < chunk.length; i++) {
          var ch = chunk[i];
          if (firstCharacter) {
            if (ch === "\uFEFF") continue;
            if (white(ch)) continue;
            firstCharacter = false;
            if (ch === "[") {
              mode = "array";
              arrayPhase = "first";
              continue;
            } else if (ch === "{") {
              mode = "object";
              objectChunks.push(chunk.slice(i));
              return;
            } else {
              throw new Error("文件顶层必须是画风数组或包含 presets 的 JSON 对象");
            }
          }

          if (mode === "object") {
            objectChunks.push(chunk.slice(i));
            return;
          }

          if (arrayPhase === "object") {
            if (inString) {
              if (escaped) escaped = false;
              else if (ch === "\\") escaped = true;
              else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === "{" || ch === "[") depth++;
            else if (ch === "}" || ch === "]") {
              depth--;
              if (depth === 0) {
                pieces.push(chunk.slice(start, i + 1));
                var text = pieces.join(""); pieces = []; start = -1;
                emitArrayEntry(text); arrayPhase = "separator";
              }
            }
            continue;
          }
          if (white(ch)) continue;
          if (arrayPhase === "first" || arrayPhase === "next") {
            if (ch === "]" && arrayPhase === "first") { arrayPhase = "done"; continue; }
            if (ch !== "{") throw new Error("画风数组中的每一项必须是对象，且不能有尾逗号");
            arrayPhase = "object"; depth = 1; inString = false; escaped = false; var start = i;
          } else if (arrayPhase === "separator") {
            if (ch === ",") arrayPhase = "next";
            else if (ch === "]") arrayPhase = "done";
            else throw new Error("画风对象之间缺少逗号或数组结束符");
          } else throw new Error("数组结束后存在多余内容");
        }
        if (mode === "array" && arrayPhase === "object") pieces.push(chunk.slice(start));
      },
      finish: function () {
        if (mode === "object") {
          emitObjectPresets(objectChunks.join(""));
          return count;
        }
        if (mode === "array") {
          if (arrayPhase !== "done") throw new Error("JSON 文件不完整或格式错误");
          return count;
        }
        throw new Error("JSON 文件内容为空或格式错误");
      }
    };
  }

  function styleImportWorkerMain(createParser) {
    self.onmessage = async function (event) {
      var reader;
      try {
        var file = event.data.file, rows = [], loaded = 0, lastProgress = 0;
        var parser = createParser(function (row) { rows.push(row); });
        var decoder = new TextDecoder("utf-8", { fatal: true });
        reader = file.stream().getReader();
        while (true) {
          var item = await reader.read();
          if (item.done) break;
          loaded += item.value.byteLength;
          parser.push(decoder.decode(item.value, { stream: true }));
          if (Date.now() - lastProgress > 100) {
            self.postMessage({ type: "progress", loaded: loaded, total: file.size, count: rows.length });
            lastProgress = Date.now();
          }
        }
        parser.push(decoder.decode()); parser.finish();
        self.postMessage({ type: "done", rows: rows });
      } catch (error) {
        self.postMessage({ type: "error", message: error.message || "读取 JSON 失败" });
      } finally {
        if (reader) reader.releaseLock();
      }
    };
  }

  function styleImportLabel(name) {
    return String(name || "").trim().replace(/^(?:🎨丨)?(?:画风|画师串)-\s*/, "").trim();
  }

  function buildStyleExportRows(preset) {
    if (!preset || typeof preset !== "object") throw new Error("无法读取当前预设");
    var rows = presetRows(preset).filter(function (row) {
      return /^(?:🎨丨)?(?:画风|画师串)-/.test(String(row.name || ""));
    });
    if (!rows.length) throw new Error("当前预设没有可导出的画风");
    return rows.map(function (row, index) {
      var name = styleImportLabel(row.name);
      var parsed = parseStyleContent(row.content);
      if (!name || (!parsed.positive && !parsed.negative)) {
        throw new Error("画风“" + row.name + "”缺少可导入的提示词");
      }
      return {
        name: name,
        sequence: index + 1,
        positivePrompt: parsed.positive,
        negativePrompt: parsed.negative,
        referenceImage: null
      };
    });
  }

  async function exportStyles() {
    var read = getBoundFunction("getPreset");
    if (!read) throw new Error("当前酒馆助手不支持读取预设，无法导出画风");
    var rows = buildStyleExportRows(await read.fn("in_use"));
    var blob = new Env.pwin.Blob([JSON.stringify(rows, null, 2)], { type: "application/json;charset=utf-8" });
    var url = Env.pwin.URL.createObjectURL(blob);
    var link;
    try {
      link = Env.pdoc.createElement("a");
      link.href = url;
      link.download = "画风导出.json";
      Env.pdoc.body.appendChild(link);
      link.click();
      setStatus("已发起下载 " + rows.length + " 条画风", "ok");
    } finally {
      if (link && link.parentNode) link.remove();
      Env.pwin.setTimeout(function () { Env.pwin.URL.revokeObjectURL(url); }, 60000);
    }
  }

  function makeStyleImportId() {
    var bytes = new Uint8Array(16);
    Env.pwin.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function buildStyleImportBatch(preset, rows, makeId) {
    var all = (preset.prompts || []).concat(preset.prompts_unused || []);
    var names = new Set(all.filter(function (p) { return /^(?:🎨丨)?(?:画风|画师串)-/.test(String(p.name || "")); }).map(function (p) { return styleImportLabel(p.name); }));
    var ids = new Set(all.map(function (p) { return p.id || p.identifier; }));
    return rows.map(function (row) {
      var base = styleImportLabel(row.name);
      if (!base || (!row.positive && !row.negative) || row.selectable === false) throw new Error("所选画风包含不可导入条目");
      var label = base, suffix = 1;
      while (names.has(label)) label = base + " (" + suffix++ + ")";
      names.add(label);
      var id = (makeId || makeStyleImportId)();
      if (!id || ids.has(id)) throw new Error("新画风 ID 冲突，请重新打开导入");
      ids.add(id);
      return { id: id, name: "画风-" + label, enabled: false, position: { type: "relative" }, role: "system", content: "[正面]\n" + (row.positive || "") + "\n\n[负面]\n" + (row.negative || "") };
    });
  }

  function appendStyleImportBatch(preset, batch) {
    var out = Object.assign({}, preset, { prompts: (preset.prompts || []).slice(), prompts_unused: (preset.prompts_unused || []).slice() });
    var all = out.prompts.concat(out.prompts_unused), additions = [];
    batch.forEach(function (entry) {
      var existing = all.find(function (p) { return (p.id || p.identifier) === entry.id; });
      if (existing) {
        if (existing.name !== entry.name || existing.content !== entry.content || existing.enabled !== false) throw new Error("待导入画风已被修改，请重新打开导入");
      } else {
        if (all.some(function (p) { return /^(?:🎨丨)?(?:画风|画师串)-/.test(String(p.name || "")) && styleImportLabel(p.name) === styleImportLabel(entry.name); })) throw new Error("画风名称已被占用，请重新选择以生成新名称");
        additions.push(entry); all.push(entry);
      }
    });
    var position = out.prompts.length;
    for (var i = out.prompts.length - 1; i >= 0; i--) {
      if (/^(?:🎨丨)?(?:画风|画师串)-/.test(String(out.prompts[i].name || ""))) { position = i + 1; break; }
    }
    out.prompts.splice.apply(out.prompts, [position, 0].concat(additions));
    if (Array.isArray(out.prompt_order)) {
      out.prompt_order = out.prompt_order.map(function (slot) {
        var order = (slot && Array.isArray(slot.order) ? slot.order : []).slice();
        var orderPos = order.length;
        for (var j = order.length - 1; j >= 0; j--) {
          var id = order[j].identifier;
          var p = all.find(function (x) { return (x.id || x.identifier) === id; });
          if (p && /^(?:🎨丨)?(?:画风|画师串)-/.test(String(p.name || ""))) {
            orderPos = j + 1;
            break;
          }
        }
        var orderAdditions = additions.map(function (entry) {
          return { identifier: entry.id, enabled: false };
        });
        order.splice.apply(order, [orderPos, 0].concat(orderAdditions));
        return Object.assign({}, slot, { order: order });
      });
    }
    return out;
  }

  async function saveImportedStyles(targetName, batch) {
    var loaded = getBoundFunction("getLoadedPresetName"), read = getBoundFunction("getPreset"), replace = getBoundFunction("replacePreset");
    if (!loaded || !read || !replace) throw new Error("当前酒馆助手不支持画风写入，请更新后重试");
    if (!targetName || targetName === "in_use" || await loaded.fn() !== targetName) throw new Error("当前预设已切换，请关闭后重新导入");
    if (!batch.length) throw new Error("请先选择要导入的画风");
    var before = await read.fn("in_use"), draft = appendStyleImportBatch(before, batch);
    if (hostApi.director) { await replace.fn("in_use", draft); return { count: batch.length }; }
    await replace.fn(targetName, draft, { render: "none" });
    if (await loaded.fn() !== targetName) throw new Error("画风已保存到“" + targetName + "”，但当前预设已切换，未修改新预设");
    // 保存期间若当前编辑内容变化，保留用户的新编辑，不用旧快照覆盖。
    var current = await read.fn("in_use");
    if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error("画风已保存，但当前预设内容刚发生变化；请重新确认后重试");
    try { await replace.fn("in_use", draft, { render: "immediate" }); }
    catch (error) { throw new Error("画风已保存到预设文件，但当前界面同步未完成；再次确认可继续同步：" + (error.message || "未知错误")); }
    var results = [await read.fn(targetName), await read.fn("in_use")];
    var importedIds = new Set(batch.map(function (p) { return p.id; }));
    results.forEach(function (preset) {
      ["prompts", "prompts_unused"].forEach(function (key) {
        var retainedBefore = (before[key] || []).filter(function (p) { return !importedIds.has(p.id || p.identifier); });
        var retainedAfter = (preset[key] || []).filter(function (p) { return !importedIds.has(p.id || p.identifier); });
        if (JSON.stringify(retainedAfter) !== JSON.stringify(retainedBefore)) throw new Error("保存回读发现原有条目或顺序变化，请检查预设后重试");
      });
      var rows = (preset.prompts || []).concat(preset.prompts_unused || []);
      batch.forEach(function (entry) {
        var got = rows.find(function (p) { return (p.id || p.identifier) === entry.id; });
        if (!got || got.name !== entry.name || got.content !== entry.content || got.enabled !== false) throw new Error("保存回读未通过，请保留弹窗并重试");
      });
    });
    return { count: batch.length };
  }

  async function chooseLibraryItem(kind, id, items) {
    var key = kind === "style" ? "styleId" : kind + "Id";
    state[key] = id;
    if (!Store.save()) throw new Error("词库选项未保存");
    if (kind !== "style") {
      var desired = {};
      items.forEach(function (item) { desired[item.identifier] = item.identifier === id; });
      var changed = await PresetAdapter.applyEnabled(desired);
      if (changed && changed.ok === false) throw new Error(changed.reason || "预设修改失败");
    }
  }
  /* STYLE_IMPORT_CORE_END */

  var PromptLibrary = {
    _cache: null,

    invalidate: function () {
      this._cache = null;
    },

    load: async function (force) {
      if (this._cache && !force) return this._cache;

      var out = { ok: false, reason: "", style: [] };

      var res = await PresetAdapter.current();
      if (!res.ok) {
        out.reason = res.reason === "no-api"
          ? "需要 getPreset 接口才能读预设里的提示词库，当前酒馆助手版本不支持"
          : "读预设失败：" + res.reason;
        this._cache = out;
        return out;
      }

      var p = res.preset || {}, seen = {};
      var prompts = (p.prompts || []).concat(p.prompts_unused || []).filter(function (prompt) { var id = presetPromptId(prompt); if (!id || seen[id]) return false; seen[id] = true; return true; });
      prompts.forEach(function (p) {
        var name = String((p && p.name) || "");
        var c = categoryFromName(name);
        var lk = c ? libraryKey(c.name) : null;
        if (!lk) {
          for (var i = 0; i < LIB_KINDS.length; i++) {
            if (LIB_KINDS[i].prefixes.some(function (pre) { return name.indexOf(pre) === 0; })) {
              lk = LIB_KINDS[i].key;
              break;
            }
          }
        }
        if (!lk) return;
        var parsed = parseStyleContent(p.content);
        out[lk].push({
          identifier: presetPromptId(p),
          label: (c && c.label) || segItemLabel(name),
          content: stripMacroComments(p.content),
          positive: parsed.positive,
          negative: parsed.negative,
          enabled: p.enabled === true,
        });
      });

      out.ok = true;
      this._cache = out;
      return out;
    },

    pick: function (lib, kind, wantId) {
      var items = (lib && lib[kind]) || [];
      if (!items.length) return null;
      if (wantId) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].identifier === wantId || items[i].label === wantId) return items[i];
        }
      }
      var enabledItem = items.find(function (item) { return item.enabled === true; });
      if (enabledItem) return enabledItem;
      var preferred = "lib_style_yo";
      return items.find(function (item) { return item.identifier === preferred; }) || items[0];
    },
  };

  /* 块名形如「💬丨对白语言-中文」，剥掉 emoji、分组名与括注，按钮上只留「中文」 */
  function segItemLabel(name) {
    var s = String(name || "").replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, "");
    var bar = s.indexOf("丨");
    if (bar >= 0) s = s.slice(bar + 1);
    var dash = s.lastIndexOf("-");
    if (dash > 0 && dash < s.length - 1) s = s.slice(dash + 1);
    return s.replace(/（[^）]*）/g, "").trim() || name;
  }

  /* ------------------------------------------------------------
   * 网络
   * ---------------------------------------------------------- */
  function hostFetch(url, opts) {
    var f = Env.pwin && typeof Env.pwin.fetch === "function" ? Env.pwin.fetch.bind(Env.pwin) : fetch;
    return f(url, opts);
  }

  var cachedHeaders = null;

  /* 酒馆后端要 CSRF 头，三级兜底取。图片入库要用。 */
  async function stHeaders() {
    if (cachedHeaders) return cachedHeaders;

    var direct = getBoundFunction("getRequestHeaders");
    if (direct) {
      try {
        var h = direct.fn();
        if (h && h["X-CSRF-Token"]) return (cachedHeaders = h);
      } catch (e) {}
    }

    var ctx = stContext();
    if (ctx && typeof ctx.getRequestHeaders === "function") {
      try {
        var h2 = ctx.getRequestHeaders();
        if (h2 && h2["X-CSRF-Token"]) return (cachedHeaders = h2);
      } catch (e) {}
    }

    try {
      var res = await hostFetch("/csrf-token");
      var data = await res.json();
      if (data && data.token) {
        return (cachedHeaders = { "Content-Type": "application/json", "X-CSRF-Token": data.token });
      }
    } catch (e) {}

    return { "Content-Type": "application/json" };
  }

  /* ------------------------------------------------------------
   * ZIP 读取
   *
   * NovelAI 返回的是 ZIP，里面装着一张 PNG。酒馆助手环境不保证有
   * JSZip，这里按规范手工解：定位中央目录、读条目、stored 直接切
   * 片、deflate 交给浏览器原生的 DecompressionStream。
   * ---------------------------------------------------------- */
  var ZIP = {
    SIG_EOCD: 0x06054b50,
    SIG_CENTRAL: 0x02014b50,

    async firstFile(buffer) {
      var view = new DataView(buffer);
      var bytes = new Uint8Array(buffer);

      /* EOCD 在包尾，注释最长 65535，从后往前扫 */
      var eocd = -1;
      var floor = Math.max(0, bytes.length - 65558);
      for (var i = bytes.length - 22; i >= floor; i--) {
        if (view.getUint32(i, true) === this.SIG_EOCD) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error("ZIP 结构异常：找不到中央目录");

      var count = view.getUint16(eocd + 10, true);
      if (!count) throw new Error("ZIP 里没有文件");

      var p = view.getUint32(eocd + 16, true);
      if (view.getUint32(p, true) !== this.SIG_CENTRAL) throw new Error("ZIP 中央目录签名不符");

      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var localOffset = view.getUint32(p + 42, true);

      /* 本地头的 extra 长度可能与中央目录不同，必须按本地头算数据起点 */
      var lNameLen = view.getUint16(localOffset + 26, true);
      var lExtraLen = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;
      var raw = bytes.subarray(dataStart, dataStart + compSize);

      if (method === 0) return raw;
      if (method !== 8) throw new Error("ZIP 压缩方式不支持: " + method);

      if (typeof DecompressionStream !== "function") {
        throw new Error("浏览器不支持 DecompressionStream，无法解开 deflate 包");
      }
      var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };

  function bytesToBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(""));
  }

  /* ------------------------------------------------------------
   * 提示词组装
   * ---------------------------------------------------------- */

  function nonEmpty(s) {
    return !!(s && String(s).trim());
  }

  /* 兼容历史竖线分段提示词；不删除正文中的格式声明。 */
  function splitMultiBubbleSegment(seg) {
    return [String(seg || "")];
  }

    function splitPromptSegments(body) {
    var text = String(body || "").trim();
    var parts = [], current = "", escaped = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (escaped) { current += ch; escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === "|") { parts.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    parts.push(current.trim());
    var rawParts = parts.filter(nonEmpty);
    if (rawParts.length <= 1) return rawParts;
    var finalParts = [rawParts[0]];
    for (var j = 1; j < rawParts.length; j++) {
      var subs = splitMultiBubbleSegment(rawParts[j]);
      for (var k = 0; k < subs.length; k++) {
        finalParts.push(subs[k]);
      }
    }
    return finalParts;
  }

  function cleanPromptText(text) {
    return String(text || "").replace(/^[ \t]*(?:Panel\s+\d+|角色|说话人)[ \t]*[:：][ \t]*/gim, "").trim();
  }

  function cleanDialogue(s) {
    var lines = String(s || "").split("\n").map(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return "";
      trimmed = trimmed.replace(/^[ \t]*(?:Panel\s+\d+|[^\n:：]+?(?:（[^）]*）|\([^)]*\))?)[ \t]*[:：][ \t]*/, "");
      trimmed = trimmed.replace(/^[“"「『]([\s\S]*)[”"」』]$/, "$1");
      return trimmed.trim();
    });
    return lines.filter(Boolean).join("\n\n");
  }

  
  /* 纯机械提取角色母表及本轮外观变化（支持按生效页码平滑换装） */
  function extractCharacterDictionary(rawText, pageNo) {
    var plan = String(rawText || "").match(/<comic_plan>([\s\S]*?)<\/comic_plan>/i);
    if (!plan) return null;
    var lines = plan[1].split(/\r?\n/), dict = {}, rootIndent = -1, cid = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], heading = /^([ \t]*)-?[ \t]*角色母表[ \t]*[:：][ \t]*$/.exec(line);
      if (rootIndent < 0) { if (heading) rootIndent = heading[1].length; continue; }
      if (!line.trim()) continue;
      var indent = /^[ \t]*/.exec(line)[0].length;
      if (indent <= rootIndent) break;
      var entry = /^[ \t]*-[ \t]*(C\d+)[ \t]*[:：][ \t]*$/i.exec(line);
      if (entry) { cid = entry[1].toUpperCase(); dict[cid] = { identity: "", outfit: "" }; continue; }
      if (!cid) continue;
      var identity = /^[ \t]*-[ \t]*固定身份词[ \t]*[:：][ \t]*([^\r\n]*)$/.exec(line);
      var outfit = /^[ \t]*-[ \t]*初始服装词(?:[（(][^）)]*[）)])?[ \t]*[:：][ \t]*([^\r\n]*)$/.exec(line);
      if (identity) dict[cid].identity = identity[1].trim();
      if (outfit) dict[cid].outfit = outfit[1].trim();
    }
    return rootIndent < 0 ? null : dict;
  }

  /* 纯机械变量替换：1 对 1 字符串文本查表替换，零额外清洗 */
  function applyCharacterVariables(promptText, dict) {
    if (!dict || !Object.keys(dict).length) return promptText;
    var text = String(promptText || ""), result = "", start = 0, escaped = false;
    function expandSegment(segment) {
      var marker = /\bText[ \t]*[:：]/i.exec(segment);
      var split = marker ? marker.index : segment.length;
      var visual = segment.slice(0, split).replace(/(^|[^A-Za-z0-9_@])(@([Cc]\d+)(?:_([A-Za-z0-9_]+))?)(?![A-Za-z0-9_])/g, function (match, prefix, token, cid, suffix) {
        var entry = dict[cid.toUpperCase()];
        if (!entry) return match;
        var kind = String(suffix || "").toLowerCase();
        if (kind === "" || kind === "id" || kind === "identity") return prefix + (entry.identity || token);
        if (kind === "outfit" || kind === "costume") return prefix + (entry.outfit || token);
        return match;
      });
      return visual + segment.slice(split);
    }
    for (var i = 0; i < text.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (text[i] === "\\") { escaped = true; continue; }
      if (text[i] === "|") { result += expandSegment(text.slice(start, i)) + "|"; start = i + 1; }
    }
    return result + expandSegment(text.slice(start));
  }

  function parseSegment(segment, index) {
    var body = String(segment || "").trim();
    var typeMatch = /^[ \t]*@text[ \t]*:[ \t]*([^\r\n]*)$/im.exec(body);
    var textType = typeMatch ? typeMatch[1].trim().toLowerCase() : (index === 0 ? "caption" : "dialogue");
    body = body.replace(/^[ \t]*@text[ \t]*:[ \t]*[^\r\n]*$/gim, "").trim();

    var text = "";
    // 仅在属于旧版末尾独占行 Text:（且非段内已有 Text: / 非引号内文本）时兼容分离，其余均原样保留在 prompt 中
    var legacyMatch = /(?:^|\n)[ \t]*Text[ \t]*[:：][ \t]*([^\r\n]+)$/i.exec(body);
    if (legacyMatch && !/with\s+Text\s*[:：]/i.test(body) && !/Text\s*[:：]\s*["“]/i.test(body)) {
      text = legacyMatch[1].trim();
      body = body.slice(0, legacyMatch.index).trim();
    }
    return { prompt: cleanPromptText(body), text: text, textType: textType };
  }

  function clampCenter(center) {
    var x = Number(center && center.x), y = Number(center && center.y);
    return { x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5, y: Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5 };
  }

  function parseV83ImageProtocol(body) {
    var data;
    try { data = typeof body === "string" ? JSON.parse(body) : body; } catch (e) { return null; }
    if (!data || data.format !== "nai5-comic" || !data.page || typeof data.page !== "object") return null;
    var panels = Array.isArray(data.panels) ? data.panels : [];
    var hasTopCharacters = Object.prototype.hasOwnProperty.call(data, "characters");
    var hasNestedCharacters = panels.some(function (panel) { return panel && Object.prototype.hasOwnProperty.call(panel, "characters"); });
    if (hasTopCharacters && hasNestedCharacters) return { ok: false, reason: "不可混用顶层与画格内人物槽位" };
    if (hasNestedCharacters) {
      if (!panels.length || data.position_mode && data.position_mode !== "auto" && data.position_mode !== "manual") return { ok: false, reason: "无效的画格或定位模式" };
      var seenPanels = {}, characters = [], pieces = [];
      function splitCaption(value) {
        var text = String(value || "").trim(), marker = /\bText[ \t]*[:：]/i.exec(text);
        return marker ? { visual: text.slice(0, marker.index).trim(), text: text.slice(marker.index + marker[0].length).trim() } : { visual: text, text: "" };
      }
      pieces.push(splitCaption(data.page.base));
      pieces.push(splitCaption(data.page.non_character));
      for (var i = 0; i < panels.length; i++) {
        var panel = panels[i], pid = panel && String(panel.id || "").trim();
        if (!pid || seenPanels[pid] || !Array.isArray(panel.characters)) return { ok: false, reason: "第 " + (i + 1) + " 格缺少唯一编号或 characters 数组" };
        seenPanels[pid] = true;
        pieces.push(splitCaption(panel.description));
        pieces.push(splitCaption(panel.non_character));
        var seenCharacters = {};
        for (var j = 0; j < panel.characters.length; j++) {
          var entry = panel.characters[j];
          var cid = entry && String(entry.character_id || "").trim();
          var positive = entry && typeof entry.positive === "string" ? entry.positive.trim() : "";
          if (!cid || seenCharacters[cid] || !positive || typeof entry.negative !== "string") return { ok: false, reason: pid + " 的第 " + (j + 1) + " 个人物槽位不完整或重复" };
          seenCharacters[cid] = true;
          if (data.position_mode === "manual" && (!entry.center || !Number.isFinite(entry.center.x) || !Number.isFinite(entry.center.y) || entry.center.x < 0 || entry.center.x > 1 || entry.center.y < 0 || entry.center.y > 1)) return { ok: false, reason: pid + " / " + cid + " 缺少有效中心点" };
          characters.push({ id: pid + "-" + cid + "-" + (j + 1), characterId: cid, panel: pid, positive: positive, negative: entry.negative.trim(), center: clampCenter(entry.center) });
        }
      }
      var visual = pieces.map(function (piece) { return piece.visual.replace(/[,，]\s*$/, ""); }).filter(nonEmpty).join(", ");
      var texts = pieces.map(function (piece) { return piece.text; }).filter(nonEmpty);
      var basePrompt = visual + (texts.length ? "\nText: " + texts.join("\n\n") : "");
      if (!visual) return { ok: false, reason: "图片协议缺少 page.base 或画格描述" };
      return { ok: true, structured: true, nested: true, raw: data, positionMode: data.position_mode === "manual" ? "manual" : "auto", base: { prompt: basePrompt, text: "", textType: "caption" }, characters: characters, panels: visual, text: basePrompt };
    }
    // Keep the historical flat JSON protocol unchanged for saved pages.
    if (!Array.isArray(data.characters)) return { ok: false, reason: "图片协议缺少画格内或顶层 characters 数组" };
    var panelBits = panels.map(function (panel) { return String(panel && (panel.description || panel.content) || "").trim(); }).filter(nonEmpty);
    var nonCharacter = String(data.page.non_character || "").trim();
    var flatBase = [String(data.page.base || data.page.description || "").trim()].concat(panelBits).concat(nonCharacter ? [nonCharacter] : []).filter(nonEmpty).join(", ");
    if (!flatBase) return { ok: false, reason: "图片协议缺少 page.base 或画格描述" };
    var flatCharacters = (Array.isArray(data.characters) ? data.characters : []).map(function (entry, index) {
      if (!entry || typeof entry !== "object") return null;
      var positive = String(entry.positive || "").trim();
      if (!positive) return null;
      return { id: String(entry.id || "slot-" + (index + 1)), characterId: String(entry.character_id || entry.characterId || ""), panel: String(entry.panel || "未标注画格"), positive: positive, negative: String(entry.negative || "").trim(), center: clampCenter(entry.center) };
    }).filter(function (entry) { return !!entry; });
    return { ok: true, structured: true, nested: false, raw: data, positionMode: data.position_mode === "manual" ? "manual" : "auto", base: { prompt: flatBase, text: "", textType: "caption" }, characters: flatCharacters, panels: flatBase, text: flatBase };
  }

  // v1.2 文本协议只负责分段；按格校验与请求装配复用原有结构。
  function isSectionImageProtocol(body) {
    return /^\s*@(?:page\b|position\b)/i.test(String(body || ""));
  }

  function readSectionImageData(body) {
    var data = { format: "nai5-comic", page: { base: "" }, panels: [] };
    var panel = null, character = null, target = null, buffer = [], hasPage = false;
    function flush() {
      if (target) target.object[target.key] = buffer.join("\n").trim();
      buffer = [];
    }
    function begin(object, key) { target = { object: object, key: key }; }
    var lines = String(body || "").replace(/\r\n?/g, "\n").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], marker = /^\s*@(page|panel|character|negative|non_character|position|center)\b(?:[ \t]+(.*?))?[ \t]*$/i.exec(line);
      if (!marker) {
        if (target) buffer.push(line);
        else if (line.trim()) return { ok: false, reason: "第 " + (i + 1) + " 行正文没有所属段落" };
        continue;
      }
      flush();
      target = null;
      var kind = marker[1].toLowerCase(), value = String(marker[2] || "").trim();
      if (kind === "position") {
        if (hasPage || value !== "manual" && value !== "auto") return { ok: false, reason: "@position 须在 @page 前指定 manual 或 auto" };
        if (value === "manual") data.position_mode = "manual";
        else delete data.position_mode;
      } else if (kind === "page") {
        if (hasPage || value) return { ok: false, reason: "每个图片块只允许一个独占行 @page" };
        hasPage = true;
        begin(data.page, "base");
      } else if (kind === "panel") {
        if (!hasPage || !value || /\s/.test(value)) return { ok: false, reason: "@panel 须在页面之后填写一个画格编号" };
        panel = { id: value, description: "", characters: [] };
        data.panels.push(panel);
        character = null;
        begin(panel, "description");
      } else if (kind === "character") {
        if (!panel || !value || /\s/.test(value)) return { ok: false, reason: "@character 须在画格内填写一个人物编号" };
        character = { character_id: value, positive: "", negative: "" };
        panel.characters.push(character);
        begin(character, "positive");
      } else if (kind === "negative") {
        if (!character || value) return { ok: false, reason: "@negative 须独占一行并归属当前人物" };
        begin(character, "negative");
      } else if (kind === "non_character") {
        if (!hasPage || value) return { ok: false, reason: "@non_character 须独占一行并归属页面或画格" };
        character = null;
        begin(panel || data.page, "non_character");
      } else if (kind === "center") {
        var pair = value.split(/[,，]/);
        if (!character || data.position_mode !== "manual" || pair.length !== 2 || pair.some(function (n) { return !n.trim() || !Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 1; })) {
          return { ok: false, reason: "@center 须为手动定位人物填写 0 至 1 的 x,y" };
        }
        character.center = { x: Number(pair[0]), y: Number(pair[1]) };
      }
    }
    flush();
    if (!hasPage || !data.panels.length) return { ok: false, reason: "图片协议缺少 @page 或 @panel" };
    return { ok: true, data: data };
  }

  function parseSectionImageProtocol(body) {
    var draft = readSectionImageData(body);
    if (!draft.ok) return draft;
    var parsed = parseV83ImageProtocol(draft.data);
    if (parsed && parsed.ok) parsed.wireFormat = "sections";
    return parsed;
  }

  function serializeSectionImageProtocol(data) {
    var chunks = [];
    function add(marker, value) {
      var text = String(value == null ? "" : value).trim();
      chunks.push(marker + (text ? "\n" + text : ""));
    }
    if (data.position_mode === "manual") chunks.push("@position manual");
    add("@page", data.page.base);
    if (nonEmpty(data.page.non_character)) add("@non_character", data.page.non_character);
    data.panels.forEach(function (panel) {
      add("@panel " + panel.id, panel.description);
      if (nonEmpty(panel.non_character)) add("@non_character", panel.non_character);
      panel.characters.forEach(function (character) {
        add("@character " + character.character_id, character.positive);
        if (nonEmpty(character.negative)) add("@negative", character.negative);
        if (data.position_mode === "manual" && character.center) chunks.push("@center " + character.center.x + "," + character.center.y);
      });
    });
    return chunks.join("\n\n");
  }

  function parseImageBlock(raw) {
    var body = String(raw || "").trim();
    if (!body) return { ok: false, reason: "图片块内容为空" };
    if (isSectionImageProtocol(body)) return parseSectionImageProtocol(body);
    var structured = parseV83ImageProtocol(body);
    if (structured) return structured;
    if (/^\s*\{/.test(body) && /"(?:format|position_mode|page|panels|characters)"\s*:/.test(body)) {
      return { ok: false, reason: "结构化图片提示词 JSON 无效或 format 不正确" };
    }
    var segments = splitPromptSegments(body).map(parseSegment);
    segments = segments.filter(function (x) { return nonEmpty(x.prompt) || nonEmpty(x.text); });
    if (!segments.length || !segments[0].prompt) return { ok: false, reason: "缺少页面级提示词" };
    return {
      ok: true,
      structured: false,
      base: segments[0],
      characters: segments.slice(1),
      panels: segments[0].prompt,
      text: segments.map(function (x) { return x.text || x.prompt; }).filter(nonEmpty).join("\n")
    };
  }

  function countPanels(panels) {
    var m = String(panels || "").match(/\b(?:one|two|three|four|five)[ -]panel|\b\d+[ -]panel/ig);
    return m ? m.length : 0;
  }


  /* 三个取值口。库里没有对应条目时返回空串，出图照常进行 */
  function styleItemOf(lib) {
    return PromptLibrary.pick(lib, "style", state.styleId);
  }

  function styleOf(lib) {
    var hit = styleItemOf(lib);
    return hit ? hit.positive : "";
  }

  function negativeBaseOf(lib) {
    var hit = styleItemOf(lib);
    return hit ? hit.negative : "";
  }

  /* V5 由文本模型提供完整人物出场词；角色槽位与位置显式传入请求。 */
  function resolveChars() { return { entries: [], missing: [], reason: "" }; }


  /* 每段独立编译；所有描述都在该段最后的 Text: 之前。 */
  function compileTextCaption(segment) {
    var prompt = String(segment.prompt || "").trim();
    // 仅在存在旧版单独剥离的 text 且 prompt 内未内联 Text: 时，执行末尾拼接兼容
    if (nonEmpty(segment.text) && !/\bText[ \t]*[:：]/i.test(prompt)) {
      return prompt + "\nText: " + segment.text;
    }
    return prompt;
  }

  function assemblePrompt(parsed, lib) {
    if (hostApi.director?.library) parsed = hostApi.director.library.apply(parsed);
    var basePrompt = parsed.base.prompt || "";
    var base = [styleOf(lib), basePrompt].filter(nonEmpty).join(", ");
    if (parsed.structured) {
      return {
        base: compileTextCaption({ prompt: base, text: parsed.base.text, textType: parsed.base.textType || "caption" }),
        characters: parsed.characters.map(function (entry) {
          return {
            id: entry.id,
            characterId: entry.characterId,
            panel: entry.panel,
            positive: entry.positive,
            negative: entry.negative,
            center: clampCenter(entry.center)
          };
        }),
        useCoords: parsed.positionMode === "manual"
      };
    }
    return {
      base: compileTextCaption({ prompt: base, text: parsed.base.text, textType: parsed.base.textType || "caption" }),
      characters: parsed.characters.map(function (entry) { return { positive: compileTextCaption(entry), negative: entry.negative || "", center: { x: 0.5, y: 0.5 } }; }),
      useCoords: false
    };
  }

    function buildNegative(lib) {
    var neg = negativeBaseOf(lib);
    if (!nonEmpty(neg)) {
      neg = "lowres, worst quality, bad quality, jpeg artifacts, very displeasing, artistic error, bad anatomy";
    }
    return sanitizeNegative(neg);
  }

  /* ------------------------------------------------------------
   * NovelAI
   * ---------------------------------------------------------- */
  var rotationIndex = 0;
  var accountInFlight = new Map();
  var accountWaiters = [];

  function isValidConnectionProfile(p) {
    if (!p || typeof p !== "object") return false;
    var token = String(p.naiToken || "").trim();
    if (!token) return false;
    try {
      naiEndpoint(p);
      return true;
    } catch (e) {
      return false;
    }
  }

  function getValidConnectionProfiles() {
    return (state.connectionProfiles || []).filter(isValidConnectionProfile);
  }

  function isAccountFree(id) {
    return (accountInFlight.get(id) || 0) === 0;
  }

  function releaseAccountLease(id) {
    if (!id) return;
    var cur = accountInFlight.get(id) || 1;
    accountInFlight.set(id, Math.max(0, cur - 1));
    drainAccountWaiters();
  }

  function drainAccountWaiters() {
    if (!accountWaiters.length) return;
    for (var i = 0; i < accountWaiters.length; i++) {
      var w = accountWaiters[i];
      if (w.tryAcquire()) {
        accountWaiters.splice(i, 1);
        break;
      }
    }
  }

  function acquireGenerationConnection(isManual, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        return reject(new Error("任务已取消"));
      }

      function tryAcquire() {
        if (signal && signal.aborted) return false;
        if (state.accountRotationEnabled) {
          var pool = getValidConnectionProfiles();
          if (!pool.length) {
            reject(new Error("已开启账号轮询，但未找到任何有效的已保存 API 连接，请先在连接页保存有效配置"));
            return true;
          }
          for (var i = 0; i < pool.length; i++) {
            var idx = (rotationIndex + i) % pool.length;
            var p = pool[idx];
            if (isAccountFree(p.id)) {
              rotationIndex = (idx + 1) % pool.length;
              accountInFlight.set(p.id, 1);
              resolve({
                id: p.id,
                name: p.name,
                channel: p.channel,
                customUrl: p.customUrl,
                naiToken: p.naiToken,
                isRotated: true,
                release: function () { releaseAccountLease(p.id); }
              });
              return true;
            }
          }
          return false;
        }

        var active = state.connectionProfiles.find(function (p) { return p.id === state.activeConnectionId; });
        var p = active || state;
        var token = String(p.naiToken || "").trim();
        if (!token) {
          reject(new Error("未填写 NovelAI Key，请在连接页配置 API"));
          return true;
        }
        var accountId = active ? active.id : "current";
        if (isAccountFree(accountId)) {
          accountInFlight.set(accountId, 1);
          resolve({
            id: accountId,
            name: active ? active.name : "当前连接",
            channel: p.channel === "mirror" ? "mirror" : "official",
            customUrl: String(p.customUrl || ""),
            naiToken: token,
            isRotated: false,
            release: function () { releaseAccountLease(accountId); }
          });
          return true;
        }
        return false;
      }

      if (tryAcquire()) return;

      var waiter = {
        isPriority: !!isManual,
        tryAcquire: tryAcquire,
        cancel: function () {
          var idx = accountWaiters.indexOf(waiter);
          if (idx >= 0) accountWaiters.splice(idx, 1);
        }
      };

      if (signal) {
        var onAbort = function () {
          waiter.cancel();
          reject(new Error("任务已取消"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (isManual) {
        var insertIdx = accountWaiters.findIndex(function (w) { return !w.isPriority; });
        if (insertIdx >= 0) accountWaiters.splice(insertIdx, 0, waiter);
        else accountWaiters.push(waiter);
      } else {
        accountWaiters.push(waiter);
      }
    });
  }

  function naiEndpoint(config) {
    config = config || state;
    if (config.channel === "mirror") {
      var raw = String(config.customUrl || "").trim().replace(/\/+$/, "");
      if (!raw) throw new Error("已选自定义反代，但没有填地址");
      var parsed;
      try { parsed = new URL(raw); } catch (e) { throw new Error("自定义 URL 格式无效"); }
      var loopback = ["localhost", "127.0.0.1", "[::1]"].indexOf(parsed.hostname) >= 0;
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("远程反代必须使用 HTTPS，HTTP 仅允许本机回环地址");
      if (parsed.username || parsed.password) throw new Error("请将认证信息填写到 Key 字段，不放在 URL 中");
      return raw.indexOf("generate-image") >= 0 ? raw : raw + "/ai/generate-image";
    }
    return "https://image.novelai.net/ai/generate-image";
  }

    /* ------------------------------------------------------------
   * 运行日志管理（最近 50 条，可开关、可折叠）
   * ---------------------------------------------------------- */
  var MAX_LOG_ENTRIES = 50;
  var logEntries = [];

  function addLog(type, title, detail) {
    if (!state.enableLog) return;
    var now = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var time = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    logEntries.push({ time: time, type: type, title: title, detail: detail || "" });
    if (logEntries.length > MAX_LOG_ENTRIES) {
      logEntries.shift();
    }
    renderLogView();
  }

  function renderLogView() {
    if (refs.logCollapseBtn) {
      refs.logCollapseBtn.textContent = (state.logCollapsed ? "展开日志" : "折叠日志") + " (" + logEntries.length + ")";
    }
    if (!refs.logContainer) return;
    refs.logContainer.style.display = state.logCollapsed ? "none" : "block";
    refs.logContainer.replaceChildren();
    if (!state.enableLog) {
      refs.logContainer.appendChild(el("div", "n5c-hint", "日志记录已关闭"));
      return;
    }
    if (!logEntries.length) {
      refs.logContainer.appendChild(el("div", "n5c-hint", "暂无日志记录。生图请求、响应与报错将实时记录在此"));
      return;
    }
    logEntries.forEach(function (entry) {
      var item = el("div", "n5c-log-item");
      var head = el("div", "n5c-log-head");
      var badgeCls = entry.type === "error" ? "n5c-log-badge n5c-error" : (entry.type === "success" ? "n5c-log-badge n5c-ok" : "n5c-log-badge");
      var typeLabel = { request: "请求", success: "成功", error: "报错", info: "提示" }[entry.type] || entry.type;
      head.appendChild(el("span", "n5c-log-time", "[" + entry.time + "]"));
      head.appendChild(el("span", badgeCls, "[" + typeLabel + "]"));
      head.appendChild(el("span", "n5c-log-title", entry.title));
      item.appendChild(head);
      if (entry.detail) {
        var pre = el("pre", "n5c-log-detail", entry.detail);
        item.appendChild(pre);
      }
      refs.logContainer.appendChild(item);
    });
    try { refs.logContainer.scrollTop = refs.logContainer.scrollHeight; } catch (e) {}
  }

  var NAI = {
    sampler: function (config) {
      config = config || state;
      var s = config.sampler || NAI_DEFAULTS.sampler;
      /* V5 移除了 ddim 系采样器 */
      if (String(config.model).indexOf("nai-diffusion-5") >= 0 && NAI_DROPPED_SAMPLERS.indexOf(s) >= 0) {
        return NAI_DEFAULTS.sampler;
      }
      return s;
    },

    /* 页面级描述进入 base_caption，竖线后的角色段进入 char_captions。 */
    payload: function (prompt, negative, overrides) {
      var config = Object.assign({}, state, overrides || {});
      var compiled = typeof prompt === "string" ? { base: prompt, characters: [], useCoords: false } : prompt;
      if (!compiled || typeof compiled.base !== "string" || !Array.isArray(compiled.characters)) {
        throw new Error("缺少有效的基础提示词或人物出场槽位");
      }
      var isSpread = /(?:見開きページ|2ページ見開き|見開き)|(?:double-page spread|2-page spread|wide spread)/i.test(compiled.base);
      var width = Number(config.width), height = Number(config.height);
      if (!isValidImageSize(width, height) || refs.sizeDraftInvalid) {
        throw new Error("请修正自定义尺寸：宽高须为 64–2048 之间的 64 倍数");
      }
      if (isSpread && width < height) { var tmp = width; width = height; height = tmp; }
      var characters = compiled.characters.map(function (entry, index) {
        if (typeof entry === "string") entry = { positive: entry };
        var positive = String(entry && entry.positive || "").trim();
        if (!positive) throw new Error("第 " + (index + 1) + " 个人物出场槽位缺少正面提示词");
        return { positive: positive, negative: String(entry.negative || "").trim(), center: clampCenter(entry.center) };
      });
      var captions = characters.map(function (entry) { return { char_caption: entry.positive, centers: [entry.center] }; });
      var negativeCaptions = characters.map(function (entry) { return { char_caption: entry.negative, centers: [entry.center] }; });
      var params = {
        params_version: 3, width: width, height: height,
        scale: Number(config.scale), sampler: this.sampler(config), steps: Number(config.steps),
        seed: config.seed === "" || config.seed == null ? Math.floor(Math.random() * 4294967296) : Number(config.seed),
        n_samples: 1, noise_schedule: "karras",
        cfg_rescale: Number(config.cfgRescale), qualityToggle: false, ucPreset: 3,
        dynamic_thresholding: false, add_original_image: true, legacy: false, legacy_v3_extend: false,
        negative_prompt: negative,
        v4_prompt: {
          caption: { base_caption: compiled.base, char_captions: captions },
          use_coords: compiled.useCoords === true,
          use_order: true
        },
        v4_negative_prompt: {
          caption: { base_caption: negative, char_captions: negativeCaptions },
          legacy_uc: false
        }
      };
      if (params.sampler === "k_euler_ancestral") { params.deliberate_euler_ancestral_bug = false; params.prefer_brownian = true; }
      return { input: compiled.base, model: NAI_DEFAULTS.model, action: "generate", parameters: params, use_new_shared_trial: true };
    },
    generate: async function (prompt, negative, overrides) {
      var config = Object.assign({}, state, overrides || {});
      config.naiToken = String(config.naiToken || "").trim();
      if (!config.naiToken) throw new Error("未填写 NovelAI Key");

      var endpoint = naiEndpoint(config);
      var payloadObj = this.payload(prompt, negative, config);
      var startTime = Date.now();

      // 记录发送给 NovelAI 的中文日志
      try {
        var styleItem = config.lib ? styleItemOf(config.lib) : null;
        var pagePrefix = config.pageNo ? ("第 " + config.pageNo + (config.totalPages ? "/" + config.totalPages : "") + " 页：") : "";

        var connInfo = config.connectionName ? ("【API 连接】" + config.connectionName + (config.isRotated ? "（账号轮询）" : "") + "\n") : "";
        var reqSummary = connInfo + "【目标地址】" + endpoint + "\n" +
          "【模型与尺寸】" + config.model + " | " + config.width + "×" + config.height + "\n" +
          "【采样配置】采样器: " + config.sampler + " | 步数: " + config.steps + " | 引导值: " + config.scale +
          (Number(config.cfgRescale) ? " | 缩放引导值: " + config.cfgRescale : "") +
          " | 种子: " + (payloadObj.parameters.seed || "随机") + "\n" +
          "【画风】" + (styleItem ? styleItem.label : "（未配置）") + "\n" +
          "【画风固定正面词】\n" + (styleItem ? styleItem.positive : "（无）") + "\n" +
          "【画风固定负面词】\n" + (styleItem ? styleItem.negative : "（无）") + "\n" +
          "【结构化正面提示词】\n" + JSON.stringify(payloadObj.parameters.v4_prompt.caption, null, 2) + "\n" +
          "【最终负面提示词】\n" + (payloadObj.parameters.negative_prompt || "（无）");
        addLog("request", pagePrefix + "发送 NovelAI 生图请求", reqSummary);
      } catch (logErr) {
        warn("记录生图请求日志异常", logErr);
      }

      var res;
      try {
        res = await hostFetch(endpoint, {
          method: "POST", signal: config.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.naiToken },
          body: JSON.stringify(payloadObj)
        });
      } catch (networkErr) {
        if (networkErr.name === "AbortError") {
          addLog("info", "生图请求已由用户中止", "中止耗时: " + ((Date.now() - startTime) / 1000).toFixed(1) + "秒");
        } else {
          addLog("error", "网络连接异常", networkErr.message || String(networkErr));
        }
        throw networkErr;
      }

      var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (!res.ok) {
        var errDetail = "";
        try {
          var errText = await res.text();
          var errJson = JSON.parse(errText);
          errDetail = errJson.message || errJson.error || errText;
        } catch (e) {
          errDetail = errText || "";
        }
        if (errDetail) {
          errDetail = String(errDetail).slice(0, 300).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
        }
        var msg = "NovelAI 请求失败（HTTP " + res.status + "）" + (errDetail ? "：" + errDetail : "，请检查连接与参数");
        addLog("error", pagePrefix + "NovelAI 返回 HTTP " + res.status, "耗时: " + elapsed + "秒\n服务端报错: " + (errDetail || "无详细信息"));
        throw new Error(msg);
      }

      var arrayBuf = await res.arrayBuffer();
      var png = await ZIP.firstFile(arrayBuf);
      var imgSizeKb = (png.byteLength / 1024).toFixed(1);
      addLog("success", pagePrefix + "NovelAI 生图成功", "耗时: " + elapsed + "秒 | 压缩包大小: " + (arrayBuf.byteLength / 1024).toFixed(1) + "KB | 导出图片大小: " + imgSizeKb + "KB");
      await cacheGeneratedImage(png);
      return { base64: bytesToBase64(png) };
    },
  };

  /* ------------------------------------------------------------
   * 图片入库
   * 先存进酒馆的 user images 拿相对路径；上传不可用时退回内联
   * data URL，代价是聊天文件会被撑大。
   * ---------------------------------------------------------- */
  async function storeImage(base64, tag, signal) {
    try {
      var res = await hostFetch("/api/images/upload", {
        signal: signal,
        method: "POST",
        headers: await stHeaders(),
        body: JSON.stringify({
          image: base64,
          format: "png",
          ch_name: "nai5-comic",
          filename: "comic-" + tag + "-" + Date.now(),
        }),
      });
      if (res.ok) {
        var data = await res.json();
        if (data && data.path) return data.path;
      }
      warn("图片上传失败，退回内联 data URL");
    } catch (e) {
      warn("图片上传异常，退回内联 data URL", e);
    }
    return "data:image/png;base64," + base64;
  }

  /* ------------------------------------------------------------
   * 楼层读写与回填
   * ---------------------------------------------------------- */
    function detectComicMessageMode(message) {
    var text = String(message || "");
    var roundThinking = /<thinking\b[^>]*>([\s\S]*?)<\/thinking>/i.exec(text);
    var roundComic = /<comic_plan\b[^>]*>([\s\S]*?)<\/comic_plan>/i.exec(text);
    if (roundThinking && /(?:^|\n)\s*-\s*角色DNA\s*[:：]/m.test(roundThinking[1])) return "new";
    if (roundComic && /(?:^|\n)\s*-\s*角色母表\s*[:：]/m.test(roundComic[1])) return "legacy";
    if (roundThinking && roundComic) return roundThinking.index < roundComic.index ? "new" : "legacy";
    return "legacy";
  }

  function pagePlanTag(message) { return detectComicMessageMode(message) === "new" ? "comic_plan" : "thinking"; }

  function parsePageBlocks(message, pageNo) {
    var pNo = Number(pageNo), text = String(message || "");
    if (!Number.isInteger(pNo) || pNo < 1) return { ok: false, reason: "无效页码" };
    var matches = [], m, imageRegex = /<image\b[^>]*>([\s\S]*?)<\/image>/gi;
    while ((m = imageRegex.exec(text)) !== null) matches.push({ inner: (m[1] || "").trim(), start: m.index, end: imageRegex.lastIndex });
    if (pNo > matches.length) return { ok: false, reason: "未找到第 " + pNo + " 页分镜" };
    var mode = detectComicMessageMode(text), tag = mode === "new" ? "comic_plan" : "thinking";
    var prevEnd = pNo > 1 ? matches[pNo - 2].end : 0;
    var segment = text.slice(prevEnd, matches[pNo - 1].start);
    var rx = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi"), last = null;
    while ((m = rx.exec(segment)) !== null) last = { inner: (m[1] || "").trim(), index: m.index, raw: m[0] };
    return { ok: true, mode: mode, planTag: tag, planningInner: last ? last.inner : "", thinkingInner: last ? last.inner : "", imageInner: matches[pNo - 1].inner, hasThinking: !!last };
  }

  function updatePageBlocks(message, pageNo, newPlanning, newImage) {
    var pNo = Number(pageNo), text = String(message || "");
    if (!Number.isInteger(pNo) || pNo < 1 || !text) throw new Error("无效参数");
    var matches = [], m, imageRegex = /<image\b[^>]*>([\s\S]*?)<\/image>/gi;
    while ((m = imageRegex.exec(text)) !== null) matches.push({ start: m.index, end: imageRegex.lastIndex });
    if (pNo > matches.length) throw new Error("未找到第 " + pNo + " 页分镜");
    var target = matches[pNo - 1], prevEnd = pNo > 1 ? matches[pNo - 2].end : 0;
    var segment = text.slice(prevEnd, target.start), tag = pagePlanTag(text);
    var rx = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi"), last = null;
    while ((m = rx.exec(segment)) !== null) last = { index: m.index, length: m[0].length };
    var cleanPlanning = String(newPlanning == null ? "" : newPlanning).trim();
    var image = "<image>\n" + String(newImage == null ? "" : newImage).trim() + "\n</image>";
    if (last) {
      var newSegment = segment.slice(0, last.index) + "<" + tag + ">\n" + cleanPlanning + "\n</" + tag + ">" + segment.slice(last.index + last.length);
      return text.slice(0, prevEnd) + newSegment + image + text.slice(target.end);
    }
    var insert = cleanPlanning ? "<" + tag + ">\n" + cleanPlanning + "\n</" + tag + ">\n" : "";
    return text.slice(0, target.start) + insert + image + text.slice(target.end);
  }

  function extractRoundPlan(message) {
    var text = String(message || ""), mode = detectComicMessageMode(text), tag = mode === "new" ? "thinking" : "comic_plan";
    var rx = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i"), m = rx.exec(text);
    return m ? { mode: mode, tag: tag, inner: String(m[1] || "").trim() } : null;
  }

  function buildPageRerollReference(message, pageNo, currentPlanning, currentImage) {
    var source = String(message || ""), round = extractRoundPlan(source);
    if (!round || !round.inner) throw new Error("当前消息缺少整轮规划，无法建立角色与连续性参考");
    var pageCount = (source.match(/<image\b[^>]*>[\s\S]*?<\/image>/gi) || []).length;
    var target = Number(pageNo);
    if (!Number.isInteger(target) || target < 1 || target > pageCount) throw new Error("目标页不在当前消息的页面范围内");
    var tag = round.mode === "new" ? "comic_plan" : "thinking", pages = [];
    for (var index = 1; index <= pageCount; index++) {
      var page = parsePageBlocks(source, index);
      if (!page.ok) throw new Error(page.reason || ("读取第 " + index + " 页失败"));
      var planning = index === target ? String(currentPlanning || "").trim() : page.planningInner;
      var image = index === target ? String(currentImage || "").trim() : page.imageInner;
      pages.push("<page_reference page=\"" + index + "\">\n<" + tag + ">\n" + planning + "\n</" + tag + ">\n<image>\n" + image + "\n</image>\n</page_reference>");
    }
    return "<comic_reroll_reference readonly=\"true\">\n<" + round.tag + ">\n" + round.inner + "\n</" + round.tag + ">\n\n" + pages.join("\n\n") + "\n</comic_reroll_reference>";
  }

  function buildPageRerollRequest(pageNo, sourceMessage, currentPlanning, currentImage, customRequirement) {
    var pNo = Number(pageNo), mode = detectComicMessageMode(sourceMessage);
    var requirement = String(customRequirement || "").trim() || "保持人物、衣着、场景和剧情连续，优化目标页的分镜构图与提示词。";
    var tag = mode === "new" ? "comic_plan" : "thinking";
    var identity = mode === "new" ? "角色DNA" : "角色母表";
    return { mode: mode, reference: buildPageRerollReference(sourceMessage, pNo, currentPlanning, currentImage), userPrompt:
      "你正在执行单页漫画重roll。只读参考资料已放入聊天历史，不得复述、改写或输出其他页面与整轮规划。\n" +
      "只重写第 " + pNo + " 页：必须且只能输出一组 <" + tag + ">...</" + tag + "> 和一组 <image>...</image>。\n" +
      "<image> 使用 v1.2 分段文本协议：@page 后按 @panel 编号、@character 编号组织；人物正面词接在人物标记后，独立负面词用 @negative，页面或画格非人物内容用 @non_character；无人物的格只写画格段。自动定位省略坐标，手动定位在 @page 前写 @position manual，并为每个人物写 @center x,y。不要输出 JSON。\n" +
      "沿用只读参考中的" + identity + "、已生效外观变化、画风、色彩、对白语言及连续状态。可见人物必须在其所属画格独立写出本镜头可见的完整外观及衣着，不得用编号或前格代替。\n" +
      "用户对第 " + pNo + " 页的要求：" + requirement };
  }

  function parseRerollResponse(responseText, mode) {
    var text = String(responseText || "").trim();
    if (!text) return { ok: false, error: "AI 返回内容为空" };
    var expected = mode === "new" ? "comic_plan" : "thinking";
    var thinking = text.match(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi) || [];
    var comic = text.match(/<comic_plan\b[^>]*>[\s\S]*?<\/comic_plan>/gi) || [];
    var images = text.match(/<image\b[^>]*>[\s\S]*?<\/image>/gi) || [];
    var tag = mode === "legacy" && !thinking.length && comic.length === 1 ? "comic_plan" : expected;
    if (images.length !== 1 || thinking.length + comic.length !== 1 || (tag === "thinking" ? thinking.length !== 1 : comic.length !== 1)) {
      return { ok: false, error: "单页输出必须恰好包含一组页面规划与一组 <image>，不能混入整轮规划或其他页" };
    }
    var plans = tag === "thinking" ? thinking : comic;
    var plan = plans[0].replace(new RegExp("^<" + tag + "\\b[^>]*>|<\\/" + tag + ">$", "gi"), "").trim();
    var pageHeadings = plan.match(/\[Page\s+\d+\s*\]/gi) || [];
    if (/(?:^|\n)\s*-\s*(?:角色母表|角色DNA|戏剧节拍|本轮外观变化|规划总页数|逐页剧情分配契约)\s*[:：]/m.test(plan) || pageHeadings.length > 1) {
      return { ok: false, error: "返回的页面规划含有整轮规划或多个页面，已停止回填" };
    }
    var image = images[0].replace(/^<image\b[^>]*>|<\/image>$/gi, "").trim();
    var parsed = parseImageBlock(image);
    if (!parsed.ok || !parsed.structured || !parsed.nested) return { ok: false, error: parsed.reason || "重roll结果不是有效的按格嵌套人物协议" };
    if (parsed.wireFormat !== "sections") image = serializeSectionImageProtocol(parsed.raw);
    return { ok: true, thinking: plan, planning: plan, image: image };
  }

  async function callRerollPresetApi(request, imageUrl) {
    if (hostApi.director) return hostApi.director.reroll(request, imageUrl);
    var gen = getBoundFunction("generate");
    if (!gen || typeof gen.fn !== "function") {
      throw new Error("当前酒馆环境不支持预设生成接口 generate；为避免丢失漫画预设规则，已停止重roll，不会退回简化生成");
    }
    var generationId = "nai5-reroll-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    async function executeCall(withImage) {
      var options = {
        preset_name: (await PresetAdapter.presetName()) || REROLL_PRESET_NAME,
        user_input: request.userPrompt,
        generation_id: generationId,
        should_silence: true,
        max_chat_history: 0,
        overrides: {
          chat_history: {
            with_depth_entries: true,
            prompts: [{ role: "system", content: request.reference }]
          }
        }
      };
      if (withImage && imageUrl) options.image = imageUrl;
      var result = await gen.fn(options);
      if (typeof result === "string") return result;
      if (result && typeof result.text === "string") return result.text;
      if (result && typeof result.content === "string") return result.content;
      return String(result || "");
    }
    if (!imageUrl) return executeCall(false);
    try {
      return await executeCall(true);
    } catch (error) {
      var message = String(error && (error.message || error)).toLowerCase();
      if (message.includes("image") || message.includes("vision") || message.includes("multimodal") || message.includes("unsupported")) {
        toast("当前文字模型不支持图片参考，已保留同轮文本参考并改用纯文本重roll", "info");
        return executeCall(false);
      }
      throw error;
    }
  }

  function extractBlocks(message) {
    var blocks = [];
    var text = String(message || "");
    var m;
    IMAGE_BLOCK_RE.lastIndex = 0;
    while ((m = IMAGE_BLOCK_RE.exec(text)) !== null) {
      var inner = (m[1] || "").trim();
      if (inner) blocks.push({ raw: m[0], inner: inner, index: m.index });
    }
    return blocks;
  }

  /* 块后面紧跟的图片容器，既是幂等标记也是重生时要替换的目标。
     返回值带上前导空白的原文，重画时才能整段精确替换。 */
  function boxAfter(text, blockRaw) {
    var idx = text.indexOf(blockRaw);
    if (idx < 0) return null;
    var rest = text.slice(idx + blockRaw.length);
    var m = rest.match(/^(?:\s*<div\b[^>]*\b(?:custom-)?n5c-page\b[^>]*>[\s\S]*?<\/div>)+/i);
    return m ? m[0] : null;
  }

  var MAX_PAGE_HISTORY = 5;

  var MAX_PAGE_HISTORY = 5;

  var backfillQueue = Promise.resolve();
  function enqueueBackfill(messageId, fn) {
    var p = backfillQueue.then(fn);
    backfillQueue = p.catch(function (err) {
      warn("回填写入异常: " + (err && err.message));
    });
    return p;
  }

  function safeBackfillPage(messageId, blockRaw, pageNo, imageSrc) {
    return enqueueBackfill(messageId, async function () {
      var cur = await readMessage(messageId);
      var text = cur.message || "";
      if (text.indexOf(blockRaw) < 0) return;
      var old = boxAfter(text, blockRaw);
      var oldSrc = parseBoxActiveSrc(old);
      var history = parseBoxHistory(old);
      if (oldSrc && history.indexOf(oldSrc) < 0) history.push(oldSrc);
      if (history.length > MAX_PAGE_HISTORY) history = history.slice(history.length - MAX_PAGE_HISTORY);
      var target = old ? blockRaw + old : blockRaw;
      var isSpread = /(?:見開きページ|2ページ見開き|見開き)|(?:double-page spread|2-page spread|wide spread)/i.test(blockRaw);
      var nextText = text.replace(target, blockRaw + "\n" + pageBox(pageNo, imageSrc, history, isSpread));
      await writeMessage(messageId, nextText);
    });
  }

  function runWithConcurrency(items, limit, workerFn) {
    var results = new Array(items.length);
    var index = 0;
    var executing = [];
    function enqueue() {
      if (index >= items.length) return Promise.resolve();
      var i = index++;
      var p = Promise.resolve().then(function () {
        return workerFn(items[i], i);
      }).then(function (res) {
        results[i] = res;
      });
      executing.push(p);
      var clean = function () {
        var idx = executing.indexOf(p);
        if (idx >= 0) executing.splice(idx, 1);
      };
      p.then(clean, clean);
      var next = executing.length >= limit ? Promise.race(executing) : Promise.resolve();
      return next.then(enqueue);
    }
    var starters = [];
    for (var c = 0; c < limit && c < items.length; c++) {
      starters.push(enqueue());
    }
    return Promise.all(starters).then(function () {
      return Promise.all(executing);
    }).then(function () {
      return results;
    });
  }

  function parsePageHistory(pageEl) {
    if (!pageEl) return [];
    var attr = pageEl.getAttribute("data-n5c-history") || "";
    if (!attr) return [];
    try {
      var arr = JSON.parse(decodeURIComponent(attr));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function parseBoxHistory(boxHtml) {
    if (!boxHtml) return [];
    var m = boxHtml.match(/data-n5c-history="([^"]*)"/);
    if (!m) return [];
    try {
      var arr = JSON.parse(decodeURIComponent(m[1]));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function parseBoxActiveSrc(boxHtml) {
    if (!boxHtml) return "";
    var m = boxHtml.match(/<img[^>]+src="([^">]+)"/);
    return m ? m[1] : "";
  }

  // 楼层里只存相对路径：绝对本机地址（127.0.0.1 等）换到其他设备访问时会指向访问者自己
  function isLoopbackHost(host) {
    var h = String(host || "").toLowerCase();
    return h === "localhost" || h === "0.0.0.0" || h === "[::1]" || h === "::1" || /^127\./.test(h);
  }
  function toStoredImageUrl(u) {
    if (!u || typeof u !== "string" || !/^https?:\/\//i.test(u)) return u;
    try {
      var loc = Env.pwin.location, url = new Env.pwin.URL(u);
      if (url.origin === loc.origin || (isLoopbackHost(url.hostname) && /^\/user\//.test(url.pathname))) {
        return url.pathname + url.search + url.hash;
      }
    } catch (e) {}
    return u;
  }

  function pageBox(pageNo, src, historyList, isSpread) {
    src = toStoredImageUrl(src);
    if (Array.isArray(historyList)) historyList = historyList.map(toStoredImageUrl).filter(function (u, i, arr) { return u && arr.indexOf(u) === i; });
    var historyAttr = "";
    if (Array.isArray(historyList) && historyList.length) {
      historyAttr = ' data-n5c-history="' + encodeURIComponent(JSON.stringify(historyList)) + '"';
    }
    var cls = "n5c-page" + (isSpread ? " n5c-landscape" : "");
    return '<div class="' + cls + '" data-n5c-page="' + pageNo + '"' + historyAttr + '>' +
      '<img src="' + src + '" alt="漫画第' + pageNo + '页" ' +
      'class="n5c-page-image" draggable="false">' +
      "</div>";
  }

  function downloadImage(url, filename) {
    try {
      var a = Env.pdoc.createElement("a");
      a.href = url;
      a.download = filename || "manga-page.png";
      a.target = "_blank";
      Env.pdoc.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { a.remove(); } catch (e) {}
      }, 200);
    } catch (e) {
      warn("下载图片失败", e);
    }
  }

  async function switchPageActiveImage(messageId, pageNo, selectedUrl) {
    if (!selectedUrl) return false;
    try {
      if (messageId == null) messageId = await latestMessageId();
      var ok = false;
      await enqueueBackfill(messageId, async function () {
        var msg = await readMessage(messageId);
        var blocks = extractBlocks(msg.message || "");
        if (pageNo < 1 || pageNo > blocks.length) throw new Error("未找到对应分镜");
        var block = blocks[pageNo - 1];
        var text = msg.message || "";
        var old = boxAfter(text, block.raw);
        if (!old) throw new Error("未找到当前图片容器");

        var oldSrc = parseBoxActiveSrc(old);
        var history = parseBoxHistory(old);
        var all = history.slice();
        if (oldSrc && all.indexOf(oldSrc) < 0) all.push(oldSrc);
        all = all.filter(function (u) { return u !== selectedUrl; });
        if (all.length > MAX_PAGE_HISTORY) all = all.slice(all.length - MAX_PAGE_HISTORY);

        var isSpread = /\bn5c-landscape\b/.test(old.split(">", 1)[0]) || /(?:見開きページ|2ページ見開き|見開き)|(?:double-page spread|2-page spread|wide spread)/i.test(block.inner);
        var nextBox = pageBox(pageNo, selectedUrl, all, isSpread);
        var nextText = text.replace(old, nextBox);
        await writeMessage(messageId, nextText);
        ok = true;
      });
      if (ok) {
        addLog("info", "切换第 " + pageNo + " 页显示版本", "当前显示已更新为历史选定图片");
        return true;
      }
      return false;
    } catch (e) {
      addLog("error", "切换版本失败", e.message || String(e));
      return false;
    }
  }

  var sessionEpoch = 0;
  var taskIdCounter = 0;
  var activePageTasks = new Map();
  var redrawJobs = new Map();
  var recentCompletedPages = new Map();
  var currentBatchTask = null;

  function pageTaskKey(messageId, pageNo) {
    return String(messageId) + "-" + String(pageNo);
  }

  async function generatePage(messageId, pageNo, block, totalPages, lib, isManual, parentSignal, charDict) {
    var key = pageTaskKey(messageId, pageNo);
    var epochAtStart = sessionEpoch;
    var AbortCtrl = (Env.pwin && Env.pwin.AbortController) || (typeof AbortController !== "undefined" ? AbortController : null);
    var controller = new AbortCtrl();
    var onParentAbort = function () { try { controller.abort(); } catch (e) {} };
    if (parentSignal) {
      if (parentSignal.aborted) { onParentAbort(); }
      else { parentSignal.addEventListener("abort", onParentAbort, { once: true }); }
    }

    var pageTask = {
      id: ++taskIdCounter,
      key: key,
      messageId: messageId,
      pageNo: pageNo,
      controller: controller,
      isManual: !!isManual,
      status: "running"
    };

    var resolvePromise, rejectPromise;
    pageTask.promise = new Promise(function (resolve, reject) {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // A shared page promise may have no secondary waiter when cancelled.
    pageTask.promise.catch(function () {});
    activePageTasks.set(key, pageTask);
    syncBusyUi();

    var connLease = null;
    try {
      setPlaceholderState(messageId, pageNo, "queued");
      if (isManual) {
        setStatus("正在排队重画第 " + pageNo + " 页…", "");
        
      }

      if ((typeof charDict === "undefined" || !charDict) && messageId != null) {
        try {
          var curMsg = await readMessage(messageId);
          if (curMsg && curMsg.message) {
            charDict = extractCharacterDictionary(curMsg.message, pageNo);
          }
        } catch (e) {}
      }
      var promptInner = charDict ? applyCharacterVariables(block.inner, charDict) : block.inner;
      var parsed = parseImageBlock(promptInner);
      if (!parsed.ok) throw new Error(parsed.reason);

      connLease = await acquireGenerationConnection(isManual, controller.signal);
      setPlaceholderState(messageId, pageNo, "loading");
      if (isManual) {
        setStatus("正在重画第 " + pageNo + " 页…", "");
      }
      var conn = connLease;
      var assembled = assemblePrompt(parsed, lib), neg = buildNegative(lib);

      var result = await taskStep(pageTask, (isManual ? "第 " + pageNo + " 页单页重画" : "第 " + pageNo + " 页生图"), function () {
        return NAI.generate(assembled, neg.value, {
          signal: controller.signal,
          lib: lib,
          pageNo: pageNo,
          totalPages: totalPages,
          channel: conn.channel,
          customUrl: conn.customUrl,
          naiToken: conn.naiToken,
          connectionName: conn.name,
          isRotated: conn.isRotated
        });
      }, GENERATION_TIMEOUT_MS);

      if (sessionEpoch !== epochAtStart || lifecycle.destroyed) {
        throw taskAbortError(pageTask);
      }

      var imageSrc = await taskStep(pageTask, "保存图片", function () {
        return storeImage(result.base64, messageId + "-" + pageNo + "-" + Date.now(), controller.signal);
      }, HOST_TIMEOUT_MS);

      if (sessionEpoch !== epochAtStart || lifecycle.destroyed) {
        throw taskAbortError(pageTask);
      }

      var historyLen = 0;
      await taskStep(pageTask, "回填漫画图片", function () {
        return enqueueBackfill(messageId, async function () {
          if (sessionEpoch !== epochAtStart || lifecycle.destroyed) return;
          var cur = await readMessage(messageId);
          if (sessionEpoch !== epochAtStart || lifecycle.destroyed) throw taskAbortError(pageTask);
          var text = cur.message || "";
          if (text.indexOf(block.raw) < 0) throw new Error("原提示词已变化，本页不回填");
          var old = boxAfter(text, block.raw);
          var oldSrc = parseBoxActiveSrc(old);
          var history = parseBoxHistory(old);
          if (oldSrc && history.indexOf(oldSrc) < 0) history.push(oldSrc);
          if (history.length > MAX_PAGE_HISTORY) history = history.slice(history.length - MAX_PAGE_HISTORY);
          historyLen = history.length;
          var target = old ? block.raw + old : block.raw;
          var isSpread = /(?:見開きページ|2ページ見開き|見開き)|(?:double-page spread|2-page spread|wide spread)/i.test(block.inner);
          var nextText = text.replace(target, block.raw + "\n" + pageBox(pageNo, imageSrc, history, isSpread));
          await writeMessage(messageId, nextText);
        });
      }, HOST_TIMEOUT_MS);

      pageTask.status = "done";
      recentCompletedPages.set(key, Date.now());
      if (isManual) {
        setStatus("第 " + pageNo + " 页重画完成", "ok");
        
        addLog("success", "第 " + pageNo + " 页重画成功", "楼层: #" + messageId + " | 原图已进入历史版本（历史总数: " + historyLen + " 张）");
      }
      var out = { pageNo: pageNo, imageSrc: imageSrc, success: true };
      resolvePromise(out);
      return out;
    } catch (e) {
      pageTask.status = "error";
      if (e.name === "AbortError" || controller.signal.aborted) {
        setPlaceholderState(messageId, pageNo, "idle");
        if (isManual) setStatus("第 " + pageNo + " 页重画已中止", "");
      } else {
        setPlaceholderState(messageId, pageNo, "error", e.message || "生成失败");
        if (isManual) {
          setStatus("第 " + pageNo + " 页重画失败：" + e.message, "error");
          
          addLog("error", "第 " + pageNo + " 页重画失败", e.message || String(e));
        }
      }
      rejectPromise(e);
      throw e;
    } finally {
      if (connLease && typeof connLease.release === "function") {
        try { connLease.release(); } catch (relErr) {}
      }
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
      activePageTasks.delete(key);
      syncBusyUi();
    }
  }

  async function redrawSinglePage(messageId, pageNo) {
    if (messageId == null) messageId = await latestMessageId();
    var key = pageTaskKey(messageId, pageNo);
    var pending = redrawJobs.get(key);
    if (pending) return pending.promise;
    var existing = activePageTasks.get(key);
    if (existing && existing.status === "running") return existing.promise;

    var work = (async function () {
      var msg = await readMessage(messageId);
      var blocks = extractBlocks(msg.message || "");
      if (pageNo < 1 || pageNo > blocks.length) {
        throw new Error("楼层 #" + messageId + " 中未找到第 " + pageNo + " 页分镜");
      }
      var block = blocks[pageNo - 1];
      var lib = await PromptLibrary.load(true);
      if (!lib.ok) throw new Error(lib.reason || "无法读取当前提示词库");
      var charDict = extractCharacterDictionary(msg.message || "", pageNo);
      return generatePage(messageId, pageNo, block, blocks.length, lib, true, null, charDict);
    })();
    redrawJobs.set(key, { promise: work, messageId: messageId, pageNo: pageNo });
    syncRedrawOverlay(messageId, pageNo, true);
    try {
      return await work;
    } finally {
      redrawJobs.delete(key);
      syncRedrawOverlay(messageId, pageNo, false);
    }
  }

  function openPageHistoryDialog(target) {
    if (!target) return;
    var pageEl = target.closest(".n5c-page, .custom-n5c-page, [data-n5c-page]");
    var pageNo = pageEl ? Number(pageEl.getAttribute("data-n5c-page")) : 1;
    var mesEl = target.closest(".mes[mesid]") || target.closest("[mesid]");
    var messageId = mesEl ? mesEl.getAttribute("mesid") : null;

    var currentSrc = target.tagName === "IMG" ? (target.getAttribute("src") || target.src || "") : "";
    var history = parsePageHistory(pageEl);

    var allVersions = [];
    history.forEach(function (url) {
      if (url && allVersions.indexOf(url) < 0) allVersions.push(url);
    });
    if (currentSrc && allVersions.indexOf(currentSrc) < 0) {
      allVersions.push(currentSrc);
    }
    if (!allVersions.length && currentSrc) {
      allVersions = [currentSrc];
    }

    var activeUrl = currentSrc;
    var previewIndex = allVersions.indexOf(activeUrl);
    if (previewIndex < 0) previewIndex = allVersions.length ? allVersions.length - 1 : -1;

    var oldDialog = Env.pdoc.getElementById("n5c-history-dialog");
    if (oldDialog) oldDialog.remove();

    var mask = el("div", "n5c-history-mask");
    mask.id = "n5c-history-dialog";
    var modal = el("div", "n5c-history-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "第 " + pageNo + " 页版本管理");

    var head = el("div", "n5c-history-head");
    var title = el("span", "n5c-history-title", "第 " + pageNo + " 页历史版本 (" + allVersions.length + " 个)");
    var closeBtn = iconButton("close", "关闭", function () { mask.remove(); });
    head.append(title, closeBtn);
    modal.appendChild(head);

    var scroll = el("div", "n5c-history-scroll");
    modal.appendChild(scroll);
    var stage = el("div", "n5c-history-stage");
    var previewBox = el("div", "n5c-history-preview-box");
    var imgWrap = el("div", "n5c-history-img-wrap");
    var previewImg = el("img", "n5c-history-preview-img");
    if (previewIndex >= 0) previewImg.src = allVersions[previewIndex];
    previewImg.alt = "预览图片";
    imgWrap.appendChild(previewImg);
    var emptyState = el("div", "n5c-history-empty", "此页还没有图片版本。可先编辑规划与提示词，再重 roll 或生图。");
    imgWrap.appendChild(emptyState);
    var badge = el("div", "n5c-history-badge");
    previewBox.append(imgWrap, badge);
    var zoomLayer = null;
    function closeZoom() { if (zoomLayer) { zoomLayer.remove(); zoomLayer = null; } }
    previewImg.addEventListener("dblclick", function (event) {
      if (!activeUrl || allVersions[previewIndex] !== activeUrl) return;
      event.preventDefault(); event.stopPropagation();
      closeZoom();
      zoomLayer = el("div", "n5c-history-zoom");
      zoomLayer.setAttribute("role", "dialog");
      zoomLayer.setAttribute("aria-label", "放大查看当前图片");
      var enlarged = el("img", "n5c-history-zoom-image");
      enlarged.src = activeUrl;
      enlarged.alt = "当前显示的图片（放大）";
      enlarged.addEventListener("click", function (e) { e.stopPropagation(); });
      enlarged.addEventListener("dblclick", function (e) { e.preventDefault(); e.stopPropagation(); closeZoom(); });
      zoomLayer.addEventListener("click", function (e) { if (e.target === zoomLayer) closeZoom(); });
      zoomLayer.appendChild(enlarged);
      mask.appendChild(zoomLayer);
    });

    var thumbs = el("div", "n5c-history-thumbs");
    var thumbEls = [];

    stage.append(previewBox, thumbs);
    scroll.appendChild(stage);

    if (allVersions.length <= 1) {
      thumbs.style.display = "none";
    }

    var actions = el("div", "n5c-history-actions");
    var dlBtn = button("下载图片", null);
    var redrawBtn = button("重画此页", null);
    modal.appendChild(actions);

    var switchingImage = false;
    function updateView() {
      var curUrl = previewIndex >= 0 ? allVersions[previewIndex] : "";
      if (curUrl) previewImg.src = curUrl;
      previewImg.hidden = !curUrl;
      emptyState.hidden = !!curUrl;
      dlBtn.disabled = !curUrl || switchingImage;
      badge.textContent = !curUrl ? "尚无图片版本" : (curUrl === activeUrl ? "【当前正在显示的图片】" : "【历史版本 #" + (previewIndex + 1) + "】");
      thumbEls.forEach(function (t, i) {
        t.classList.toggle("n5c-on", i === previewIndex);
        t.style.pointerEvents = switchingImage ? "none" : "";
      });
    }

    if (allVersions.length > 1) {
      allVersions.forEach(function (url, idx) {
        var t = el("img", "n5c-history-thumb" + (idx === previewIndex ? " n5c-on" : ""));
        t.src = url;
        t.alt = "版本" + (idx + 1);
        t.title = (url === activeUrl ? "当前版本 #" : "历史版本 #") + (idx + 1);
        t.addEventListener("click", async function () {
          if (switchingImage || url === activeUrl) return;
          var previousIndex = previewIndex;
          switchingImage = true;
          previewIndex = idx;
          updateView();
          var ok = await switchPageActiveImage(messageId, pageNo, url);
          if (ok) {
            activeUrl = url;
            if (target.tagName === "IMG" && target.isConnected) target.src = url;
          } else {
            previewIndex = previousIndex;
          }
          switchingImage = false;
          updateView();
        });
        thumbEls.push(t);
        thumbs.appendChild(t);
      });
    }

    dlBtn.addEventListener("click", function () {
      downloadImage(allVersions[previewIndex], "manga-page-" + pageNo + "-v" + (previewIndex + 1) + ".png");
    });

        var initialThinking = "";
    var initialImage = "";
    var isLoaded = false;

    var editorCard = el("div", "n5c-history-editor-card");
    var editorHead = el("div", "n5c-history-editor-head");
    var editorTitle = el("span", null, "本页规划与提示词");
    var editorStatus = el("span", "n5c-history-editor-status", "正在读取楼层数据…");
    editorHead.append(editorTitle, editorStatus);

    var thinkingLabel = el("label", "n5c-history-editor-label", "本页规划（可选）");
    var thinkingArea = el("textarea", "n5c-history-textarea");
    thinkingArea.rows = 4;
    thinkingArea.placeholder = "读取中…";

    var imageLabel = el("label", "n5c-history-editor-label", "<image> 生图提示词");
    var imageArea = el("textarea", "n5c-history-textarea");
    imageArea.rows = 4;
    imageArea.id = "n5c-image-protocol-draft";
    imageLabel.htmlFor = imageArea.id;
    imageArea.placeholder = "读取中…";

    var slotCard = el("div", "n5c-history-editor-card");
    slotCard.style.marginTop = "10px";
    var slotHead = el("div", "n5c-history-editor-head");
    var slotTitle = el("span", null, "人物出场提示词与定位");
    var slotStatus = el("span", "n5c-history-editor-status", "读取 <image>…");
    slotHead.append(slotTitle, slotStatus);
    var slotBody = el("div", "n5c-v83-slot-body");
    slotCard.append(slotHead, slotBody);

    var formLayout = el("div", "n5c-history-form-layout");
    var previewPane = el("div", "n5c-history-editor-card n5c-history-request-pane");
    var requestPreview = el("pre", "n5c-history-request-preview", "正在读取请求配置…");
    previewPane.append(el("div", "n5c-history-editor-label", "实际 NovelAI 请求提示词（只读）"), requestPreview);
    formLayout.append(slotBody, previewPane);
    slotCard.appendChild(formLayout);
    PromptLibrary.invalidate();
    var previewSequence = 0;
    function readV83EditorDraft() {
      var body = String(imageArea.value || "").trim();
      if (isSectionImageProtocol(body)) {
        var draft = readSectionImageData(body);
        return draft.ok ? draft.data : null;
      }
      try {
        var data = JSON.parse(body);
        return data && data.format === "nai5-comic" ? data : null;
      } catch (e) { return null; }
    }
    function isNestedEditor(data) {
      return data && Array.isArray(data.panels) && !Object.prototype.hasOwnProperty.call(data, "characters") &&
        data.panels.every(function (p) { return p && Array.isArray(p.characters); });
    }
    async function refreshRequestPreview() {
      var revision = ++previewSequence;
      try {
        var parsed = parseImageBlock(imageArea.value);
        if (!parsed.ok || !parsed.nested) throw new Error(parsed.reason || "本页不是按格协议");
        var lib = await PromptLibrary.load(false);
        if (!lib.ok) throw new Error(lib.reason || "无法读取当前画风");
        var assembled = assemblePrompt(parsed, lib);
        var negative = buildNegative(lib);
        var request = NAI.payload(assembled, negative.value);
        if (revision !== previewSequence) return;
        var params = request.parameters;
        requestPreview.textContent = "全局正面词（含当前画风）：\n" + params.v4_prompt.caption.base_caption +
          "\n\n逐人物正面词：\n" + (params.v4_prompt.caption.char_captions.map(function (c, i) { return (i + 1) + ". " + c.char_caption; }).join("\n\n") || "（无）") +
          "\n\n全局负面词（含当前画风 UC）：\n" + params.v4_negative_prompt.caption.base_caption +
          "\n\n逐人物 UC：\n" + (params.v4_negative_prompt.caption.char_captions.map(function (c, i) { return (i + 1) + ". " + (c.char_caption || "（空）"); }).join("\n\n") || "（无）") +
          "\n\n中心点控制：" + (params.v4_prompt.use_coords ? "开启" : "关闭") +
          (params.v4_prompt.use_coords ? "\n" + params.v4_prompt.caption.char_captions.map(function (c, i) { return (i + 1) + ". " + JSON.stringify(c.centers[0]); }).join("\n") : "");
      } catch (e) {
        if (revision === previewSequence) requestPreview.textContent = "请求预览暂不可用：" + (e.message || String(e));
      }
    }
    function writeV83EditorDraft(data) {
      // 只保留按格协议字段；自动定位不产生无效中心点。
      if (isNestedEditor(data)) {
        data.panels.forEach(function (panel) {
          panel.characters.forEach(function (slot) {
            delete slot.id; delete slot.panel;
            if (data.position_mode !== "manual") delete slot.center;
          });
        });
      }
      imageArea.value = isSectionImageProtocol(imageArea.value) ? serializeSectionImageProtocol(data) : JSON.stringify(data, null, 2);
      refreshRequestPreview();
    }
    function field(label, value, onInput, multiline) {
      var wrap = el("div", "n5c-history-field");
      var caption = el("label", "n5c-history-editor-label", label);
      var control = multiline ? el("textarea", "n5c-history-textarea") : input(String(value == null ? "" : value));
      if (multiline) { control.rows = 2; control.value = String(value == null ? "" : value); }
      else control.classList.add("n5c-history-text-input");
      control.addEventListener("input", function () { onInput(control.value); });
      wrap.append(caption, control);
      return wrap;
    }
    function editButton(text, fn) {
      var b = button(text, fn); b.type = "button"; return b;
    }
    function moveWithin(list, index, delta, data) {
      var target = index + delta;
      if (target < 0 || target >= list.length) return;
      var item = list.splice(index, 1)[0]; list.splice(target, 0, item);
      writeV83EditorDraft(data); refreshCharacterSlots();
    }
    function centerField(value, label, onChange) {
      var control = input(String(value));
      control.classList.add("n5c-history-text-input");
      control.type = "number"; control.min = "0"; control.max = "1"; control.step = "0.01"; control.title = label;
      control.addEventListener("change", function () {
        var n = Number(control.value);
        onChange(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5);
      });
      return control;
    }
    function refreshCharacterSlots() {
      var data = readV83EditorDraft(), nested = isNestedEditor(data);
      var textProtocol = isSectionImageProtocol(imageArea.value), hideRaw = nested && !textProtocol;
      imageLabel.textContent = textProtocol ? "原始 <image> 分段文本（与人物表单双向同步）" : "<image> 生图提示词";
      imageLabel.style.display = hideRaw ? "none" : "";
      imageArea.style.display = hideRaw ? "none" : "";
      slotCard.style.display = nested ? "" : "none";
      slotBody.replaceChildren();
      if (!nested) { ++previewSequence; return; }
      var mode = data.position_mode === "manual" ? "manual" : "auto";
      var rows = [];
      data.panels.forEach(function (panel) {
        panel.characters.forEach(function (slot) { rows.push({ panel: panel, slot: slot }); });
      });
      slotStatus.textContent = data.panels.length + " 格 · " + rows.length + " 个角色出场槽位";
      var page = data.page || (data.page = { base: "", non_character: "" });
      slotBody.append(
        field("页面基础词", page.base, function (value) { page.base = value; writeV83EditorDraft(data); }, true),
        field("页面非人物词", page.non_character, function (value) { page.non_character = value; writeV83EditorDraft(data); }, true));
      var modeRow = el("div", "n5c-history-field-row");
      modeRow.append(el("span", "n5c-hint", "人物定位："), select([{ id: "auto", label: "自动安排" }, { id: "manual", label: "手动中心点" }], mode, function (value) {
        if (value === "manual") {
          data.position_mode = "manual";
          rows.forEach(function (row) { row.slot.center = clampCenter(row.slot.center); });
        } else {
          delete data.position_mode;
          rows.forEach(function (row) { delete row.slot.center; });
        }
        writeV83EditorDraft(data); refreshCharacterSlots();
      }));
      slotBody.appendChild(modeRow);
      data.panels.forEach(function (panel, panelIndex) {
        var card = el("div", "n5c-history-editor-card"); card.style.margin = "8px 0";
        var tools = el("div", "n5c-history-field-row n5c-history-card-tools");
        var panelActions = el("div", "n5c-history-card-actions");
        panelActions.append(
          editButton("上移", function () { moveWithin(data.panels, panelIndex, -1, data); }),
          editButton("下移", function () { moveWithin(data.panels, panelIndex, 1, data); }),
          editButton("删除", function () { data.panels.splice(panelIndex, 1); writeV83EditorDraft(data); refreshCharacterSlots(); }));
        tools.append(el("strong", null, "画格 " + (panelIndex + 1)), panelActions);
        card.append(tools,
          field("画格编号", panel.id, function (value) { panel.id = value; writeV83EditorDraft(data); }, false),
          field("画格描述", panel.description, function (value) { panel.description = value; writeV83EditorDraft(data); }, true),
          field("画格非人物词", panel.non_character, function (value) { panel.non_character = value; writeV83EditorDraft(data); }, true));
        panel.characters.forEach(function (slot, slotIndex) {
          var charCard = el("div", "n5c-history-editor-card"); charCard.style.margin = "8px 0";
          var charTools = el("div", "n5c-history-field-row n5c-history-card-tools");
          var charActions = el("div", "n5c-history-card-actions");
          charActions.append(
            editButton("上移", function () { moveWithin(panel.characters, slotIndex, -1, data); }),
            editButton("下移", function () { moveWithin(panel.characters, slotIndex, 1, data); }),
            editButton("删除", function () { panel.characters.splice(slotIndex, 1); writeV83EditorDraft(data); refreshCharacterSlots(); }));
          charTools.append(el("strong", null, "人物 " + (slotIndex + 1)), charActions);
          charCard.append(charTools,
            field("角色编号", slot.character_id, function (value) { slot.character_id = value; writeV83EditorDraft(data); }, false),
            field("独立角色正面提示词", slot.positive, function (value) { slot.positive = value; writeV83EditorDraft(data); }, true),
            field("独立角色负面提示词（可留空）", slot.negative, function (value) { slot.negative = value; writeV83EditorDraft(data); }, true));
          if (mode === "manual") {
            slot.center = clampCenter(slot.center);
            var centerRow = el("div", "n5c-history-field-row");
            centerRow.append(el("span", null, "中心点 X"), centerField(slot.center.x, "中心点 X", function (v) { slot.center.x = v; writeV83EditorDraft(data); refreshCharacterSlots(); }),
              el("span", null, "Y"), centerField(slot.center.y, "中心点 Y", function (v) { slot.center.y = v; writeV83EditorDraft(data); refreshCharacterSlots(); }));
            charCard.appendChild(centerRow);
          }
          card.appendChild(charCard);
        });
        card.appendChild(editButton("添加人物", function () {
          var used = new Set(panel.characters.map(function (entry) { return entry.character_id; }));
          var n = 1; while (used.has("C" + n)) n++;
          var entry = { character_id: "C" + n, positive: "", negative: "" };
          if (mode === "manual") entry.center = { x: 0.5, y: 0.5 };
          panel.characters.push(entry); writeV83EditorDraft(data); refreshCharacterSlots();
        }));
        slotBody.appendChild(card);
      });
      slotBody.appendChild(editButton("添加画格", function () {
        var used = new Set(data.panels.map(function (panel) { return panel.id; }));
        var n = 1; while (used.has("P" + n)) n++;
        data.panels.push({ id: "P" + n, description: "", non_character: "", characters: [] });
        writeV83EditorDraft(data); refreshCharacterSlots();
      }));
      if (mode === "manual" && rows.length) {
        var canvas = el("div", "n5c-v83-center-canvas");
        var spread = /(?:見開きページ|2ページ見開き|見開き)|(?:double-page spread|2-page spread|wide spread)/i.test(page.base || "");
        canvas.style.cssText = "position:relative;height:180px;" + (spread ? "width:min(100%,270px);" : "width:min(100%,120px);") + "margin-top:8px;border:1px dashed var(--SmartThemeBorderColor,#777);border-radius:8px;overflow:hidden;";
        rows.forEach(function (row, index) {
          var marker = editButton(String(index + 1), null);
          marker.title = row.panel.id + " · " + row.slot.character_id;
          marker.style.cssText = "position:absolute;left:" + (row.slot.center.x * 100) + "%;top:" + (row.slot.center.y * 100) + "%;transform:translate(-50%,-50%);min-width:25px;height:25px;cursor:grab;";
          marker.addEventListener("pointerdown", function (event) {
            event.preventDefault(); marker.setPointerCapture(event.pointerId);
            function move(e) {
              var rect = canvas.getBoundingClientRect();
              row.slot.center = clampCenter({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
              marker.style.left = (row.slot.center.x * 100) + "%"; marker.style.top = (row.slot.center.y * 100) + "%";
              writeV83EditorDraft(data);
            }
            function done(e) { try { marker.releasePointerCapture(e.pointerId); } catch (_) {} marker.removeEventListener("pointermove", move); marker.removeEventListener("pointerup", done); marker.removeEventListener("pointercancel", done); refreshCharacterSlots(); }
            marker.addEventListener("pointermove", move); marker.addEventListener("pointerup", done); marker.addEventListener("pointercancel", done);
          });
          canvas.appendChild(marker);
        });
        slotBody.append(el("div", "n5c-hint", "整页中心点画布（拖动标记；位置引导，不是裁剪框）"), canvas);
      }
      refreshRequestPreview();
    }

    imageArea.addEventListener("input", refreshCharacterSlots);

    // 注入折叠式 AI 重roll面板
    var rerollDetails = el("details", "n5c-history-reroll-details");
    var rerollSummary = el("summary", "n5c-history-reroll-summary", "AI 辅助改写");
    var rerollBody = el("div", "n5c-history-reroll-body");

    var reqLabel = el("label", "n5c-history-editor-label", "附加要求（选填）");
    var reqInput = el("textarea", "n5c-history-textarea n5c-reroll-input");
    reqInput.rows = 2;
    reqInput.placeholder = "例：增强动作冲击力，画面加入雨夜反光；银时神情从慵懒变为警惕，分镜采用斜切特写...";

    var rerollActions = el("div", "n5c-history-reroll-actions");
    var runRerollBtn = el("button", "n5c-btn n5c-btn-reroll-run", "重roll");
    runRerollBtn.type = "button";
    runRerollBtn.disabled = true;
    rerollActions.appendChild(runRerollBtn);

    rerollBody.append(reqLabel, reqInput, rerollActions);
    rerollDetails.append(rerollSummary, rerollBody);

    var savePencilBtn = button("保存到小铅笔", null);
    savePencilBtn.disabled = true;
    actions.append(savePencilBtn, dlBtn, redrawBtn);
    modal.appendChild(actions);

    editorCard.append(editorHead, thinkingLabel, thinkingArea, imageLabel, imageArea, slotCard, rerollDetails);
    scroll.appendChild(editorCard);

    if (messageId != null) {
      readMessage(messageId).then(function (msg) {
        var parsed = parsePageBlocks(msg.message || "", pageNo);
        if (parsed.ok) {
          initialThinking = parsed.planningInner;
          initialImage = parsed.imageInner;
          editorTitle.textContent = "本页规划与提示词";
          thinkingLabel.textContent = "本页规划（可选）";
          thinkingArea.value = initialThinking;
          imageArea.value = initialImage;
          refreshCharacterSlots();
          isLoaded = true;
          savePencilBtn.disabled = false;
          runRerollBtn.disabled = false;
          editorStatus.textContent = "已就绪";
        } else {
          editorStatus.textContent = parsed.reason || "未解析到对应标签";
          runRerollBtn.disabled = false;
        }
      }).catch(function (err) {
        editorStatus.textContent = "读取失败: " + (err.message || String(err));
        runRerollBtn.disabled = false;
      });
    } else {
      editorStatus.textContent = "未找到对应楼层 ID";
    }

    runRerollBtn.addEventListener("click", async function () {
      if (runRerollBtn.disabled) return;
      var curT = thinkingArea.value;
      var curI = imageArea.value;
      var reqText = reqInput.value;

      runRerollBtn.disabled = true;
        runRerollBtn.textContent = "正在重roll…";
      savePencilBtn.disabled = true;
      editorStatus.textContent = "正在调用酒馆主模型重新规划分镜与提示词…";

      try {
        var curSelectedImgUrl = allVersions[previewIndex] || "";
        if (messageId == null) throw new Error("未找到目标消息，无法读取同轮漫画参考");
        var sourceMessage = await readMessage(messageId);
        var request = buildPageRerollRequest(pageNo, sourceMessage.message || "", curT, curI, reqText);
        var rawResult = await callRerollPresetApi(request, curSelectedImgUrl);
        var parsed = parseRerollResponse(rawResult, request.mode);

        if (!parsed.ok) {
          throw new Error(parsed.error || "未能提取到有效的 <thinking> 与 <image> 标签");
        }

        thinkingArea.value = parsed.thinking;
        imageArea.value = parsed.image;
        refreshCharacterSlots();
        if (messageId != null) {
          isLoaded = true;
        }

        editorStatus.textContent = "✓ 重roll完成已回填到本页编辑区（请审阅后保存或重画）";
        toast("第 " + pageNo + " 页分镜与提示词已重roll生成", "success");
        addLog("success", "第 " + pageNo + " 页分镜重roll成功", "已回填至弹窗编辑框");
      } catch (err) {
        console.error("[漫画台单页重roll失败]", err);
        editorStatus.textContent = "重roll失败: " + (err.message || String(err));
        toast("重roll失败: " + (err.message || String(err)), "error");
        addLog("error", "第 " + pageNo + " 页重roll失败", err.message || String(err));
      } finally {
        runRerollBtn.disabled = false;
        runRerollBtn.textContent = "重roll";
        if (isLoaded) {
          savePencilBtn.disabled = false;
        }
      }
    });

    async function doSaveToMessage() {
      if (!isLoaded || messageId == null) return false;
      var curT = thinkingArea.value;
      var curI = imageArea.value;
      savePencilBtn.disabled = true;
      editorStatus.textContent = "正在保存到小铅笔…";
      try {
        var check = parseImageBlock(curI);
        if (!check.ok) throw new Error(check.reason || "图片协议无效");
        var sourceForMode = await readMessage(messageId);
        if (detectComicMessageMode(sourceForMode.message || "") === "new" && !check.nested) throw new Error("新页面须使用按格分段文本或兼容的按格 JSON");
        await enqueueBackfill(messageId, async function () {
          var curMsg = await readMessage(messageId);
          var nextText = updatePageBlocks(curMsg.message || "", pageNo, curT, curI);
          await writeMessage(messageId, nextText);
        });
        initialThinking = curT;
        initialImage = curI;
        editorStatus.textContent = "已成功保存到小铅笔 √";
        
        addLog("success", "修改第 " + pageNo + " 页提示词", "已保存至消息楼层 #" + messageId);
        return true;
      } catch (e) {
        editorStatus.textContent = "保存失败：" + (e.message || String(e));
        toast("保存失败：" + (e.message || String(e)), "error");
        addLog("error", "保存提示词失败", e.message || String(e));
        return false;
      } finally {
        savePencilBtn.disabled = false;
      }
    }

    savePencilBtn.addEventListener("click", function () {
      doSaveToMessage();
    });

    redrawBtn.addEventListener("click", async function () {
      var hasChanges = isLoaded && (thinkingArea.value !== initialThinking || imageArea.value !== initialImage);
      if (hasChanges) {
        
        var ok = await doSaveToMessage();
        if (!ok) {
          toast("保存失败，已中止重画", "error");
          return;
        }
      }
      mask.remove();
      redrawSinglePage(messageId, pageNo).catch(function (err) {
        if (err && err.name !== "AbortError") setStatus("第 " + pageNo + " 页重画失败：" + err.message, "error");
      });
    });

    updateView();

    mask.addEventListener("click", function (e) {
      if (e.target === mask) mask.remove();
    });

    var onKey = function (e) {
      if (e.key === "Escape") {
        if (zoomLayer) { closeZoom(); return; }
        mask.remove();
        Env.pdoc.removeEventListener("keydown", onKey);
      }
    };
    Env.pdoc.addEventListener("keydown", onKey);

    mask.appendChild(modal);
    Env.pdoc.body.appendChild(mask);
    pinOverlays();
  }

  async function readMessage(messageId) {
    var getMsgs = getBoundFunction("getChatMessages");
    if (!getMsgs) throw new Error("宿主 getChatMessages 不可用");
    var list = await getMsgs.fn(String(messageId));
    var msg = Array.isArray(list) ? list[0] : list;
    if (!msg) throw new Error("读不到楼层 " + messageId);
    return msg;
  }

  async function writeMessage(messageId, text) {
    var setMsgs = getBoundFunction("setChatMessages");
    if (!setMsgs) throw new Error("宿主 setChatMessages 不可用");
    await setMsgs.fn([{ message_id: Number(messageId), message: text }], { refresh: "affected" });
  }

  /* 提示词块保留在聊天记录里不动，图片插在块后面。
     隐藏交给配套正则，这样随时能重新生图，模型上下文也不会被污染。 */
  // 业务等待上限（毫秒），不是视觉尺寸；禁止悬挂请求永久占用出图锁。
  var GENERATION_TIMEOUT_MS = 120000;
  var HOST_TIMEOUT_MS = 30000;
  var running = { busy: false, cancel: false };

  function syncBusyUi() {
    var isBusy = currentBatchTask !== null || activePageTasks.size > 0;
    running.busy = isBusy;
    if (refs.orb) refs.orb.classList.toggle("n5c-busy", isBusy);
    (refs.runButtons || []).forEach(function (button) { button.disabled = currentBatchTask !== null; });
    if (refs.stopButton) refs.stopButton.disabled = !isBusy;
  }
  function taskAbortError(task) {
    if (task && task.failure) return task.failure;
    var err = new Error("已中止当前出图任务"); err.name = "AbortError"; return err;
  }
  function requireActiveTask(task) {
    if (!task) return;
    if (task.controller && task.controller.signal && task.controller.signal.aborted) throw taskAbortError(task);
    if (lifecycle.destroyed) throw taskAbortError(task);
  }
  function taskStep(task, label, action, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var signal = task && task.controller && task.controller.signal;
      var settled = false, timer;
      function finish(error, result) {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(result);
      }
      function onAbort() { finish(taskAbortError(task)); }
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(function () {
        var err = new Error(label + "超时（" + Math.round(timeoutMs / 1000) + " 秒），任务已结束，可重试");
        err.name = "TimeoutError";
        if (task) { task.failure = err; if (task.controller) task.controller.abort(); }
      }, timeoutMs);
      Promise.resolve().then(function () { requireActiveTask(task); return action(); }).then(function (value) {
        try { requireActiveTask(task); finish(null, value); } catch (e) { finish(e); }
      }, function (error) { finish(error); });
    });
  }
  function stopRender() {
    if (hostApi.director) hostApi.director.cancel();
    running.cancel = true;
    var hadAny = false;
    if (currentBatchTask) {
      hadAny = true;
      try { currentBatchTask.controller.abort(); } catch (e) {}
    }
    activePageTasks.forEach(function (task) {
      hadAny = true;
      try { task.controller.abort(); } catch (e) {}
    });
    activePageTasks.clear();
    accountWaiters.forEach(function (w) { try { w.cancel(); } catch (e) {} });
    accountWaiters = [];
    accountInFlight.clear();
    syncBusyUi();
    if (hadAny) {
      setStatus("已中止出图任务；已发送至服务器的请求可能仍会计费", "");
    } else {
      setStatus("当前没有正在出图的任务", "");
    }
  }

  var PAGE_SPINNER_SVG = '<svg class="n5c-ph-spinner" viewBox="0 0 50 50" width="36" height="36">' +
    '<circle cx="25" cy="25" r="18" fill="none" stroke="#ffd700" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="80" stroke-dashoffset="25"></circle>' +
    '</svg>';

  function syncRedrawOverlay(messageId, pageNo, active) {
    try {
      var mesNode = Env.pdoc.querySelector('.mes[mesid="' + messageId + '"]');
      if (!mesNode) return;
      var selector = '[data-n5c-page="' + pageNo + '"]:not(.n5c-placeholder)';
      var page = mesNode.querySelector('.n5c-page' + selector + ', .custom-n5c-page' + selector);
      if (!page) return;
      var stage = page.querySelector('.n5c-redraw-stage');
      if (!active) {
        if (stage) {
          var originalImage = stage.querySelector('img');
          if (originalImage) stage.parentNode.insertBefore(originalImage, stage);
          stage.remove();
        }
        return;
      }
      if (stage) return;
      var image = page.querySelector('.n5c-page-image, .custom-n5c-page-image') || page.querySelector('img');
      if (!image) return;
      stage = el('span', 'n5c-redraw-stage');
      var overlay = el('div', 'n5c-redraw-overlay');
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-label', '正在重新生图中...');
      overlay.innerHTML = '<div class="n5c-ph-inner">' + PAGE_SPINNER_SVG +
        '<div class="n5c-ph-title">正在重新生图中...</div></div>';
      image.parentNode.insertBefore(stage, image);
      stage.append(image, overlay);
    } catch (e) {
      warn("重画遮罩更新失败", e);
    }
  }

  function setPlaceholderState(messageId, pageNo, stateType, errorMsg) {
    try {
      var mesNode = Env.pdoc.querySelector('.mes[mesid="' + messageId + '"]');
      if (!mesNode) return;
      var ph = mesNode.querySelector('.n5c-placeholder[data-n5c-page="' + pageNo + '"]');
      if (!ph) return;
      if (stateType === "queued") {
        ph.classList.add("n5c-loading");
        ph.innerHTML = '<div class="n5c-ph-inner">' +
          PAGE_SPINNER_SVG +
          '<div class="n5c-ph-title">正在排队生图…</div>' +
          '</div>';
      } else if (stateType === "loading") {
        ph.classList.add("n5c-loading");
        ph.innerHTML = '<div class="n5c-ph-inner">' +
          PAGE_SPINNER_SVG +
          '<div class="n5c-ph-title">正在生图中…</div>' +
          '</div>';
      } else if (stateType === "error") {
        ph.classList.remove("n5c-loading");
        ph.innerHTML = '<div class="n5c-ph-inner"><div class="n5c-ph-title">双击重试生图</div></div>';
      } else {
        ph.classList.remove("n5c-loading");
        ph.innerHTML = '<div class="n5c-ph-inner"><div class="n5c-ph-title">双击生图</div></div>';
      }
    } catch (e) {}
  }

  async function renderMessage(messageId, options, onProgress) {
    options = options || {};
    if (currentBatchTask) return { ok: false, reason: "busy" };

    var AbortCtrl = (Env.pwin && Env.pwin.AbortController) || (typeof AbortController !== "undefined" ? AbortController : null);
    var batchTask = { controller: new AbortCtrl(), failure: null };
    currentBatchTask = batchTask;
    running.cancel = false;
    var batchStartTime = Date.now();
    var done = 0, failed = 0, skipped = 0, total = 0, lastError = "", cancelled = false;
    function progress(value) { if (onProgress && currentBatchTask === batchTask && !lifecycle.destroyed) onProgress(value); }

    try {
      syncBusyUi();
      progress({ page: 0, total: 0, phase: "reading" });
      if (messageId == null) messageId = await taskStep(batchTask, "读取最新楼层", latestMessageId, HOST_TIMEOUT_MS);
      var msg = await taskStep(batchTask, "读取聊天消息", function () { return readMessage(messageId); }, HOST_TIMEOUT_MS);
      var blocks = extractBlocks(msg.message || ""); total = blocks.length;
      if (!total) return { ok: false, reason: nonEmpty(msg.message) ? "no-blocks" : "empty-message" };
      var lib = await taskStep(batchTask, "读取当前提示词库", function () { return PromptLibrary.load(true); }, HOST_TIMEOUT_MS);
      if (!lib.ok) throw new Error(lib.reason || "无法读取当前提示词库");
      var charDict = extractCharacterDictionary(msg.message || "");

      var pendingPages = [];
      for (var i = 0; i < blocks.length; i++) {
        var pageNo = i + 1;
        var block = blocks[i];
        if (parseBoxActiveSrc(boxAfter(msg.message || "", block.raw)) && !options.force) {
          skipped++;
          continue;
        }
        pendingPages.push({ index: i, pageNo: pageNo, block: block });
      }

      if (!pendingPages.length) {
        return { ok: true, done: 0, failed: 0, skipped: skipped, total: total, cancelled: false, error: "" };
      }

      var c = Number(state.concurrency);
      var limit = (c === -1 || c <= 0) ? pendingPages.length : Math.max(1, c);
      var queueIndex = 0;

      async function worker() {
        while (queueIndex < pendingPages.length) {
          if (batchTask.controller.signal.aborted || lifecycle.destroyed) break;
          var item = pendingPages[queueIndex++];
          var key = pageTaskKey(messageId, item.pageNo);

          // 若在此次批次运行期间该页已被手动重画成功生成，直接计为完成
          var recentFinish = recentCompletedPages.get(key);
          if (recentFinish && recentFinish >= batchStartTime) {
            done++;
            progress({ page: item.pageNo, total: total, phase: "done" });
            continue;
          }

          // 若目标页已有正在执行的手动重画，复用其完成结果
          var existing = activePageTasks.get(key);
          if (existing && existing.status === "running") {
            try {
              await existing.promise;
              done++;
              progress({ page: item.pageNo, total: total, phase: "done" });
            } catch (err) {
              failed++;
              lastError = err.message || "生成失败";
              progress({ page: item.pageNo, total: total, phase: "error", error: lastError });
            }
            continue;
          }

          try {
            progress({ page: item.pageNo, total: total, phase: "generating" });
            var pageCharDict = extractCharacterDictionary(msg.message || "", item.pageNo);
            await generatePage(messageId, item.pageNo, item.block, total, lib, false, batchTask.controller.signal, pageCharDict);
            done++;
            progress({ page: item.pageNo, total: total, phase: "done" });
          } catch (err) {
            if (err.name === "AbortError" || batchTask.controller.signal.aborted) {
              cancelled = true;
              break;
            }
            failed++;
            lastError = err.message || "生成失败";
            progress({ page: item.pageNo, total: total, phase: "error", error: lastError });
          }
        }
      }

      var workers = [];
      var workerCount = Math.min(limit, pendingPages.length);
      for (var w = 0; w < workerCount; w++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    } catch (e) {
      if (e.name === "AbortError" && !batchTask.failure) cancelled = true;
      else { failed++; lastError = e.message || "出图失败"; progress({ page: done + skipped + failed, total: total, phase: "error", error: lastError }); }
    } finally {
      if (currentBatchTask === batchTask) {
        currentBatchTask = null;
        running.cancel = cancelled;
        syncBusyUi();
      }
    }
    return { ok: true, done: done, failed: failed, skipped: skipped, total: total, cancelled: cancelled, error: lastError };
  }

  async function latestMessageId() {
    var getLast = getBoundFunction("getLastMessageId");
    if (!getLast) throw new Error("宿主 getLastMessageId 不可用");
    return await getLast.fn();
  }

  /* 面板要显示这一轮会消耗几张，V5 的 Opus 额度是可回充池，
     空了大约一周才回满，多页连发很快见底。 */
  async function countPendingPages(messageId) {
    try {
      var msg = await readMessage(messageId);
      var text = msg.message || "";
      var blocks = extractBlocks(text);
      var pending = blocks.filter(function (b) { return !boxAfter(text, b.raw); });
      return { total: blocks.length, pending: pending.length };
    } catch (e) {
      return { total: 0, pending: 0 };
    }
  }

  /* ------------------------------------------------------------
   * 界面
   * 挂在父文档上，样式全部加 n5c- 前缀，避免污染酒馆本体。
   * ---------------------------------------------------------- */
  /* UI_TOKENS_BEGIN：视觉值唯一来源，中文说明同步 docs/UI_VARIABLES.md。 */
  var UI_TOKENS = {
  "zero": {
    "value": "0",
    "description": "零布局值",
    "layer": "基础",
    "usage": "通用控件；画风导入弹窗"
  },
  "auto": {
    "value": "auto",
    "description": "自动尺寸与边距",
    "layer": "基础",
    "usage": "通用控件"
  },
  "full": {
    "value": "100%",
    "description": "容器全部长度",
    "layer": "基础",
    "usage": "通用控件；画风导入弹窗；自定义尺寸控件"
  },
  "half": {
    "value": "50%",
    "description": "居中与圆形基准",
    "layer": "基础",
    "usage": "通用控件；画风导入弹窗"
  },
  "none": {
    "value": "none",
    "description": "无视觉效果",
    "layer": "基础",
    "usage": "通用控件"
  },
  "transparent": {
    "value": "transparent",
    "description": "透明底色",
    "layer": "基础",
    "usage": "通用控件"
  },
  "current": {
    "value": "currentColor",
    "description": "继承当前颜色",
    "layer": "基础",
    "usage": "通用控件"
  },
  "normal": {
    "value": "normal",
    "description": "普通字体样式",
    "layer": "基础",
    "usage": "通用控件"
  },
  "grow": {
    "value": "1",
    "description": "弹性增长系数",
    "layer": "基础",
    "usage": "通用控件"
  },
  "shrink": {
    "value": "0",
    "description": "保持自然尺寸",
    "layer": "基础",
    "usage": "通用控件"
  },
  "border-style": {
    "value": "solid",
    "description": "实线边框",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；自定义尺寸控件"
  },
  "font-family": {
    "value": "\"Noto Sans SC\", \"Microsoft YaHei\", system-ui, sans-serif",
    "description": "本地中文字体栈",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "font-regular": {
    "value": "400",
    "description": "常规字重",
    "layer": "基础",
    "usage": "通用控件"
  },
  "font-medium": {
    "value": "500",
    "description": "中等字重",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "font-xs": {
    "value": "8px",
    "description": "版本字号",
    "layer": "基础",
    "usage": "通用控件"
  },
  "font-sm": {
    "value": "10px",
    "description": "选项及提示字号",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片"
  },
  "font-body": {
    "value": "12px",
    "description": "正文控件字号",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "font-heading": {
    "value": "14px",
    "description": "标题及分组字号",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "font-tab": {
    "value": "16px",
    "description": "页签字号",
    "layer": "基础",
    "usage": "通用控件"
  },
  "line-xs": {
    "value": "12px",
    "description": "版本行高",
    "layer": "基础",
    "usage": "通用控件"
  },
  "line-sm": {
    "value": "14px",
    "description": "选项及提示行高",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片"
  },
  "line-body": {
    "value": "16px",
    "description": "控件行高",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "line-heading": {
    "value": "18px",
    "description": "分组行高",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "line-tab": {
    "value": "20px",
    "description": "页签行高",
    "layer": "基础",
    "usage": "通用控件"
  },
  "space-2": {
    "value": "2px",
    "description": "微间距",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片"
  },
  "space-4": {
    "value": "4px",
    "description": "紧凑间距",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗；自定义尺寸控件"
  },
  "space-8": {
    "value": "8px",
    "description": "控件间距",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "space-10": {
    "value": "10px",
    "description": "胶囊横向留白",
    "layer": "基础",
    "usage": "通用控件"
  },
  "space-12": {
    "value": "12px",
    "description": "标准内边距",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗；自定义尺寸控件"
  },
  "space-16": {
    "value": "16px",
    "description": "内容内边距",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "radius-control": {
    "value": "8px",
    "description": "普通控件圆角",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "radius-dialog": {
    "value": "16px",
    "description": "弹窗圆角",
    "layer": "基础",
    "usage": "通用控件；画风导入弹窗"
  },
  "radius-pill": {
    "value": "999px",
    "description": "胶囊圆角",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片"
  },
  "border-width": {
    "value": "1px",
    "description": "边框线宽",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗；自定义尺寸控件"
  },
  "focus-width": {
    "value": "2px",
    "description": "键盘焦点宽度",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "duration": {
    "value": "120ms",
    "description": "短过渡时长",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片"
  },
  "easing": {
    "value": "ease-out",
    "description": "短过渡曲线",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片"
  },
  "opacity-disabled": {
    "value": "0.45",
    "description": "禁用透明度",
    "layer": "基础",
    "usage": "通用控件；画风导入弹窗"
  },
  "opacity-full": {
    "value": "1",
    "description": "正常透明度",
    "layer": "基础",
    "usage": "通用控件"
  },
  "z-panel": {
    "value": "2147483001",
    "description": "弹窗层级",
    "layer": "基础",
    "usage": "通用控件"
  },
  "z-orb": {
    "value": "2147483000",
    "description": "悬浮按钮层级",
    "layer": "基础",
    "usage": "通用控件"
  },
  "z-modal": {
    "value": "2147483002",
    "description": "全屏模态弹窗层级",
    "layer": "基础",
    "usage": "长按历史管理弹窗；画风导入弹窗"
  },
  "z-dialog": {
    "value": "2",
    "description": "内部对话层级",
    "layer": "基础",
    "usage": "通用控件"
  },
  "shadow": {
    "value": "0px 8px 20px rgba(0,0,0,0.12)",
    "description": "弹窗阴影",
    "layer": "基础",
    "usage": "通用控件；用户层折叠卡片；画风导入弹窗"
  },
  "surface-panel": {
    "value": "#424246",
    "description": "弹窗底色",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片；画风导入弹窗"
  },
  "surface-control": {
    "value": "#4E4E55",
    "description": "标题栏与输入底色",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片；画风导入弹窗"
  },
  "surface-action": {
    "value": "#616168",
    "description": "操作按钮底色",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片；画风导入弹窗"
  },
  "surface-hover": {
    "value": "#6C6C74",
    "description": "操作悬停底色",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；画风导入弹窗"
  },
  "text-primary": {
    "value": "#FFFFFF",
    "description": "正文颜色",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片；画风导入弹窗"
  },
  "text-muted": {
    "value": "#9292A2",
    "description": "分组及说明颜色",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片；画风导入弹窗"
  },
  "text-version": {
    "value": "#7D7D7D",
    "description": "版本文字",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈"
  },
  "border-selected": {
    "value": "#FFFFFF",
    "description": "胶囊选中描边",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；画风导入弹窗"
  },
  "tab-indicator": {
    "value": "#C4C4C4",
    "description": "活动页签下划线",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片"
  },
  "text-error": {
    "value": "#FFB4B4",
    "description": "错误反馈",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；自定义尺寸控件"
  },
  "text-success": {
    "value": "#B0D8BC",
    "description": "成功反馈",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈"
  },
  "focus-color": {
    "value": "#D4D4EC",
    "description": "键盘焦点",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈；用户层折叠卡片；画风导入弹窗"
  },
  "overlay": {
    "value": "rgba(32,32,36,0.94)",
    "description": "内部确认框遮罩",
    "layer": "语义",
    "usage": "面板、分组、表单与反馈"
  },
  "panel-width": {
    "value": "420px",
    "description": "桌面面板宽度",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "panel-max-height": {
    "value": "calc(100dvh - var(--n5c-viewport-inset) - var(--n5c-viewport-inset))",
    "description": "面板视口高度上限",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "viewport-inset": {
    "value": "12px",
    "description": "视口安全边距",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "panel-orb-gap": {
    "value": "10px",
    "description": "悬浮按钮与面板间隔",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "panel-radius": {
    "value": "var(--n5c-radius-dialog)",
    "description": "面板圆角",
    "layer": "组件",
    "usage": "对应名称的组件；用户层折叠卡片"
  },
  "content-padding": {
    "value": "var(--n5c-space-16)",
    "description": "内容侧边距",
    "layer": "组件",
    "usage": "对应名称的组件；用户层折叠卡片"
  },
  "header-padding": {
    "value": "var(--n5c-space-12)",
    "description": "标题栏内边距",
    "layer": "组件",
    "usage": "对应名称的组件；用户层折叠卡片"
  },
  "orb-size": {
    "value": "40px",
    "description": "悬浮按钮尺寸",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "orb-right": {
    "value": "18px",
    "description": "悬浮按钮初始右距",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "orb-bottom": {
    "value": "128px",
    "description": "悬浮按钮初始下距",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "drag-threshold": {
    "value": "5",
    "description": "拖动判定阈值，CSS像素",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "icon-size": {
    "value": "18px",
    "description": "标题栏图标尺寸",
    "layer": "组件",
    "usage": "对应名称的组件；画风导入弹窗"
  },
  "icon-small": {
    "value": "14px",
    "description": "下拉与管理图标尺寸",
    "layer": "组件",
    "usage": "对应名称的组件；用户层折叠卡片"
  },
  "icon-stroke": {
    "value": "1.5",
    "description": "功能图标描边宽度",
    "layer": "组件",
    "usage": "对应名称的组件；画风导入弹窗"
  },
  "tab-height": {
    "value": "32px",
    "description": "页签区域高度",
    "layer": "组件",
    "usage": "对应名称的组件；用户层折叠卡片"
  },
  "control-height": {
    "value": "28px",
    "description": "表单输入高度",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "switch-width": {
    "value": "25px",
    "description": "开关宽度",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "switch-height": {
    "value": "16px",
    "description": "开关高度",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "switch-thumb": {
    "value": "12px",
    "description": "开关圆点尺寸",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "switch-travel": {
    "value": "9px",
    "description": "开启状态圆点偏移",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "range-track": {
    "value": "4px",
    "description": "滑杆轨道高度",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "range-thumb": {
    "value": "12px",
    "description": "滑杆滑块尺寸",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "range-value-width": {
    "value": "36px",
    "description": "滑杆数字宽度",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "image-radius": {
    "value": "6px",
    "description": "消息图片圆角",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "image-margin": {
    "value": "6px",
    "description": "消息图片上下间距",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "dialog-padding": {
    "value": "24px",
    "description": "内部确认框内边距",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "dialog-gap": {
    "value": "12px",
    "description": "内部确认框控件间距",
    "layer": "组件",
    "usage": "对应名称的组件"
  },
  "viewport-height": {
    "value": "100dvh",
    "description": "当前动态视口高度",
    "layer": "基础",
    "usage": "画风导入遮罩独立于宿主容器高度"
  },
  "viewport-width": {
    "value": "100vw",
    "description": "当前视口宽度",
    "layer": "基础",
    "usage": "弹窗窄屏收窄"
  },
  "history-preview-height": {
    "value": "260px",
    "description": "历史图片弹窗主预览区域最大高度",
    "layer": "组件",
    "usage": "长按图片弹窗主图预览"
  },
  "history-thumb-size": {
    "value": "56px",
    "description": "历史图片弹窗缩略图尺寸",
    "layer": "组件",
    "usage": "长按图片弹窗历史版本条"
  },
  "log-box-max-height": {
    "value": "200px",
    "description": "运行日志容器最大滚动高度",
    "layer": "组件",
    "usage": "设置页运行日志滚动区域"
  },
  "feedback-hold-ms": {
    "value": "3000",
    "description": "修改成功反馈保留时长，期间不被自动出图进度覆盖，单位毫秒",
    "layer": "组件",
    "usage": "底部操作反馈"
  },
  "story-content-max-height": {
    "value": "480px",
    "description": "用户层展开后的卡片滚动区最大高度",
    "layer": "组件",
    "usage": "用户层折叠卡片内容区"
  },
  "story-content-line-height": {
    "value": "1.7",
    "description": "用户层长段落与Markdown内容的阅读行高",
    "layer": "组件",
    "usage": "用户层内容卡片"
  },
  "style-import-width": {
    "value": "600px",
    "description": "画风导入弹窗桌面宽度",
    "layer": "组件",
    "usage": "画风导入弹窗"
  },
  "style-import-max-height": {
    "value": "80vh",
    "description": "画风导入弹窗最大高度",
    "layer": "组件",
    "usage": "画风导入弹窗"
  },
  "style-import-drop-height": {
    "value": "180px",
    "description": "JSON投放区最小高度",
    "layer": "组件",
    "usage": "画风导入投放区"
  },
  "style-import-row-height": {
    "value": "44px",
    "description": "画风选择行最小点击高度",
    "layer": "组件",
    "usage": "画风导入列表"
  },
  "style-import-check-size": {
    "value": "20px",
    "description": "圆形多选标记外径",
    "layer": "组件",
    "usage": "画风导入列表"
  },
  "style-import-check-dot": {
    "value": "8px",
    "description": "已选圆点直径",
    "layer": "组件",
    "usage": "画风导入列表"
  },
  "style-import-drop-border-style": {
    "value": "dashed",
    "description": "文件投放区虚线描边",
    "layer": "组件",
    "usage": "画风导入投放区"
  }
};
  /* UI_TOKENS_END */
  function uiValue(key) { return UI_TOKENS[key].value; }
  function uiNumber(key) { return parseFloat(uiValue(key)); }
  /* BUNDLED_ASSETS_BEGIN：由本项目配套 source.json 生成，禁止独立维护副本。 */
  var BUNDLED_ASSETS = {"template":{"mate":{"type":"chatSheets","version":2,"updateConfigUiSentinel":-1,"globalInjectionConfig":{"readableEntryPlacement":{"position":"before_character_definition","depth":2,"order":1001},"wrapperPlacement":{"position":"before_character_definition","depth":2,"order":1001}},"presetName":"漫画台表格模板 v1.2"},"sheet_nsfw_pan_duan_biao":{"uid":"sheet_nsfw_pan_duan_biao","name":"NSFW判断表","sourceData":{"note":"请分析最近几轮对话的整体氛围和内容。\n1. 如果对话氛围变得暧昧、亲密或涉及成人内容，且当前“是否NSFW”列的值为“否”，请将其更新为“是”。\n2. 如果对话氛围回归正常、平淡，或用户明确表示希望停止，且当前“是否NSFW”列的值为“是”，请将其更新为“否”。\n3. 如果氛围没有明显变化，则保持当前值不变。\n\n【列定义】\n- 列1: 当前模式\n- 列2: 是否NSFW","initNode":"初始化填入标题“当前模式”。\n是否NSFW默认为“否”。","insertNode":"CREATE TABLE options ( -- 选项表\n  row_id INTEGER PRIMARY KEY, -- 行号\n  dang_qian_mo_shi TEXT, -- 当前模式\n  is_nsfw TEXT -- 是否NSFW\n);","updateNode":"<if cell=\"一键开关表/当前模式/是否NSFW == 是\">\n（预设色色部分）\n</if>","deleteNode":"禁止操作。","ddl":"CREATE TABLE sheet_nsfw_pan_duan_biao (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  lie_1 TEXT, -- 当前模式\n  lie_2 TEXT -- 是否NSFW\n);"},"content":[["row_id","当前模式","是否NSFW"]],"updateConfig":{"uiSentinel":-1,"contextDepth":-1,"updateFrequency":-1,"batchSize":-1,"skipFloors":-1,"sendLatestRows":-1,"groupId":-1},"exportConfig":{"enabled":false,"splitByRow":false,"entryName":"NSFW判断表","entryType":"constant","keywords":"","preventRecursion":true,"injectionTemplate":"","extraIndexEnabled":false,"extraIndexEntryName":"NSFW判断表-索引","extraIndexColumns":[],"extraIndexColumnModes":{},"extraIndexInjectionTemplate":"","sqlInjectionTemplate":"","entryPlacement":{"position":"at_depth_as_system","depth":2,"order":10000},"extraIndexPlacement":{"position":"at_depth_as_system","depth":2,"order":10010},"fixedEntryPlacement":{"position":"at_depth_as_system","depth":2,"order":99990},"fixedIndexPlacement":{"position":"at_depth_as_system","depth":2,"order":99991}},"orderNo":0},"sheet_jue_se_dna_biao":{"uid":"sheet_jue_se_dna_biao","name":"角色DNA表","sourceData":{"note":"记录登场人物的可复用角色DNA，每人一行。新写的视觉资料优先使用可靠英文标签；剧情姓名只用于对照和实际需上画的原句，原创姓名不作为绘图标签。缺少依据的字段填“无”，不推测不存在的服装状态。\n\n【来源】\n新正文读取整轮 <thinking> 的角色DNA；历史正文可从整轮 <comic_plan> 的角色母表提取已有信息。不读取或迁移旧表。以剧情已经明确的身份、外貌和开场穿搭为准，不把本轮结束着装覆盖开场穿搭。不同服装状态只有剧情确有依据时才列入穿搭DNA。原有行若未确认变更，保留原文。不收录一次性角色和路人的角色DNA。\n\n【列定义】\n- row_id：系统行号。\n- 姓名：准确姓名，只用于剧情对应或需上画的原句。\n- 类型：原创或同人。\n- 身份DNA：性别、年龄段、可靠同人角色标签等身份资料；原创姓名不是绘图标签。\n- 外貌DNA：稳定可见的发长、发型结构、发色、眼睛、体态及固定配饰。\n- 穿搭DNA：开场完整服装款式、材质和配饰；不同服装状态仅在剧情确有依据时列出。\n- 差异化特征：区分其他人物的可见特征，不与外貌DNA冲突。\n不把 Text:、气泡说明、逐格动作或人物专属 UC 填入本表。","initNode":"故事初始化时为开场在场且设定明确的每个角色插入一行角色DNA。","deleteNode":"禁止删除。","updateNode":"只有正文或明确设定纠正身份、稳定外貌，或有依据地列明新服装状态时，更新相应DNA列；未变化列保持原文，穿搭DNA保留开场穿搭，不以本轮结束着装替换。","insertNode":"首次登场且尚未记录的人物按已明确设定新增一行；缺项填无。","ddl":"CREATE TABLE sheet_jue_se_ti_shi_ci_biao (\n  row_id INTEGER PRIMARY KEY, -- 行号\n  name TEXT NOT NULL UNIQUE, -- 姓名\n  character_type TEXT NOT NULL, -- 类型\n  identity_dna TEXT NOT NULL, -- 身份DNA\n  appearance_dna TEXT NOT NULL, -- 外貌DNA\n  outfit_dna TEXT NOT NULL, -- 穿搭DNA\n  distinguishing_traits TEXT NOT NULL -- 差异化特征\n);"},"content":[["row_id","姓名","类型","身份DNA","外貌DNA","穿搭DNA","差异化特征"]],"updateConfig":{"uiSentinel":-1,"contextDepth":-1,"updateFrequency":-1,"batchSize":-1,"skipFloors":0,"groupId":-1},"exportConfig":{"enabled":true,"splitByRow":true,"entryName":"角色DNA表","entryType":"keyword","keywords":"姓名","preventRecursion":true,"injectionTemplate":"<角色设定>\n$1\n</角色设定>","extraIndexEnabled":false,"extraIndexEntryName":"角色DNA表-索引","extraIndexColumns":[],"extraIndexColumnModes":{},"extraIndexInjectionTemplate":"","sqlInjectionTemplate":"","entryPlacement":{"position":"after_character_definition","depth":10000,"order":8500},"extraIndexPlacement":{"position":"before_character_definition","depth":900,"order":1003},"fixedEntryPlacement":{"position":"at_depth_as_system","depth":10000,"order":99983},"fixedIndexPlacement":{"position":"at_depth_as_system","depth":10000,"order":99984}},"orderNo":1},"sheet_wu_pin_ti_shi_ci_biao":{"uid":"sheet_wu_pin_ti_shi_ci_biao","name":"物品提示词表","sourceData":{"note":"记录剧情中出现的专属武器、神器、核心信物与特殊道具的固定外观。仅收录外观独一无二的关键物品，普通日用品严禁入表。\n【表格结构】\n- 列0: row_id - 系统行号，递增\n- 列1: 名字 - 关键物品的中文名称（例：斩魄刀·袖白雪、黑刀夜、黄铜怀表）\n- 列2: 外观 - 新增视觉词优先使用可靠英文标签，必要时保留简短日文描述；必须包含具体颜色、材质与特征（例：white katana, 雪の鍔, 光る白い刀身, 柄の白いリボン）。既有英文与日文资料保持原义，不机械互翻。（禁止写入 speech bubble / Text: / 人数词）\n普通物品的本轮外观与位置由当前台本及漫画规划承接，不要求新增固定记录。","initNode":"故事初始化时若已有专属关键道具或武器，插入对应条目。","deleteNode":"禁止删除。","updateNode":"仅物品形态解放、强化改变外观或发生破损时更新外观列。未改变时严禁改写。","insertNode":"剧情中登场独一无二的关键专属物品、特殊武器或核心道具时新增一行。","ddl":"CREATE TABLE sheet_wu_pin_ti_shi_ci_biao ( -- 物品提示词表\n  row_id INTEGER PRIMARY KEY, -- 行号\n  name TEXT NOT NULL UNIQUE, -- 名字\n  appearance TEXT NOT NULL -- 外观\n);"},"content":[["row_id","名字","外观"]],"updateConfig":{"uiSentinel":-1,"contextDepth":-1,"updateFrequency":-1,"batchSize":-1,"skipFloors":0,"groupId":-1},"exportConfig":{"enabled":true,"splitByRow":true,"entryName":"物品提示词表","entryType":"keyword","keywords":"名字","preventRecursion":true,"injectionTemplate":"<物品设定>\n$1\n</物品设定>","extraIndexEnabled":false,"extraIndexEntryName":"物品提示词表-索引","extraIndexColumns":[],"extraIndexColumnModes":{},"extraIndexInjectionTemplate":"","sqlInjectionTemplate":"","entryPlacement":{"position":"after_character_definition","depth":10000,"order":8501},"extraIndexPlacement":{"position":"before_character_definition","depth":900,"order":1004},"fixedEntryPlacement":{"position":"at_depth_as_system","depth":10000,"order":99985},"fixedIndexPlacement":{"position":"at_depth_as_system","depth":10000,"order":99986}},"orderNo":2},"sheet_chang_jing_ti_shi_ci_biao":{"uid":"sheet_chang_jing_ti_shi_ci_biao","name":"场景提示词表","sourceData":{"note":"记录主要舞台、核心据点和反复出现地点的稳定视觉外观，每个地点状态一行。\n\n【来源与范围】\n依据实际提供的场景设定和正文，记录建筑结构、空间关系、材质、标志性陈设与固定灯具位置。当前时间、天气、灯具开关及照明效果由本轮场景与台本提供。\n场景发生永久结构变化时，新建带状态后缀的记录，保留原貌供实际回忆使用。\n\n【列定义：包含系统行号】\n- 列0：row_id，系统行号。\n- 列1：名字，地点的准确名称；永久变化记录包含对应状态名称。\n- 列2：外观，固定空间、建筑材质与陈设的英文视觉提示词。\n","initNode":"故事初始化时为开场在场的主要舞台或核心据点插入初始条目。","deleteNode":"禁止删除。","updateNode":"已有记录保持稳定；明确的记录错误可以修正。永久空间变化通过新增状态记录保存。","insertNode":"剧情中首次登场具有标志性外观的重要主舞台、核心活动据点时插入；或已有场景遭到破坏、永久改变形态时，新建带状态后缀的新条目（例：新艾利都六分街（废墟））插入。","ddl":"CREATE TABLE sheet_chang_jing_ti_shi_ci_biao ( -- 场景提示词表\n  row_id INTEGER PRIMARY KEY, -- 行号\n  name TEXT NOT NULL UNIQUE, -- 名字\n  appearance TEXT NOT NULL -- 外观\n);"},"content":[["row_id","名字","外观"]],"updateConfig":{"uiSentinel":-1,"contextDepth":-1,"updateFrequency":-1,"batchSize":-1,"skipFloors":0,"groupId":-1},"exportConfig":{"enabled":true,"splitByRow":true,"entryName":"场景提示词表","entryType":"keyword","keywords":"名字","preventRecursion":true,"injectionTemplate":"<场景设定>\n$1\n</场景设定>","extraIndexEnabled":false,"extraIndexEntryName":"场景提示词表-索引","extraIndexColumns":[],"extraIndexColumnModes":{},"extraIndexInjectionTemplate":"","sqlInjectionTemplate":"","entryPlacement":{"position":"after_character_definition","depth":10000,"order":8502},"extraIndexPlacement":{"position":"before_character_definition","depth":900,"order":1005},"fixedEntryPlacement":{"position":"at_depth_as_system","depth":10000,"order":99987},"fixedIndexPlacement":{"position":"at_depth_as_system","depth":10000,"order":99988}},"orderNo":3}},"plot":[{"name":"漫画台剧情推进 v1.2","rateCuckold":0,"extractTags":"lookup","contextExtractRules":[],"contextExcludeRules":[{"start":"<image>","end":"</image>"}],"minLength":0,"contextTurnCount":3,"worldbookEnabled":true,"worldbookSource":"character","selectedWorldbooks":[],"disabledWorldbookEntries":"__ALL_SELECTED__","plotWorldbookConfig":{"source":"character","manualSelection":[]},"loopSettings":{"loopTags":"","loopDelay":5,"retryDelay":3,"loopTotalDuration":0,"maxRetries":3},"extractInjectTags":"recall,story,boundary,plot_track","plotTasks":[{"id":"nai5_recall","name":"检索与召回","enabled":true,"promptGroup":[{"role":"SYSTEM","content":"[RETRIEVAL-TASK]\n\n你负责本轮漫画剧情的资料检索与记忆召回。根据用户输入和已经发生的剧情，找出后续推进需要的历史事实与设定，不安排新的剧情事件,职责是根据当前输入、已有资料和已发生事件，选取相关记忆记录与设定实体，为后续任务提供检索条件。\n\n记忆召回输出已有记录的真实编码；设定检索输出人物、地点、场景和关键物品的准确名称。","deletable":true},{"role":"SYSTEM","content":"[RETRIEVAL-RULES]\n\n1. 记忆选择\n从已发生事件概览中选取与本轮行动相关的记录，包括与历史记忆或前文剧情相关的直接因果、约定、持有物、地点及相关人物。数量不超过 recallCount，以实际相关记录为准。\n\n2. 实体选择\n选取本轮确实需要召回资料的人物、地点、场景和关键物品。人物状态和剧情用途用于判断相关性，最终检索结果只保留对应实体名称。\n\n3. 名称规范\n已有表格或设定记录的实体，使用记录中的准确名称。尚无表格记录的实体，使用角色卡、设定资料或当前输入已经确认的名称。\n\n4. 名称去重\n同一实体在对应名称列表中保留一次，按本轮首次相关的顺序排列。","deletable":true},{"role":"USER","content":"【用户角色】\n$U\n【角色卡】\n$C\n【当前可用设定资料】\n$1\n【已发生事件概览】\n$5\n【前文剧情】\n$7\n【历史剧情推演记录】\n$6\n【上轮未结事项与伏笔】\n{{plot_track}}\n【用户本轮输入】\n$8\n\n按以下格式输出成对标签：\n\n<recall>\n{填入符合条件的AM编码，只写AM+数字}\n没有相关记录时写“无可用历史编码”。\n</recall>\n\n<lookup>\n人物：[准确名称列表]\n地点：[准确名称列表]\n场景：[准确名称列表]\n关键物品：[准确名称列表]\n</lookup>\n\n<lookup> 固定使用上述两行。每个名称以中文分号结束；没有名称的类别保留行标题，名称列表留空。","deletable":true},{"role":"USER","content":"开始检索历史线索与设定关键词：\n<recall>","deletable":true}],"extractTags":"lookup","extractInjectTags":"recall","finalDirectiveTemplate":"","minLength":0,"maxRetries":3,"mergeStrategy":"append","stage":1,"order":0,"description":"","triggerWhen":"","agentControl":{"enabled":false,"selectable":true,"defaultSelected":false,"allowSequential":true,"allowParallel":true,"dependsOnTaskIds":[],"blocksTaskIds":[]}},{"id":"nai5_plot","name":"剧情推进","enabled":true,"promptGroup":[{"role":"SYSTEM","content":"[RESET ROLE AND TASK,START NEW TASK]\n\n你是连载漫画的剧情编剧。根据线索与情境，选定并规划本轮故事的核心事件走向，为后续正文与漫画生图确立明确的事件因果与分镜节拍。\n\n【转场场景详写铁律】：\n凡发生时间跳跃（如黄昏入夜、次日）或地点移动（转场）时，<scene> 严禁只写抽象地名！\n必须写清当前新时空的客观物理环境：光影明暗、建筑陈设、气温湿度、气味声息与天气。只写对象及其物理状态，禁止比喻和拟人。\n\n【外部事件驱动与逻辑铁律】\n1. 主动推进与冲突来源：可以主动推进剧情、制造冲突，但冲突源必须来自外部事件、任务压力、第三方介入、物理环境变化、信息差或角色既定目标，绝不能来自角色毫无依据的凭空猜忌！\n2. 亲见亲闻原则：角色只能根据自己亲眼所见、亲耳所闻、确知的事实做出反应。怀疑只能作为事件的结果，绝不能作为事件的原因！\n3. 平淡即加新事件：若剧情陷入平淡或停滞，应优先加入外部客观新事件（突发意外、外物异动、环境突变、新角色或新道具出现），绝不能靠让角色无理取闹来强行造冲突。\n4. 落实上轮铺垫：核对上轮留下的 [下轮铺垫]，本轮剧情必须给出直接回响与因果推进。","deletable":true},{"role":"SYSTEM","content":"[DRAMATIC-BEAT]\n\n根据本轮已定案事件，选择一个最能代表本轮核心进展的主戏剧节拍。\n\n允许的完整值：\n常规推进\n命运对峙/视线交锋\n震撼高潮/决战爆发\n史诗登场/宏大世界观展示\n时空转场\n\n将选中的完整值原样写入 <beat>...</beat>。标签正文只有一行，与上述一个值完全相同。\n\n本轮包含多种变化时，以承担主要叙事重心的事件确定分类。","deletable":true},{"role":"SYSTEM","content":"[TURN-STORY-DECISION]\n\n职责是确定本轮故事的环境、人物初始状态和事件结构，供台本创作任务展开。\n\n1. 身份与承接\n从用户角色资料和本轮明确指代确定人物姓名与身份。角色卡和实际触发的设定资料提供世界、关系、能力及物品信息；前文已发生的正文提供本轮承接位置。检索名称用于定位相应资料。\n\n2. 环境场景\n<scene> 专门记录本轮开场的客观环境：地点、空间结构、固定陈设、光照、天气和环境声息。使用环境对象及其物理状态组织描述，禁止比喻和拟人。\n\n3. 人物与关键实体\n人物身份、起始站位、持有物及交互关系写入 <story> 的开场状态。关键物品、作品和地点使用已确定的准确名称。身体只写部位和可见体态，不写食物或器物喻体。\n\n4. 事件定案\n<story> 按发生顺序列出本轮核心事件。每个事件写明诱因、行动、阻力或反应，以及造成的结果。事件句只写具体动作和可见结果，不写比喻。\n\n5. 完成范围\n结束接点写清最后完成的动作、仍在进行的动作，以及尚未开始的下一步。\n\n【输出检查】\n核对环境、人物、实体名称、持有物、能力依据和事件因果的一致性。<scene> 中只保留环境信息，人物演出进入事件大纲。核对 <beat> 符合 [DRAMATIC-BEAT] 的输出格式。\n检查 <scene> 与 <story> 是否出现比喻或拟人；若有，改成对象、部位或具体动作后再输出。","deletable":true},{"role":"USER","content":"【用户角色】\n$U\n【角色卡】\n$C\n【本轮检索线索】\n{{recall}}\n{{lookup}}\n【实际触发的设定资料】\n$1\n【前文剧情】\n$7\n【历史剧情推演记录】\n$6\n【上轮未结事项与伏笔】\n{{plot_track}}\n【用户本轮输入】\n$8\n\n依次输出 <scene>、<story>、<beat> 三个成对标签块。\n前两块按以下字段组织，<beat> 按 [DRAMATIC-BEAT] 输出。\n\n<scene>\n地点：[开场地点的准确名称]\n空间结构与固定陈设：[环境中的空间关系和固定物件]\n光照与天气：[开场的客观光照和天气条件]\n环境声息：[与当前环境有关的声音及其他感官细节]\n</scene>\n\n<story>\n出场人物与初始状态：[准确姓名、身份、站位、持有物和交互关系]\n关键实体：[本轮沿用的物品、作品及地点准确名称]\n本轮目标：[本轮要完成的事件或关系进展]\n核心事件与因果：\n1. [诱因 → 行动 → 阻力或反应 → 结果]\n2. [下一事件的对应内容]\n结束接点：[最后完成的动作、进行中的动作、尚未开始的下一步]\n</story>","deletable":true},{"role":"USER","content":"开始推演本轮剧情走向与生图大纲：\n<scene>","deletable":true}],"extractTags":"scene,beat","extractInjectTags":"story","finalDirectiveTemplate":"","minLength":0,"maxRetries":3,"mergeStrategy":"append","stage":2,"order":1,"description":"","triggerWhen":"","agentControl":{"enabled":false,"selectable":true,"defaultSelected":false,"allowSequential":true,"allowParallel":true,"dependsOnTaskIds":[],"blocksTaskIds":[]}},{"id":"nai5_act","name":"正文与伏笔","enabled":true,"promptGroup":[{"role":"SYSTEM","content":"[RESET ROLE AND TASK,START NEW TASK]\n\n你负责将已定案的剧情大纲展开为准确的演出段落，并沉淀铺垫与长期伏笔。不追求文风，只追求事实清楚、动作可画。\n\n【剧情契约】\n按剧情先后写成简短演出段落（200字以上，不超过600字）。\n原创角色首次出场时，必须用白描写清可见外貌：部位、体态、发型、着装（不写比拟）\n转场时必须写清时间、地点、光影、固定陈设（若和上一轮地点一致则不写）。\n其他段落明确行动者，必须将动作与同一时刻说出的关键台词合在一个段落。覆盖当下反应、必要的 NPC 主动行动及后续变化。\n严禁出现一行一句话的轻小说式风格。\n\n【白描铁律】\n<act> 里除角色台词外，只写可观察事实：谁、在哪、做什么、身体哪一部位呈什么状态。\n禁止比喻、拟人、通感、夸张喻体；禁止把身体写成食物或器物；禁止「像/宛如/仿佛/好似」以及「夜色吞没」「灯光亲吻」「风在低语」这类句子。\n「对白」和 *心声* 可以按角色说话习惯写，允许角色自己的比喻。\n动作、外貌、场景、身体描写一律白描，越干巴越好。\n\n【角色演出契约】\n角色每段台词尽量不超过30字\n角色台词严禁使用否肯句（例如：不是...而是；并非...而是；不在于...而在于等先肯定后否定构造的句子）","deletable":true},{"role":"SYSTEM","content":"【认知边界与伏笔严谨性】\n1. 守住认知边界：角色不是全知全能的上帝！严格区分角色视角与读者视角。角色未亲眼见、未当面听到的事，绝对不知情；严禁心电感应、未卜先知。\n2. 铺垫与伏笔严格二分：\n- [下轮铺垫]：下一轮剧情必揭开真相或给出直接结果的短期因果线索，绝不拖泥带水；\n- [长期伏笔]：深埋的长期主线暗线或世界观谜团，可能在几十轮后才揭开。严禁为了制造悬念而生造无关紧要的虚假伏笔！\n\n【格式遵循】\n- 开口对白「……」➔ 如果不是一口气说出来的话，必须分开写！禁止一个「……」中包含多句话。\n- 心里独白 *……* ➔ 必须和心理独白的发起者与动作合成一个段落，禁止单独处一个段落\n- 转场时间/转场地点/必要的旁白 {……}➔ 转场时间和转场地点只能写关键词，且不能连续写或写在同一段，如果时间和地点同时改变，则时间直接写进转场段落，不要写进 {……}，只有拥有独特名字场景第一次进入时才放入 {……}，一次性场景（例如便利店、普通房间等只来这一次的场景）禁止放入，禁止每轮开头都写{……}","deletable":true},{"role":"SYSTEM","content":"[FINAL-SCRIPT-CONTRACT]\n\n职责是把已定案的事件展开为可直接转译的漫画台本。\n\n1. 定案输入\n<scene> 提供开场环境，<story> 提供人物初始状态、关键实体、核心事件、因果顺序和结束接点。<recall> 与 $5 只提供已发生事实，用来核对因果和连续性，不提供新事件。台本沿用这些定案事实；禁止把记忆编码、检索过程或未选中的旧事写进 <act>。\n\n2. 叙述称呼\n人物每次出现必须准确姓名，后续直接发言和心声可以使用自然人称。\n\n3. 动作进度\n台本结尾对应大纲的结束接点。进行中的动作保留其进行状态，后续行动进入后续记录。\n\n4. 内部记录\n<boundary> 记录本轮适用的角色认知和能力条件；<plot_track> 从台本实际留下的未结事项及既有长期线索中整理。\n\n5. 叙述转译\n<act> 的叙述、动作、外貌、场景和 {旁白} 只写可见形态与具体动作，供后道直接转成画面。喻体、拟人、通感不进叙述。对白和心声保留角色原话。\n\n【输出检查】\n逐项对照事件定案，检查人物、地点、关键实体、行动动机、事件顺序与完成度；检查叙述称呼与角色指代；检查行为和感知符合边界记录，并在输出前修正不一致处。\n核对开场环境与 <scene> 一致；核对人物、地点、关键物品与<lookup>一致；正文转译所需的人物起始位置、当前着装变化、重要持有物与结束状态，均已在 <act> 中交代。\n检查 <act> 叙述中是否出现比喻、拟人或食物器物喻体；若有，改成部位、体态或真实器物后再输出。对白和心声不改。","deletable":true},{"role":"USER","content":"【用户角色】\n$U\n【角色卡】\n$C\n【本轮召回记忆】\n{{recall}}\n【已发生事件概览】\n$5\n【本轮设定检索】\n{{lookup}}\n【本轮环境场景】\n{{scene}}\n【本轮事件定案】\n{{story}}\n【本轮主戏剧节拍】\n{{beat}}\n【当前可用设定资料】\n$1\n【前文剧情】\n$7\n【历史剧情推演记录】\n$6\n【上轮未结事项与伏笔】\n{{plot_track}}\n【用户本轮输入】\n$8\n\n按以下顺序输出成对标签：\n\n<boundary>\n[本轮适用的角色认知与能力记录]\n</boundary>\n\n<act>\n[本轮定稿台本]\n</act>\n\n<plot_track>\n[下轮铺垫] [本轮留下的短期未结事项；无则写无]\n[长期伏笔] [沿用或由本轮事件产生的长期线索；无则写无]\n</plot_track>","deletable":true},{"role":"USER","content":"开始进行边界自检并创作台本正文：\n<boundary>","deletable":true}],"extractTags":"act","extractInjectTags":"boundary,plot_track","finalDirectiveTemplate":"<user_input>\n$8\n</user_input>\n\n{{lookup}}\n\n{{scene}}\n\n{{beat}}\n\n{{act}}","minLength":0,"maxRetries":3,"mergeStrategy":"append","stage":3,"order":2,"description":"","triggerWhen":"","agentControl":{"enabled":false,"selectable":true,"defaultSelected":false,"allowSequential":true,"allowParallel":true,"dependsOnTaskIds":[],"blocksTaskIds":[]}}],"finalSystemDirective":"<user_input>\n$8\n</user_input>\n\n{{lookup}}\n\n{{scene}}\n\n{{beat}}\n\n{{act}}","promptGroup":[{"role":"SYSTEM","content":"[RETRIEVAL-TASK]\n\n你负责本轮漫画剧情的资料检索与记忆召回。根据用户输入和已经发生的剧情，找出后续推进需要的历史事实与设定，不安排新的剧情事件,职责是根据当前输入、已有资料和已发生事件，选取相关记忆记录与设定实体，为后续任务提供检索条件。\n\n记忆召回输出已有记录的真实编码；设定检索输出人物、地点、场景和关键物品的准确名称。","deletable":true},{"role":"SYSTEM","content":"[RETRIEVAL-RULES]\n\n1. 记忆选择\n从已发生事件概览中选取与本轮行动相关的记录，包括与历史记忆或前文剧情相关的直接因果、约定、持有物、地点及相关人物。数量不超过 recallCount，以实际相关记录为准。\n\n2. 实体选择\n选取本轮确实需要召回资料的人物、地点、场景和关键物品。人物状态和剧情用途用于判断相关性，最终检索结果只保留对应实体名称。\n\n3. 名称规范\n已有表格或设定记录的实体，使用记录中的准确名称。尚无表格记录的实体，使用角色卡、设定资料或当前输入已经确认的名称。\n\n4. 名称去重\n同一实体在对应名称列表中保留一次，按本轮首次相关的顺序排列。","deletable":true},{"role":"USER","content":"【用户角色】\n$U\n【角色卡】\n$C\n【当前可用设定资料】\n$1\n【已发生事件概览】\n$5\n【前文剧情】\n$7\n【历史剧情推演记录】\n$6\n【上轮未结事项与伏笔】\n{{plot_track}}\n【用户本轮输入】\n$8\n\n按以下格式输出成对标签：\n\n<recall>\n{填入符合条件的AM编码，只写AM+数字}\n没有相关记录时写“无可用历史编码”。\n</recall>\n\n<lookup>\n人物：[准确名称列表]\n地点：[准确名称列表]\n场景：[准确名称列表]\n关键物品：[准确名称列表]\n</lookup>\n\n<lookup> 固定使用上述两行。每个名称以中文分号结束；没有名称的类别保留行标题，名称列表留空。","deletable":true},{"role":"USER","content":"开始检索历史线索与设定关键词：\n<recall>","deletable":true}],"prompts":[{"id":"mainPrompt","name":"主系统提示词 (通用)","role":"system","content":"","deletable":false},{"id":"systemPrompt","name":"拦截任务详细指令","role":"user","content":"","deletable":false},{"id":"finalSystemDirective","name":"最终注入指令 (Storyteller Directive)","role":"system","content":"<user_input>\n$8\n</user_input>\n\n{{lookup}}\n\n{{scene}}\n\n{{beat}}\n\n{{act}}","deletable":false}]}]};
  /* BUNDLED_ASSETS_END */
  var CSS = "\n[data-n5c-user-story] .n5c-story-content::-webkit-scrollbar,.n5c-story-content::-webkit-scrollbar,.n5c-story-tabs::-webkit-scrollbar,.n5c-body::-webkit-scrollbar,.n5c-log-container::-webkit-scrollbar{width:6px;height:6px}\n[data-n5c-user-story] .n5c-story-content::-webkit-scrollbar-track,.n5c-story-content::-webkit-scrollbar-track,.n5c-story-tabs::-webkit-scrollbar-track,.n5c-body::-webkit-scrollbar-track,.n5c-log-container::-webkit-scrollbar-track{background:transparent}\n[data-n5c-user-story] .n5c-story-content::-webkit-scrollbar-thumb,.n5c-story-content::-webkit-scrollbar-thumb,.n5c-story-tabs::-webkit-scrollbar-thumb,.n5c-body::-webkit-scrollbar-thumb,.n5c-log-container::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.18);border-radius:3px}\n[data-n5c-user-story] .n5c-story-content::-webkit-scrollbar-thumb:hover,.n5c-story-content::-webkit-scrollbar-thumb:hover,.n5c-story-tabs::-webkit-scrollbar-thumb:hover,.n5c-body::-webkit-scrollbar-thumb:hover,.n5c-log-container::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.36)}\n[data-n5c-user-story] .n5c-story-content{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.18) transparent}\n.n5c-stepper{display:inline-flex;align-items:center;position:relative;width:84px;height:var(--n5c-control-height);background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);overflow:hidden;box-sizing:border-box}\n.n5c-stepper-val{width:54px;height:100%;display:flex;align-items:center;justify-content:center;color:var(--n5c-text-primary);font-family:inherit;font-size:var(--n5c-font-body);font-weight:var(--n5c-font-medium);user-select:none}\n.n5c-stepper-arrows{display:flex;flex-direction:column;width:30px;height:100%;border-left:1px solid rgba(255,255,255,0.08)}\n.n5c-stepper-btn{display:flex;align-items:center;justify-content:center;height:50%;width:100%;background:transparent;border:none;color:var(--n5c-text-muted);cursor:pointer;padding:0;font-size:8px;line-height:1;transition:all .15s ease;user-select:none}\n.n5c-stepper-btn:hover{background:var(--n5c-surface-action);color:var(--n5c-text-primary)}\n.n5c-stepper-btn.up{border-bottom:1px solid rgba(255,255,255,0.06)}\n" + ".n5c-page,.custom-n5c-page{display:flex !important;justify-content:center !important;align-items:center !important;width:100% !important;margin:12px auto !important;text-align:center !important;box-sizing:border-box}\n.n5c-page-image,.custom-n5c-page-image{margin:0 auto !important;display:block !important}\n.n5c-placeholder{background:#050508 !important;border:none !important;outline:none !important;border-radius:8px;min-height:280px;aspect-ratio:2/3;width:100%;max-width:480px;margin:12px auto;display:flex !important;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;user-select:none;transition:all .2s ease;box-sizing:border-box}\n.n5c-placeholder.n5c-landscape{aspect-ratio:3/2 !important;max-width:720px !important;min-height:240px !important}\n.n5c-page.n5c-landscape{max-width:720px !important}\n.n5c-placeholder:hover{background:#0b0b10 !important;box-shadow:0 0 16px rgba(0,0,0,0.9)}\n.n5c-ph-inner{display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px;text-align:center}\n.n5c-ph-title{font-size:14px;font-weight:600;color:#eaeaea;letter-spacing:0.5px}\n.n5c-placeholder.n5c-loading{cursor:wait;background:#08080c !important}\n.n5c-ph-spinner{animation:n5c-spin 1.2s linear infinite;margin-bottom:4px}\n@keyframes n5c-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}\n" + ":root,.n5c-orb,.n5c-panel,.n5c-page,.custom-n5c-page,.n5c-history-mask{" + Object.keys(UI_TOKENS).map(function (key) { return "--n5c-" + key + ":" + uiValue(key) + ";"; }).join("") + "}" + "\n.n5c-orb,.n5c-panel,.n5c-page,.custom-n5c-page,.n5c-history-mask{font-family:var(--n5c-font-family);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);color:var(--n5c-text-primary);text-shadow:var(--n5c-none);font-weight:var(--n5c-font-regular);font-style:var(--n5c-normal)}\n.n5c-panel,.n5c-panel *,.n5c-orb,.n5c-history-mask,.n5c-history-mask *{box-sizing:border-box}\n.n5c-history-mask button{font-family:var(--n5c-font-family);font-style:var(--n5c-normal);text-shadow:var(--n5c-none);letter-spacing:var(--n5c-normal);box-shadow:var(--n5c-none);cursor:pointer;min-width:var(--n5c-zero);margin:var(--n5c-zero);transition:background var(--n5c-duration) var(--n5c-easing)}\n.n5c-panel [hidden]{display:none!important}\n.n5c-orb{position:fixed;right:var(--n5c-orb-right);bottom:var(--n5c-orb-bottom);width:var(--n5c-orb-size);height:var(--n5c-orb-size);display:flex;align-items:center;justify-content:center;border:var(--n5c-zero);border-radius:var(--n5c-half);padding:var(--n5c-zero);margin:var(--n5c-zero);background:var(--n5c-surface-control);color:var(--n5c-text-primary);z-index:var(--n5c-z-orb);cursor:pointer;touch-action:none;user-select:none;box-shadow:var(--n5c-none)}\n.n5c-orb.n5c-open{background:var(--n5c-surface-control)}\n.n5c-orb:hover,.n5c-orb.n5c-open:hover{background:var(--n5c-surface-hover)}\n.n5c-orb.n5c-busy{outline:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-tab-indicator)}\n.n5c-orb.n5c-dragging{cursor:grabbing}\n.n5c-panel{position:fixed;display:none;flex-direction:column;gap:var(--n5c-space-8);width:min(var(--n5c-panel-width),calc(var(--n5c-viewport-width) - var(--n5c-viewport-inset) - var(--n5c-viewport-inset)));max-height:var(--n5c-panel-max-height);padding:var(--n5c-zero) var(--n5c-zero) var(--n5c-space-16);margin:var(--n5c-zero);background:var(--n5c-surface-panel);border:var(--n5c-zero);border-radius:var(--n5c-panel-radius);box-shadow:var(--n5c-shadow);z-index:var(--n5c-z-panel);overflow:hidden;text-align:left}\n.n5c-panel.n5c-open{display:flex}\n.n5c-head{display:flex;align-items:center;gap:var(--n5c-space-4);padding:var(--n5c-header-padding);background:var(--n5c-surface-control);flex-shrink:var(--n5c-shrink)}\n.n5c-title{font-size:var(--n5c-font-heading);line-height:var(--n5c-line-heading);font-weight:var(--n5c-font-medium);white-space:nowrap}\n.n5c-ver{font-size:var(--n5c-font-xs);line-height:var(--n5c-line-xs);color:var(--n5c-text-version);flex:var(--n5c-grow)}\n.n5c-icon{display:block;width:var(--n5c-icon-size);height:var(--n5c-icon-size);flex-shrink:var(--n5c-shrink);fill:var(--n5c-none);stroke:var(--n5c-current);stroke-width:var(--n5c-icon-stroke);stroke-linecap:round;stroke-linejoin:round}\n.n5c-logo{fill:var(--n5c-current);stroke:var(--n5c-none)}\n.n5c-tabs{display:flex;gap:var(--n5c-space-8);padding:var(--n5c-space-4) var(--n5c-space-8) var(--n5c-zero);margin:var(--n5c-zero) var(--n5c-space-16);height:var(--n5c-tab-height);border-bottom:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-control);flex-shrink:var(--n5c-shrink)}\n.n5c-panel button{font-family:var(--n5c-font-family);font-style:var(--n5c-normal);text-shadow:var(--n5c-none);letter-spacing:var(--n5c-normal);box-shadow:var(--n5c-none);cursor:pointer;min-width:var(--n5c-zero);margin:var(--n5c-zero);transition:background var(--n5c-duration) var(--n5c-easing)}\n.n5c-tab{flex:var(--n5c-grow);display:flex;align-items:center;justify-content:center;color:var(--n5c-text-primary);background:var(--n5c-transparent);border:var(--n5c-zero);border-bottom:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-transparent);padding:var(--n5c-zero);border-radius:var(--n5c-zero);font-size:var(--n5c-font-tab);line-height:var(--n5c-line-tab);font-weight:var(--n5c-font-medium)}\n.n5c-tab.n5c-on{border-bottom-color:var(--n5c-tab-indicator)}\n.n5c-body{padding:var(--n5c-zero) var(--n5c-content-padding);overflow:auto;flex:var(--n5c-grow);min-height:var(--n5c-zero);scrollbar-width:thin;scrollbar-color:var(--n5c-surface-action) var(--n5c-transparent)}\n.n5c-pane{display:flex;flex-direction:column;gap:var(--n5c-space-4)}\n.n5c-section{display:flex;flex-direction:column;gap:var(--n5c-space-4);padding:var(--n5c-space-4);min-width:var(--n5c-zero)}\n.n5c-section+.n5c-section{border-top:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-control);padding-top:var(--n5c-space-8)}\n.n5c-h{font-size:var(--n5c-font-heading);line-height:var(--n5c-line-heading);font-weight:var(--n5c-font-medium);color:var(--n5c-text-muted);padding:var(--n5c-zero) var(--n5c-space-12);margin:var(--n5c-zero)}\n.n5c-btns,.n5c-seg{display:flex;flex-wrap:wrap;align-items:center;gap:var(--n5c-space-4);padding:var(--n5c-space-4);min-width:var(--n5c-zero)}\n.n5c-btns{gap:var(--n5c-space-10);padding:var(--n5c-zero) var(--n5c-space-12)}\n.n5c-btn{background:var(--n5c-surface-action);color:var(--n5c-text-primary);border:var(--n5c-zero);border-radius:var(--n5c-radius-control);padding:var(--n5c-space-4) var(--n5c-space-12);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);font-weight:var(--n5c-font-medium)}\n.n5c-btn:hover,.n5c-iconbtn:hover{background:var(--n5c-surface-hover)}\n.n5c-pill{background:var(--n5c-surface-control);color:var(--n5c-text-primary);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-transparent);border-radius:var(--n5c-radius-pill);padding:var(--n5c-space-4) var(--n5c-space-10);font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);font-weight:var(--n5c-font-regular);max-width:var(--n5c-full);overflow-wrap:anywhere}\n.n5c-pill.n5c-on{border-color:var(--n5c-border-selected)}\n.n5c-pill:hover{background:var(--n5c-surface-action)}\n.n5c-iconbtn{display:flex;align-items:center;justify-content:center;background:var(--n5c-transparent);color:var(--n5c-text-primary);border:var(--n5c-zero);padding:var(--n5c-space-2);border-radius:var(--n5c-space-4);flex-shrink:var(--n5c-shrink)}\n.n5c-iconbtn .n5c-icon{width:var(--n5c-icon-small);height:var(--n5c-icon-small)}\n.n5c-close{padding:var(--n5c-zero)}\n.n5c-close .n5c-icon{width:var(--n5c-icon-size);height:var(--n5c-icon-size)}\n.n5c-row{display:flex;gap:var(--n5c-space-8);align-items:center;padding:var(--n5c-space-4);min-width:var(--n5c-zero)}\n.n5c-row>label{flex-shrink:var(--n5c-shrink);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);margin:var(--n5c-zero);font-weight:var(--n5c-font-medium)}\n.n5c-panel input:not([type=range]),.n5c-panel select{font-family:var(--n5c-font-family);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);font-weight:var(--n5c-font-medium);color:var(--n5c-text-primary);background:var(--n5c-surface-control);border:var(--n5c-zero);border-radius:var(--n5c-radius-control);height:var(--n5c-control-height);padding:var(--n5c-space-4) var(--n5c-space-8);margin:var(--n5c-zero);min-width:var(--n5c-zero);max-width:var(--n5c-full);box-shadow:var(--n5c-none)}\n.n5c-row>input,.n5c-row>select,.n5c-range-wrap{flex:var(--n5c-grow);width:var(--n5c-zero)}\n.n5c-panel input::placeholder{color:var(--n5c-text-muted);opacity:var(--n5c-opacity-full)}\n.n5c-panel select{cursor:pointer}\n.n5c-range-row{flex-wrap:wrap}\n.n5c-range-row>label{width:var(--n5c-full)}\n.n5c-range-wrap{display:flex;align-items:center;gap:var(--n5c-space-8);height:var(--n5c-control-height);min-width:var(--n5c-zero)}\n.n5c-range{appearance:none;-webkit-appearance:none;background:var(--n5c-surface-action);border:var(--n5c-zero);border-radius:var(--n5c-radius-pill);height:var(--n5c-range-track);padding:var(--n5c-zero);margin:var(--n5c-zero);flex:var(--n5c-grow);width:var(--n5c-zero);min-width:var(--n5c-zero);box-shadow:var(--n5c-none);cursor:pointer;accent-color:var(--n5c-text-primary)}\n.n5c-range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:var(--n5c-range-thumb);height:var(--n5c-range-thumb);border:var(--n5c-zero);border-radius:var(--n5c-half);background:var(--n5c-text-primary)}\n.n5c-range::-moz-range-thumb{width:var(--n5c-range-thumb);height:var(--n5c-range-thumb);border:var(--n5c-zero);border-radius:var(--n5c-half);background:var(--n5c-text-primary)}\n.n5c-range-value{width:var(--n5c-range-value-width);flex-shrink:var(--n5c-shrink);font-variant-numeric:tabular-nums;text-align:right}\n.n5c-switch{position:relative;width:var(--n5c-switch-width);height:var(--n5c-switch-height);border-radius:var(--n5c-radius-pill);background:var(--n5c-surface-action);padding:var(--n5c-zero);border:var(--n5c-zero);flex-shrink:var(--n5c-shrink)}\n.n5c-switch::after{content:\"\";position:absolute;top:var(--n5c-space-2);left:var(--n5c-space-2);width:var(--n5c-switch-thumb);height:var(--n5c-switch-thumb);border-radius:var(--n5c-half);background:var(--n5c-text-primary);transform:translateX(var(--n5c-zero));transition:transform var(--n5c-duration) var(--n5c-easing)}\n.n5c-switch[aria-checked=true]::after{transform:translateX(var(--n5c-switch-travel))}\n.n5c-switch[aria-checked=true]{background:var(--n5c-text-muted)}\n.n5c-hint,.n5c-foot{color:var(--n5c-text-muted);font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);overflow-wrap:anywhere;padding:var(--n5c-space-2);margin:var(--n5c-zero)}\n.n5c-foot{padding:var(--n5c-zero) var(--n5c-space-16);flex-shrink:var(--n5c-shrink);max-height:var(--n5c-dialog-padding);overflow:auto}\n.n5c-error{color:var(--n5c-text-error)}\n.n5c-ok{color:var(--n5c-text-success)}\n.n5c-panel button:disabled,.n5c-panel input:disabled,.n5c-panel select:disabled{opacity:var(--n5c-opacity-disabled);cursor:not-allowed}\n.n5c-panel :focus-visible,.n5c-orb:focus-visible{outline:var(--n5c-focus-width) var(--n5c-border-style) var(--n5c-focus-color);outline-offset:var(--n5c-space-2)}\n.n5c-dialog{position:absolute;inset:var(--n5c-zero);background:var(--n5c-overlay);padding:var(--n5c-dialog-padding);display:flex;flex-direction:column;justify-content:center;gap:var(--n5c-dialog-gap);z-index:var(--n5c-z-dialog)}\n.n5c-dialog .n5c-btns{padding:var(--n5c-zero)}\n.n5c-dialog input{width:var(--n5c-full)}\n.n5c-log-box{background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);padding:var(--n5c-space-8);max-height:var(--n5c-log-box-max-height);overflow-y:auto;overflow-x:hidden;font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);word-break:break-all;margin-top:var(--n5c-space-4);scrollbar-width:thin}\n.n5c-log-item{padding:var(--n5c-space-4) var(--n5c-zero);border-bottom:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-panel)}\n.n5c-log-item:last-child{border-bottom:var(--n5c-zero)}\n.n5c-log-head{display:flex;gap:var(--n5c-space-4);align-items:baseline;flex-wrap:wrap}\n.n5c-log-time{color:var(--n5c-text-muted);font-variant-numeric:tabular-nums;flex-shrink:var(--n5c-shrink)}\n.n5c-log-badge{font-weight:var(--n5c-font-medium);flex-shrink:var(--n5c-shrink)}\n.n5c-log-title{font-weight:var(--n5c-font-medium);color:var(--n5c-text-primary)}\n.n5c-log-detail{background:var(--n5c-surface-panel);border-radius:var(--n5c-radius-control);padding:var(--n5c-space-4);margin:var(--n5c-space-2) var(--n5c-zero) var(--n5c-zero);font-family:inherit;font-size:var(--n5c-font-xs);line-height:var(--n5c-line-sm);color:var(--n5c-text-muted);white-space:pre-wrap;overflow-x:auto}\n.n5c-page-image,.custom-n5c-page-image{max-width:var(--n5c-full);border-radius:var(--n5c-image-radius);display:block;margin:var(--n5c-image-margin) var(--n5c-zero);cursor:pointer!important;touch-action:pan-y;user-select:none;-webkit-user-select:none;-webkit-user-drag:none}\n.n5c-history-mask{position:fixed;inset:var(--n5c-zero);background:var(--n5c-overlay);display:flex;align-items:center;justify-content:center;z-index:var(--n5c-z-modal);padding:var(--n5c-space-16)}\n.n5c-history-modal{background:var(--n5c-surface-panel);border-radius:var(--n5c-panel-radius);box-shadow:var(--n5c-shadow);width:min(var(--n5c-panel-width),calc(var(--n5c-viewport-width) - var(--n5c-space-16) - var(--n5c-space-16)));max-height:calc(100dvh - var(--n5c-space-16) - var(--n5c-space-16));display:flex;flex-direction:column;gap:var(--n5c-space-8);padding:var(--n5c-space-16);overflow-y:auto;overflow-x:hidden}\n.n5c-history-head{display:flex;align-items:center;justify-content:space-between;gap:var(--n5c-space-8)}\n.n5c-history-head .n5c-icon{width:var(--n5c-icon-size);height:var(--n5c-icon-size);display:block}\n.n5c-history-title{font-size:var(--n5c-font-heading);line-height:var(--n5c-line-heading);font-weight:var(--n5c-font-medium);color:var(--n5c-text-primary)}\n.n5c-history-preview-box{display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);padding:var(--n5c-space-8);min-height:var(--n5c-zero);max-height:var(--n5c-history-preview-height);overflow:hidden}\n.n5c-history-preview-img{max-width:var(--n5c-full);max-height:calc(var(--n5c-history-preview-height) - var(--n5c-space-16));object-fit:contain;border-radius:var(--n5c-image-radius);display:block}\n.n5c-history-badge{font-size:var(--n5c-font-xs);line-height:var(--n5c-line-xs);color:var(--n5c-text-muted);margin-top:var(--n5c-space-4)}\n.n5c-history-thumbs{display:flex;gap:var(--n5c-space-8);overflow-x:auto;padding:var(--n5c-space-4) var(--n5c-zero);scrollbar-width:thin}\n.n5c-history-thumb{width:var(--n5c-history-thumb-size);height:var(--n5c-history-thumb-size);object-fit:cover;border-radius:var(--n5c-radius-control);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-transparent);cursor:pointer;flex-shrink:var(--n5c-shrink);opacity:var(--n5c-opacity-disabled)}\n.n5c-history-thumb.n5c-on{border-color:var(--n5c-tab-indicator);opacity:var(--n5c-opacity-full)}\n.n5c-history-actions{display:flex;flex-wrap:wrap;gap:var(--n5c-space-8);margin-top:var(--n5c-space-4);justify-content:flex-end}\n.n5c-select-wrap{position:relative;flex:var(--n5c-grow);width:var(--n5c-zero);min-width:var(--n5c-zero)}\n.n5c-select-trigger{display:flex;align-items:center;justify-content:space-between;height:var(--n5c-control-height);background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);padding:var(--n5c-space-4) var(--n5c-space-8);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);font-weight:var(--n5c-font-medium);color:var(--n5c-text-primary);cursor:pointer;user-select:none}\n.n5c-select-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.n5c-select-arrow{color:var(--n5c-text-muted);font-size:var(--n5c-font-xs);margin-left:var(--n5c-space-4);flex-shrink:var(--n5c-shrink);transition:transform var(--n5c-duration) var(--n5c-easing)}\n.n5c-select-wrap.n5c-open .n5c-select-arrow{transform:rotate(180deg)}\n.n5c-select-menu{position:absolute;top:calc(100% + var(--n5c-space-2));left:var(--n5c-zero);right:var(--n5c-zero);z-index:var(--n5c-z-panel);background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);box-shadow:var(--n5c-shadow);max-height:var(--n5c-log-box-max-height);overflow-y:auto;overflow-x:hidden;padding:var(--n5c-space-4) var(--n5c-zero);scrollbar-width:thin}\n.n5c-select-group{font-size:var(--n5c-font-xs);line-height:var(--n5c-line-xs);font-weight:var(--n5c-font-medium);color:var(--n5c-text-muted);padding:var(--n5c-space-4) var(--n5c-space-8) var(--n5c-space-2);user-select:none}\n.n5c-select-option{padding:var(--n5c-space-4) var(--n5c-space-8);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);color:var(--n5c-text-primary);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background var(--n5c-duration) var(--n5c-easing)}\n.n5c-select-option:hover{background:var(--n5c-surface-action)}\n.n5c-select-option.n5c-on{background:var(--n5c-surface-hover);font-weight:var(--n5c-font-medium)}\n" + "\n[data-n5c-user-story]{display:block;width:100%;min-width:0;margin:var(--n5c-space-8) 0;background:var(--n5c-surface-panel);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-control);border-radius:var(--n5c-panel-radius);overflow:hidden;box-shadow:var(--n5c-shadow);color:var(--n5c-text-primary);font-family:var(--n5c-font-family);font-size:var(--n5c-font-body);line-height:var(--n5c-line-body);text-shadow:none;text-align:left}\n[data-n5c-user-story],[data-n5c-user-story] *{box-sizing:border-box}\n[data-n5c-user-story]>summary{display:flex;align-items:center;gap:var(--n5c-space-8);list-style:none;cursor:pointer;padding:var(--n5c-header-padding);background:var(--n5c-surface-control);margin:0;user-select:none}\n[data-n5c-user-story]>summary::-webkit-details-marker{display:none}\n[data-n5c-user-story] .n5c-story-title{font-size:var(--n5c-font-heading);line-height:var(--n5c-line-heading);font-weight:var(--n5c-font-medium);flex:1;min-width:0}\n[data-n5c-user-story] .n5c-story-count,[data-n5c-user-story] .n5c-story-fold{font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);color:var(--n5c-text-muted);white-space:nowrap}\n[data-n5c-user-story] .n5c-story-count{padding:var(--n5c-space-2) var(--n5c-space-8);border-radius:var(--n5c-radius-pill);background:var(--n5c-surface-panel)}\n[data-n5c-user-story] .n5c-story-reroll{display:inline-flex;align-items:center;gap:4px;flex:none;height:22px;padding:0 8px;border:1px solid transparent;border-radius:var(--n5c-radius-pill);background:var(--n5c-surface-panel);color:var(--n5c-text-primary);font:inherit;font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);cursor:pointer;white-space:nowrap}\n[data-n5c-user-story] .n5c-story-reroll:hover{background:var(--n5c-surface-action)}\n[data-n5c-user-story] .n5c-story-reroll:focus-visible{outline:2px solid var(--n5c-focus-color);outline-offset:1px}\n[data-n5c-user-story] .n5c-story-reroll[data-state='busy']{opacity:.6;cursor:wait}\n[data-n5c-user-story] .n5c-story-reroll.shake{animation:n5c-plot-reroll-shake .4s ease}\n[data-n5c-user-story] .n5c-story-reroll svg{width:12px;height:12px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}\n@keyframes n5c-plot-reroll-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}\n[data-n5c-user-story] .n5c-story-chevron{width:var(--n5c-icon-small);height:var(--n5c-icon-small);transition:transform var(--n5c-duration) var(--n5c-easing)}\n[data-n5c-user-story][open] .n5c-story-chevron{transform:rotate(90deg)}\n[data-n5c-user-story] .n5c-story-body{padding:var(--n5c-content-padding);display:flex;flex-direction:column;gap:var(--n5c-space-12)}\n[data-n5c-user-story]:not([open])>:not(summary){display:none!important}\n[data-n5c-user-story] .n5c-story-tabs{display:flex;gap:var(--n5c-space-4);overflow-x:auto;border-bottom:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-control);scrollbar-width:thin;min-width:0}\n[data-n5c-user-story] .n5c-story-tab{flex:0 0 auto;min-height:var(--n5c-tab-height);padding:var(--n5c-space-4) var(--n5c-space-12);background:transparent;color:var(--n5c-text-muted);border:0;border-bottom:var(--n5c-border-width) var(--n5c-border-style) transparent;border-radius:0;font:inherit;font-weight:var(--n5c-font-medium);cursor:pointer;margin:0;white-space:nowrap;box-shadow:none;text-shadow:none}\n[data-n5c-user-story] .n5c-story-tab:hover{background:var(--n5c-surface-control);color:var(--n5c-text-primary)}\n[data-n5c-user-story] .n5c-story-tab[aria-selected=\"true\"]{color:var(--n5c-text-primary);border-bottom-color:var(--n5c-tab-indicator)}\n[data-n5c-user-story] .n5c-story-tab:focus-visible,[data-n5c-user-story]>summary:focus-visible,[data-n5c-user-story] .n5c-story-content:focus-visible{outline:var(--n5c-focus-width) var(--n5c-border-style) var(--n5c-focus-color);outline-offset:calc(0px - var(--n5c-focus-width))}\n[data-n5c-user-story] .n5c-story-content{display:flex;flex-direction:column;gap:var(--n5c-space-8);max-height:var(--n5c-story-content-max-height);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;min-width:0}\n[data-n5c-user-story] .n5c-story-card{padding:var(--n5c-space-12);border-radius:var(--n5c-radius-control);background:var(--n5c-surface-control);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-action);min-width:0}\n[data-n5c-user-story] [hidden]{display:none!important}\n[data-n5c-user-story] .n5c-story-card-title{font-size:var(--n5c-font-heading);line-height:var(--n5c-line-heading);font-weight:var(--n5c-font-medium);color:var(--n5c-text-primary);margin:0 0 var(--n5c-space-8);padding:0}\n[data-n5c-user-story] .n5c-story-markdown{line-height:var(--n5c-story-content-line-height);overflow-wrap:anywhere;min-width:0}\n[data-n5c-user-story] .n5c-story-markdown p{margin:0 0 var(--n5c-space-8)}\n[data-n5c-user-story] .n5c-story-markdown>:last-child{margin-bottom:0}\n[data-n5c-user-story] .n5c-story-markdown :is(h1,h2,h3,h4,h5,h6){font-size:var(--n5c-font-heading);line-height:var(--n5c-line-heading);margin:var(--n5c-space-12) 0 var(--n5c-space-8);color:var(--n5c-text-primary)}\n[data-n5c-user-story] .n5c-story-markdown :is(ul,ol){padding-left:var(--n5c-space-16);margin:var(--n5c-space-8) 0}\n[data-n5c-user-story] .n5c-story-markdown blockquote{border-left:var(--n5c-focus-width) var(--n5c-border-style) var(--n5c-tab-indicator);padding-left:var(--n5c-space-8);margin:var(--n5c-space-8) 0;color:var(--n5c-text-muted)}\n[data-n5c-user-story] .n5c-story-markdown pre{overflow:auto;padding:var(--n5c-space-8);background:var(--n5c-surface-panel);border-radius:var(--n5c-radius-control);white-space:pre-wrap}\n[data-n5c-user-story] .n5c-story-markdown table{border-collapse:collapse;width:100%;display:block;overflow:auto}\n[data-n5c-user-story] .n5c-story-markdown :is(th,td){padding:var(--n5c-space-4) var(--n5c-space-8);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-action);text-align:left}\n[data-n5c-user-story] .n5c-story-markdown a{color:var(--n5c-focus-color);text-decoration:underline}\n[data-n5c-user-story] .n5c-story-plain{white-space:pre-wrap}\n@media(prefers-reduced-motion:reduce){[data-n5c-user-story] .n5c-story-chevron{transition:none}}\n";
  /* STYLE_IMPORT_CSS_BEGIN */
  CSS += "\n.n5c-history-modal::-webkit-scrollbar,.n5c-history-thumbs::-webkit-scrollbar,.n5c-history-preview-box::-webkit-scrollbar,.n5c-history-textarea::-webkit-scrollbar,.n5c-history-reroll-details::-webkit-scrollbar,.n5c-style-import-modal::-webkit-scrollbar,.n5c-style-import-list::-webkit-scrollbar{width:6px;height:6px}\n.n5c-history-modal::-webkit-scrollbar-track,.n5c-history-thumbs::-webkit-scrollbar-track,.n5c-history-preview-box::-webkit-scrollbar-track,.n5c-history-textarea::-webkit-scrollbar-track,.n5c-history-reroll-details::-webkit-scrollbar-track,.n5c-style-import-modal::-webkit-scrollbar-track,.n5c-style-import-list::-webkit-scrollbar-track{background:transparent}\n.n5c-history-modal::-webkit-scrollbar-thumb,.n5c-history-thumbs::-webkit-scrollbar-thumb,.n5c-history-preview-box::-webkit-scrollbar-thumb,.n5c-history-textarea::-webkit-scrollbar-thumb,.n5c-history-reroll-details::-webkit-scrollbar-thumb,.n5c-style-import-modal::-webkit-scrollbar-thumb,.n5c-style-import-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.22);border-radius:3px}\n.n5c-history-modal::-webkit-scrollbar-thumb:hover,.n5c-history-thumbs::-webkit-scrollbar-thumb:hover,.n5c-history-preview-box::-webkit-scrollbar-thumb:hover,.n5c-history-textarea::-webkit-scrollbar-thumb:hover,.n5c-history-reroll-details::-webkit-scrollbar-thumb:hover,.n5c-style-import-modal::-webkit-scrollbar-thumb:hover,.n5c-style-import-list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.42)}\n.n5c-history-modal::-webkit-scrollbar-button,.n5c-history-thumbs::-webkit-scrollbar-button,.n5c-history-preview-box::-webkit-scrollbar-button,.n5c-history-textarea::-webkit-scrollbar-button,.n5c-history-reroll-details::-webkit-scrollbar-button,.n5c-style-import-modal::-webkit-scrollbar-button,.n5c-style-import-list::-webkit-scrollbar-button{display:none;width:0;height:0}\n.n5c-history-modal,.n5c-history-thumbs,.n5c-history-preview-box,.n5c-history-textarea,.n5c-history-reroll-details,.n5c-style-import-modal,.n5c-style-import-list{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.22) transparent}\n.n5c-history-stage{display:flex;flex-direction:row;align-items:stretch;gap:var(--n5c-space-12);width:100%;box-sizing:border-box}\n.n5c-history-preview-box{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);padding:8px 12px;box-sizing:border-box;max-height:440px!important;overflow:hidden;position:relative}\n.n5c-history-img-wrap{display:flex;align-items:center;justify-content:center;width:100%;max-height:400px;overflow:hidden;box-sizing:border-box}\n.n5c-history-preview-img{max-width:100%!important;max-height:400px!important;width:auto!important;height:auto!important;object-fit:contain!important;border-radius:var(--n5c-image-radius);display:block;margin:0 auto;user-select:none;-webkit-user-drag:none}\n.n5c-history-badge{flex-shrink:0;font-size:var(--n5c-font-xs);line-height:var(--n5c-line-xs);color:var(--n5c-text-muted);padding-top:4px;white-space:nowrap}\n.n5c-history-thumbs{display:flex;flex-direction:column;gap:var(--n5c-space-8);width:82px;flex-shrink:0;overflow-y:auto;overflow-x:hidden;max-height:440px;padding:2px 4px;box-sizing:border-box}\n.n5c-history-thumb{width:74px;height:98px;object-fit:cover;border-radius:var(--n5c-radius-control);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-transparent);cursor:pointer;flex-shrink:0;opacity:var(--n5c-opacity-disabled);transition:all .15s ease}\n.n5c-history-thumb:hover{opacity:.85}\n.n5c-history-thumb.n5c-on{border-color:var(--n5c-tab-indicator);opacity:var(--n5c-opacity-full);box-shadow:0 0 10px rgba(255,255,255,0.25)}\n.n5c-history-editor-card{display:flex;flex-direction:column;gap:var(--n5c-space-8);padding:var(--n5c-space-12);background:var(--n5c-surface-control);border-radius:var(--n5c-radius-control);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-action);margin-top:0;min-width:0}\n.n5c-history-editor-head{display:flex;align-items:center;justify-content:space-between;font-size:var(--n5c-font-sm);font-weight:var(--n5c-font-medium);color:var(--n5c-text-primary)}\n.n5c-history-editor-label{font-size:13px;font-weight:500;color:#d8d8e6;margin-bottom:4px;display:block;user-select:none}\n.n5c-history-textarea{width:100%;box-sizing:border-box;background:var(--n5c-surface-panel);color:var(--n5c-text-primary);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-action);border-radius:var(--n5c-radius-control);padding:var(--n5c-space-8);font-family:monospace,var(--n5c-font-family);font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);resize:vertical;min-height:64px;outline:none}\n.n5c-history-textarea:focus-visible{outline:var(--n5c-focus-width) solid var(--n5c-focus-color)}\n.n5c-history-reroll-details{margin-top:var(--n5c-space-4);background:var(--n5c-surface-panel);border-radius:var(--n5c-radius-control);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-action);padding:var(--n5c-space-4) var(--n5c-space-8);user-select:none}\n.n5c-history-reroll-summary{font-size:14px;font-weight:600;color:var(--n5c-text-primary);cursor:pointer;padding:var(--n5c-space-6) 0;list-style:none;display:flex;align-items:center;gap:6px}\n.n5c-history-reroll-summary::-webkit-details-marker{display:none}\n.n5c-history-reroll-summary::before{content:\'▶\';font-size:8px;transition:transform .15s ease;color:var(--n5c-text-muted)}\n.n5c-history-reroll-details[open] .n5c-history-reroll-summary::before{transform:rotate(90deg)}\n.n5c-history-reroll-body{padding:var(--n5c-space-8) 0 var(--n5c-space-4);display:flex;flex-direction:column;gap:var(--n5c-space-6)}\n.n5c-reroll-input{min-height:56px!important;resize:vertical}\n.n5c-history-reroll-actions{display:flex;justify-content:flex-end;margin-top:4px}\n.n5c-btn-reroll-run{background:var(--n5c-surface-action);color:var(--n5c-text-primary);border-radius:var(--n5c-radius-control);padding:6px 14px;font-size:var(--n5c-font-xs);font-weight:var(--n5c-font-medium);display:inline-flex;align-items:center;gap:6px;cursor:pointer}\n.n5c-btn-reroll-run:hover{background:var(--n5c-surface-hover)}\n.n5c-btn-reroll-run:disabled{opacity:.5;cursor:not-allowed}\n.n5c-history-editor-tools{display:flex;align-items:center;gap:var(--n5c-space-8);justify-content:flex-end}\n.n5c-history-editor-status{font-size:var(--n5c-font-xs);color:var(--n5c-text-muted);margin-right:auto}\n@media(min-width:769px){.n5c-history-modal{width:min(840px,calc(100vw - 64px));max-height:min(92dvh,920px);padding:20px 24px}.n5c-history-thumb{width:74px;height:98px}.n5c-history-textarea{min-height:88px;font-size:13px;line-height:1.5}.n5c-style-import-modal{width:min(920px,calc(100vw - 64px))!important;max-height:min(85vh,850px)!important}.n5c-style-import-drop{min-height:240px}.n5c-style-import-list{max-height:460px}}\n@media(max-width:768px){.n5c-history-preview-box{max-height:320px!important}.n5c-history-img-wrap{max-height:280px}.n5c-history-preview-img{max-height:280px!important}.n5c-history-stage{gap:var(--n5c-space-8)}.n5c-history-thumbs{width:66px;max-height:320px}.n5c-history-thumb{width:58px;height:78px}}\n";
  CSS += "\n.n5c-style-import-modal{width:min(var(--n5c-style-import-width),calc(var(--n5c-viewport-width) - var(--n5c-space-16) - var(--n5c-space-16)));max-height:min(var(--n5c-style-import-max-height),calc(100vh - var(--n5c-space-16) - var(--n5c-space-16)));overflow-y:auto;overflow-x:hidden;font-family:var(--n5c-font-family);color:var(--n5c-text-primary)}\n.n5c-style-import-modal > .n5c-history-head{flex-shrink:0}\n.n5c-style-import-tools{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:var(--n5c-space-8);flex-shrink:0}\n.n5c-style-import-count{flex:1;white-space:nowrap}\n.n5c-style-import-drop{display:flex;align-items:center;justify-content:center;white-space:normal;min-height:var(--n5c-style-import-drop-height);width:var(--n5c-full);padding:var(--n5c-space-16);border:var(--n5c-border-width) var(--n5c-style-import-drop-border-style) var(--n5c-focus-color);background:var(--n5c-surface-control);flex-shrink:0}\n.n5c-style-import-drop:hover,.n5c-style-import-drop.n5c-dragging{background:var(--n5c-surface-hover);border-color:var(--n5c-border-selected)}\n.n5c-style-import-list{display:flex;flex-direction:column;gap:var(--n5c-space-4);overflow-y:auto;overflow-x:hidden;min-height:var(--n5c-zero)}\n.n5c-style-import-drop[hidden],.n5c-style-import-list[hidden]{display:none}\n.n5c-style-import-row{display:flex;align-items:center;gap:var(--n5c-space-12);width:var(--n5c-full);min-height:var(--n5c-style-import-row-height);padding:var(--n5c-space-8) var(--n5c-space-12);text-align:left;background:var(--n5c-surface-control);flex-shrink:0}\n.n5c-style-import-row:not(:disabled):hover{background:var(--n5c-surface-hover)}\n.n5c-style-import-row[aria-checked=\"true\"]{background:var(--n5c-surface-action)}\n.n5c-style-import-name{flex:1;min-width:var(--n5c-zero);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.n5c-style-import-check{display:flex;align-items:center;justify-content:center;width:var(--n5c-style-import-check-size);height:var(--n5c-style-import-check-size);border:var(--n5c-border-width) solid var(--n5c-focus-color);border-radius:var(--n5c-half);flex-shrink:0}\n.n5c-style-import-row[aria-checked=\"true\"] .n5c-style-import-check::after{content:\"\";width:var(--n5c-style-import-check-dot);height:var(--n5c-style-import-check-dot);border-radius:var(--n5c-half);background:var(--n5c-text-primary)}\n.n5c-style-import-modal button:disabled{opacity:var(--n5c-opacity-disabled);cursor:not-allowed}\n.n5c-style-import-modal button:focus-visible{outline:var(--n5c-focus-width) solid var(--n5c-focus-color);outline-offset:var(--n5c-space-2)}\n.n5c-style-import-modal [role=\"status\"]{white-space:normal;overflow-wrap:anywhere;flex-shrink:0}\n\n.n5c-style-import-actions{display:flex;justify-content:flex-end;gap:var(--n5c-space-8);flex-shrink:0}\n";
  CSS += "\n.n5c-style-import-modal .n5c-style-import-drop,.n5c-style-import-modal .n5c-style-import-row{appearance:none;box-sizing:border-box;font-family:var(--n5c-font-family);box-shadow:none;text-shadow:none;margin:var(--n5c-zero)}\n";
  CSS += "\n.n5c-style-import-mask{height:var(--n5c-viewport-height);width:var(--n5c-viewport-width);box-sizing:border-box}\n";
  CSS += "\n#n5c-history-dialog .n5c-history-modal:not(.n5c-style-import-modal){height:min(92dvh,920px);max-height:calc(100dvh - 32px);overflow:hidden}\n#n5c-history-dialog .n5c-history-head,#n5c-history-dialog .n5c-history-actions{flex:0 0 auto}\n#n5c-history-dialog .n5c-history-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;display:flex;flex-direction:column;gap:var(--n5c-space-8)}\n#n5c-history-dialog .n5c-history-actions{padding-top:var(--n5c-space-8);border-top:1px solid var(--n5c-surface-control)}\n#n5c-history-dialog .n5c-history-empty{padding:24px;text-align:center;color:var(--n5c-text-muted)}\n#n5c-history-dialog .n5c-history-preview-img[hidden],#n5c-history-dialog .n5c-history-empty[hidden]{display:none!important}\n#n5c-history-dialog .n5c-history-form-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--n5c-space-12)}\n#n5c-history-dialog .n5c-history-request-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto;font:12px/1.5 monospace}\n#n5c-history-dialog .n5c-history-field-row{display:flex;align-items:center;flex-wrap:wrap;gap:var(--n5c-space-6)}\n#n5c-history-dialog .n5c-history-field-row input{min-width:4em;flex:1 1 7em}\n@media(max-width:768px){#n5c-history-dialog .n5c-history-form-layout{grid-template-columns:minmax(0,1fr)}#n5c-history-dialog .n5c-history-actions{justify-content:center}}\n";
  CSS += "\n#n5c-history-dialog .n5c-history-form-layout{align-items:start}\n#n5c-history-dialog .n5c-history-request-pane{position:sticky;top:0;align-self:start;height:min(70dvh,720px);min-height:0;box-sizing:border-box}\n#n5c-history-dialog .n5c-history-request-preview{flex:1 1 auto;min-height:0;max-height:none;overflow-y:auto;overflow-x:hidden;margin:0}\n#n5c-history-dialog .n5c-history-text-input{box-sizing:border-box;width:100%;min-height:34px;padding:var(--n5c-space-8);background:var(--n5c-surface-panel);color:var(--n5c-text-primary);border:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-surface-action);border-radius:var(--n5c-radius-control);font-family:var(--n5c-font-family);font-size:var(--n5c-font-sm);line-height:var(--n5c-line-sm);outline:none}\n#n5c-history-dialog .n5c-history-text-input:focus-visible{outline:var(--n5c-focus-width) solid var(--n5c-focus-color)}\n#n5c-history-dialog .n5c-history-field-row .n5c-history-text-input{width:auto}\n#n5c-history-dialog .n5c-history-reroll-summary::before{content:none}\n#n5c-history-dialog .n5c-history-zoom{position:fixed;inset:0;z-index:2;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:2vh 2vw;box-sizing:border-box;cursor:zoom-out}\n#n5c-history-dialog .n5c-history-zoom-image{display:block;max-width:96vw;max-height:96dvh;width:auto;height:auto;object-fit:contain;cursor:zoom-out}\n@media(max-width:768px){#n5c-history-dialog .n5c-history-request-pane{position:static;height:min(65dvh,520px)}}\n";
  CSS += "\n#n5c-history-dialog .n5c-history-card-tools{column-gap:var(--n5c-space-12);row-gap:var(--n5c-space-8)}\n#n5c-history-dialog .n5c-history-card-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--n5c-space-8)}\n.n5c-redraw-stage{position:relative;display:inline-flex;max-width:100%;overflow:hidden;border-radius:var(--n5c-image-radius)}\n.n5c-redraw-overlay{position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;background:rgba(10,10,16,.48);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);pointer-events:none}\n.n5c-redraw-overlay .n5c-ph-title{text-shadow:0 1px 3px #000}";
  /* STYLE_IMPORT_CSS_END */

  CSS += "\n/* 自定义尺寸复用既有间距、字体与错误颜色；不新增设计令牌。 */\n.n5c-custom-size{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--n5c-space-12);padding:var(--n5c-space-4)}\n.n5c-custom-size[hidden]{display:none!important}\n.n5c-size-field{display:flex;flex-direction:column;gap:var(--n5c-space-4);min-width:0}\n.n5c-size-field input{width:var(--n5c-full);box-sizing:border-box}\n.n5c-panel .n5c-size-field input[aria-invalid=\"true\"]{outline:var(--n5c-border-width) var(--n5c-border-style) var(--n5c-text-error);color:var(--n5c-text-error)}\n.n5c-size-hint{grid-column:1/-1}\n";

  var refs = {}, controlSequence = 0;
  var ICON_PATHS = {
    chevron: '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
    rename: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4M14 2v6h6M14 2l6 6"/><path d="m14 18 6-6 2 2-6 6-3 1Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
  };
  var LOGO_PATHS = "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M4.39575 14.1885C3.774 13.1625 3.01725 12.3105 2.11575 11.7218C2.05463 11.6798 2.00253 11.626 1.96253 11.5636C1.92253 11.5012 1.89544 11.4314 1.88286 11.3584C1.87027 11.2853 1.87245 11.2105 1.88927 11.1383C1.90608 11.0661 1.93719 10.998 1.98075 10.938C3.61275 8.823 6.14925 3.2835 7.4775 0.26925C7.6755 -0.1815 8.355 -0.03075 8.355 0.46125V8.49375C8.1103 8.60463 7.8899 8.76274 7.70647 8.95903C7.52304 9.15531 7.38019 9.38589 7.28611 9.63753C7.19203 9.88917 7.14858 10.1569 7.15826 10.4254C7.16794 10.6939 7.23055 10.9578 7.3425 11.202L4.39125 14.1885H4.39575ZM5.049 15.447C5.36025 16.14 5.62125 16.887 5.829 17.658C5.85371 17.7552 5.90995 17.8416 5.98893 17.9034C6.06791 17.9653 6.16517 17.9993 6.2655 18H12.0765C12.1768 17.9988 12.2739 17.9647 12.3529 17.9029C12.4319 17.8411 12.4884 17.7551 12.5137 17.658C12.7142 16.9014 12.9748 16.1621 13.293 15.447L11.748 13.8832L10.4595 15.1868C10.492 15.3058 10.5085 15.429 10.509 15.5565C10.509 16.3043 9.90975 16.9103 9.171 16.9103C8.81408 16.9081 8.47264 16.7642 8.22173 16.5104C7.97083 16.2565 7.83101 15.9134 7.833 15.5565C7.833 14.8088 8.43225 14.202 9.171 14.202C9.2835 14.202 9.396 14.2162 9.4995 14.2432L10.8015 12.9255L10.0673 12.183C9.79002 12.3202 9.48485 12.3916 9.1755 12.3916C8.86615 12.3916 8.56098 12.3202 8.28375 12.183L5.05875 15.447H5.049ZM13.9462 14.1885C14.568 13.1625 15.3247 12.3105 16.2262 11.7218C16.2874 11.6798 16.3395 11.626 16.3795 11.5636C16.4195 11.5012 16.4466 11.4314 16.4591 11.3584C16.4717 11.2853 16.4695 11.2105 16.4527 11.1383C16.4359 11.0661 16.4048 10.998 16.3613 10.938C14.73 8.823 12.1927 3.2835 10.8637 0.26925C10.6657 -0.1815 9.98625 -0.03075 9.98625 0.46125V8.49375C10.231 8.60463 10.4513 8.76274 10.6348 8.95903C10.8182 9.15531 10.9611 9.38589 11.0551 9.63753C11.1492 9.88917 11.1927 10.1569 11.183 10.4254C11.1733 10.6939 11.1107 10.9578 10.9987 11.202L13.95 14.1885H13.9462Z\"/>";
  function el(tag, cls, text) {
    var node = Env.pdoc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function icon(name) {
    var wrap = el("span");
    wrap.innerHTML = '<svg class="n5c-icon' + (name === "logo" ? ' n5c-logo' : '') + '" viewBox="' + (name === "logo" ? '0 0 18 18' : '0 0 24 24') + '" aria-hidden="true">' + (name === "logo" ? LOGO_PATHS : ICON_PATHS[name]) + '</svg>';
    return wrap.firstChild;
  }
  function button(text, handler, cls) {
    var node = el("button", cls || "n5c-btn", text); node.type = "button";
    if (handler) node.addEventListener("click", function () {
      Promise.resolve().then(handler).catch(function (err) { setStatus(err && err.message ? err.message : "操作失败", "error"); });
    });
    return node;
  }
  function iconButton(name, label, handler) {
    var b = button(null, handler, "n5c-iconbtn"); b.appendChild(icon(name));
    b.title = label; b.setAttribute("aria-label", label); return b;
  }
  function injectStyle() {
    var style = el("style"); style.id = STYLE_ID; style.textContent = CSS; Env.pdoc.head.appendChild(style);
  }
  function setStatus(text, kind) {
    if (!refs.foot) return;
    if (arguments[2] === "background" && kind !== "error" && Date.now() < (refs.feedbackUntil || 0)) return;
    refs.foot.textContent = text || ""; refs.foot.hidden = !text;
    refs.foot.className = "n5c-foot" + (kind === "error" ? " n5c-error" : kind === "ok" ? " n5c-ok" : "");
  }
  function settingSucceeded(label) {
    refs.feedbackUntil = Date.now() + uiNumber("feedback-hold-ms");
    setStatus("修改成功：" + label, "ok");
  }
  function saveSetting(label) {
    if (!Store.save()) throw new Error("修改未保存：本机存储不可用");
    settingSucceeded(label);
  }
  function section(pane, label) {
    var s = el("section", "n5c-section"); s.appendChild(el("h3", "n5c-h", label)); pane.appendChild(s); return s;
  }
  function input(value, type) {
    var node = el("input"); node.type = type || "text"; node.value = value == null ? "" : value; return node;
  }
  function fieldRow(label, control) {
    var row = el("div", "n5c-row"), l = el("label", null, label);
    control.id = "n5c-control-" + (++controlSequence); l.htmlFor = control.id;
    row.append(l, control); return row;
  }
  function select(options, value, onChange) {
    var currentItem = options.find(function (x) { return x.id === value; });
    var currentLabel = currentItem ? currentItem.label : (options[0] ? options[0].label : "");

    var wrap = el("div", "n5c-select-wrap");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("role", "combobox");
    wrap.setAttribute("aria-expanded", "false");

    var trigger = el("div", "n5c-select-trigger");
    var labelSpan = el("span", "n5c-select-label", currentLabel);
    var arrow = el("span", "n5c-select-arrow", "▾");
    trigger.append(labelSpan, arrow);
    wrap.appendChild(trigger);

    var menu = el("div", "n5c-select-menu");
    menu.setAttribute("role", "listbox");
    menu.hidden = true;

    var groups = {};
    options.forEach(function (x) {
      var parent = menu;
      if (x.group) {
        if (!groups[x.group]) {
          var gHead = el("div", "n5c-select-group", x.group);
          menu.appendChild(gHead);
          var gItems = el("div", "n5c-select-group-items");
          menu.appendChild(gItems);
          groups[x.group] = gItems;
        }
        parent = groups[x.group];
      }
      var opt = el("div", "n5c-select-option" + (x.id === value ? " n5c-on" : ""), x.label);
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(x.id === value));
      opt.setAttribute("data-value", x.id);
      opt.addEventListener("click", function (e) {
        e.stopPropagation();
        closeMenu();
        if (wrap.value !== x.id) {
          wrap.value = x.id;
          labelSpan.textContent = x.label;
          menu.querySelectorAll(".n5c-select-option").forEach(function (o) {
            var active = o === opt;
            o.classList.toggle("n5c-on", active);
            o.setAttribute("aria-selected", String(active));
          });
          if (onChange) {
            Promise.resolve().then(function () { return onChange(x.id); }).catch(function (err) {
              setStatus(err.message, "error");
            });
          }
        }
      });
      parent.appendChild(opt);
    });

    wrap.appendChild(menu);
    wrap._val = value;

    Object.defineProperty(wrap, "value", {
      get: function () { return wrap._val; },
      set: function (newVal) {
        wrap._val = newVal;
        var hit = options.find(function (x) { return x.id === newVal; });
        if (hit) labelSpan.textContent = hit.label;
        menu.querySelectorAll(".n5c-select-option").forEach(function (o) {
          var active = o.getAttribute("data-value") === newVal;
          o.classList.toggle("n5c-on", active);
          o.setAttribute("aria-selected", String(active));
        });
      }
    });

    function openMenu() {
      Env.pdoc.querySelectorAll(".n5c-select-wrap").forEach(function (w) {
        if (w !== wrap && w._close) w._close();
      });
      menu.hidden = false;
      wrap.classList.add("n5c-open");
      wrap.setAttribute("aria-expanded", "true");
    }

    function closeMenu() {
      menu.hidden = true;
      wrap.classList.remove("n5c-open");
      wrap.setAttribute("aria-expanded", "false");
    }
    wrap._close = closeMenu;

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    wrap.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (menu.hidden) openMenu();
        else closeMenu();
      } else if (e.key === "Escape") {
        closeMenu();
      }
    });

    var onDocClick = function (e) {
      if (!wrap.contains(e.target)) closeMenu();
    };
    Env.pdoc.addEventListener("click", onDocClick);
    lifecycle.unbinds.push(function () {
      Env.pdoc.removeEventListener("click", onDocClick);
    });

    return wrap;
  }
  function toggle(label, checked, onChange) {
    var b = button(null, async function () {
      var value = b.getAttribute("aria-checked") !== "true";
      b.setAttribute("aria-checked", String(value));
      try { if (await onChange(value) === false) throw new Error("修改未保存：本机存储不可用"); settingSucceeded(label + (value ? "已开启" : "已关闭")); }
      catch (e) { b.setAttribute("aria-checked", String(!value)); throw e; }
    }, "n5c-switch");
    b.setAttribute("role", "switch"); b.setAttribute("aria-label", label); b.setAttribute("aria-checked", String(checked));
    return fieldRow(label, b);
  }
  function pills(parent, items, selected, onPick) {
    var row = el("div", "n5c-seg"); row.setAttribute("role", "group");
    items.forEach(function (x) {
      if (!x.id) return;
      var b = button(x.label, async function () {
        row.querySelectorAll("button").forEach(function (n) { n.disabled = true; });
        try {
          await onPick(x.id);
          settingSucceeded(x.label);
          row.querySelectorAll("button").forEach(function (n) { var active = n === b; n.classList.toggle("n5c-on", active); n.setAttribute("aria-pressed", String(active)); });
        } finally { row.querySelectorAll("button").forEach(function (n) { n.disabled = false; }); }
      }, "n5c-pill" + (x.id === selected ? " n5c-on" : ""));
      b.setAttribute("aria-pressed", String(x.id === selected)); row.appendChild(b);
    });
    parent.appendChild(row);
  }
  function slider(parent, label, key, min, max, step, digits) {
    var r = input(state[key], "range"); r.className = "n5c-range"; r.min = min; r.max = max; r.step = step;
    r.setAttribute("aria-label", label);
    var out = el("output", "n5c-range-value", Number(state[key]).toFixed(digits));
    var wrap = el("div", "n5c-range-wrap"); wrap.append(r, out);
    var row = fieldRow(label, r); row.classList.add("n5c-range-row"); row.appendChild(wrap); wrap.prepend(r);
    out.htmlFor = r.id;
    r.addEventListener("input", function () { state[key] = bounded(r.value, min, max, state[key], digits); out.textContent = state[key].toFixed(digits); if (Store.save()) settingSucceeded(label + " " + out.textContent); });
    parent.appendChild(row);
  }
  // 原生确认框无法跟随变量主题，这里只保留命名与确认所需的最小内部对话框。
  function ask(title, initial) {
    if (refs.askClose) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var prior = Env.pdoc.activeElement, dialog = el("div", "n5c-dialog");
      dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", title);
      dialog.appendChild(el("div", null, title));
      var edit = initial == null ? null : input(initial);
      if (edit) { edit.maxLength = 60; edit.setAttribute("aria-label", "配置名称"); dialog.appendChild(edit); }
      var actions = el("div", "n5c-btns");
      function done(v) { refs.askClose = null; dialog.remove(); if (prior && prior.isConnected) prior.focus(); resolve(v); }
      refs.askClose = function () { done(null); };
      var cancel = button("取消", function () { done(null); });
      var ok = button("确认", function () { if (edit && !edit.value.trim()) { edit.focus(); return; } done(edit ? edit.value.trim() : true); });
      actions.append(cancel, ok); dialog.appendChild(actions); refs.panel.appendChild(dialog);
      dialog.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.stopPropagation(); done(null); }
        if (e.key === "Enter" && e.target === edit) { e.preventDefault(); ok.click(); }
        if (e.key === "Tab") {
          var focusables = Array.from(dialog.querySelectorAll("input,button")), first = focusables[0], last = focusables[focusables.length - 1];
          if (e.shiftKey && Env.pdoc.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && Env.pdoc.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
      (edit || cancel).focus(); if (edit) edit.select();
    });
  }
  function databaseApi() {
    var win = window, seen = new Set();
    while (win && !seen.has(win)) {
      seen.add(win);
      try {
        var candidates = [win.AutoCardUpdaterAPI, win.TavernHelper && win.TavernHelper.AutoCardUpdaterAPI];
        for (var i = 0; i < candidates.length; i++) {
          var api = candidates[i];
          if (api && (typeof api.importTemplateFromData === 'function' || typeof api.importPlotPresetFromData === 'function')) return api;
        }
        if (win.parent === win) break;
        win = win.parent;
      } catch (e) { break; }
    }
    try { var fallback = Env.pwin.AutoCardUpdaterAPI; if (fallback) return fallback; } catch (e) {}
    return null;
  }
  async function activateCurrentPlotPreset(api, presetName) {
    var apply = typeof api.injectPlotPresetToCurrentChat === "function" ? api.injectPlotPresetToCurrentChat : api.switchPlotPreset;
    if (typeof apply !== "function" || typeof api.getCurrentPlotPreset !== "function" || typeof api.getPlotPresets !== "function") {
      throw new Error("数据库缺少剧情预设应用或回读接口，请更新 shujuku 后重试");
    }
    var presets = await api.getPlotPresets();
    if (!Array.isArray(presets) || !presets.some(function (p) { return p && p.name === presetName; })) {
      throw new Error("已导入，但预设库回读未找到“" + presetName + "”，未执行切换");
    }
    var applied = await apply.call(api, presetName);
    var current = await api.getCurrentPlotPreset();
    if (applied !== true || current !== presetName) {
      throw new Error("已导入“" + presetName + "”，但当前聊天切换未确认；当前生效：" + (current || "无") + "。请打开目标聊天后重试");
    }
    return current;
  }

  async function installAsset(kind, b) {
    var api = databaseApi(); b.disabled = true;
    try {
      var result;
      if (!api) throw new Error("数据库未就绪，请启用 shujuku 后重试");
      var scope = kind === "template" && state.mergeScope === "global" ? "global" : "chat";
      if (kind === "template") {
        var used = await api.getTemplatePresetNames(), base = "漫画台表格模板 v" + VERSION, name = base, n = 1;
        while (used.indexOf(name) >= 0) name = base + " (" + n++ + ")";
        result = await api.importTemplateFromData(JSON.parse(JSON.stringify(BUNDLED_ASSETS.template)), { scope: "global", presetName: name });
        if (!result || !result.success) throw new Error("安装失败：" + ((result && result.message) || "插件未确认成功"));
        if (scope === "chat") {
          if (typeof api.injectTemplatePresetToCurrentChat === "function") {
            await api.injectTemplatePresetToCurrentChat(name);
          } else if (typeof api.switchTemplatePreset === "function") {
            await api.switchTemplatePreset(name, { scope: "chat" });
          }
        } else {
          if (typeof api.switchTemplatePreset === "function") {
            await api.switchTemplatePreset(name, { scope: "global" });
          }
        }
      } else {
        if (typeof api.importPlotPresetFromData !== "function" || typeof api.getCurrentPlotPreset !== "function" || typeof api.getPlotPresets !== "function" || (typeof api.injectPlotPresetToCurrentChat !== "function" && typeof api.switchPlotPreset !== "function")) {
          throw new Error("数据库缺少剧情预设导入、应用或回读接口，请更新 shujuku 后重试");
        }
        var plots = Array.isArray(BUNDLED_ASSETS.plot) ? BUNDLED_ASSETS.plot : [BUNDLED_ASSETS.plot];
        if (!plots.length || plots.some(function (p) { return !p || Array.isArray(p) || typeof p.name !== "string" || !p.name.trim(); })) throw new Error("内置剧情推进预设无效：每项必须包含名称");
        var installedNames = [];
        for (var i = 0; i < plots.length; i++) {
          var plot = JSON.parse(JSON.stringify(plots[i]));
          plot.name = plots.length === 1 ? "漫画台剧情推进 v" + VERSION : plot.name + " v" + VERSION;
          result = await api.importPlotPresetFromData(plot, { overwrite: false, switchTo: false });
          if (!result || !result.success) throw new Error("安装失败：" + ((result && result.message) || "插件未确认成功"));
          var finalPlotName = result.presetName || plot.name;
          installedNames.push(finalPlotName);
        }
        await activateCurrentPlotPreset(api, installedNames[installedNames.length - 1]);
        name = installedNames.join("、");
      }
      if (!result || !result.success) throw new Error("安装失败：" + ((result && result.message) || "插件未确认成功"));
      var applySuffix = kind === "template" ? (scope === "chat" ? "已自动应用到当前聊天" : "已自动全局生效") : "已回读确认当前聊天使用该剧情预设";
      setStatus("已导入“" + (name || result.presetName) + "”并" + applySuffix, "ok");
      addLog("success", "资产导入并应用成功", "已导入“" + (name || result.presetName) + "”并" + applySuffix);
      settingSucceeded("资产导入与切换完成");
    } finally { b.disabled = false; }
  }
  async function mergeWithActiveTemplate(b) {
    var api = databaseApi();
    if (!api || typeof api.getTableTemplate !== "function" || typeof api.importTemplateFromData !== "function") {
      setStatus("shujuku 接口不可用，请确保已启用插件", "error");
      return;
    }
    b.disabled = true;
    try {
      var scope = state.mergeScope === "global" ? "global" : "chat";
      var keepData = state.mergeKeepData !== false;

      var currentTemplate = api.getTableTemplate({ scope: scope });
      if (!currentTemplate && scope !== "global") {
        currentTemplate = api.getTableTemplate({ scope: "global" });
      }
      if (!currentTemplate || typeof currentTemplate !== "object") {
        throw new Error("未检测到当前应用的表格模板，请先在 shujuku 中选择或导入基础模板");
      }

      var usedNames = (typeof api.getTemplatePresetNames === "function" ? await api.getTemplatePresetNames() : []) || [];
      var baseName = "";

      // 1. 优先读取当前模板自身记录的 presetName
      if (currentTemplate.mate && typeof currentTemplate.mate.presetName === "string") {
        var pName = currentTemplate.mate.presetName.trim();
        if (pName && pName !== "__ACU_DEFAULT_TEMPLATE_PRESET__" && !/^\d+$/.test(pName)) {
          baseName = pName;
        }
      }

      // 2. 尝试从 shujuku 前端下拉框获取当前选中的模板预设名
      if (!baseName) {
        try {
          var chatSelect = Env.pdoc && (Env.pdoc.getElementById("acu-template-chat-preset-select") || Env.pdoc.getElementById("acu-template-preset-select"));
          var selVal = chatSelect && chatSelect.value ? String(chatSelect.value).trim() : "";
          if (selVal && selVal !== "__ACU_DEFAULT_TEMPLATE_PRESET__" && !/^\d+$/.test(selVal)) {
            baseName = selVal;
          }
        } catch (e) {}
      }

      // 3. 尝试从 SillyTavern 当前激活角色名获取
      if (!baseName) {
        try {
          var ctx = Env.pwin && Env.pwin.SillyTavern && Env.pwin.SillyTavern.getContext && Env.pwin.SillyTavern.getContext();
          if (ctx && ctx.characters && ctx.characterId != null && ctx.characters[ctx.characterId]) {
            var cObj = ctx.characters[ctx.characterId];
            var cName = cObj && typeof cObj.name === "string" ? cObj.name.trim() : "";
            if (cName && !/^\d+$/.test(cName)) {
              baseName = cName;
            }
          }
        } catch (e) {}
      }

      // 4. 兜底，绝不使用纯数字 ID
      if (!baseName || /^\d+$/.test(baseName)) {
        baseName = "基础模板";
      }

      // 清理已有缝合后缀防止多重叠加
      baseName = baseName.replace(/[\s+-]+漫画缝合版(?:\s*\(\d+\))?$/u, "").replace(/[\s+]+NAI5(?:分格)?漫画(?:\s*\(\d+\))?$/u, "").trim();

      // 命名规范：被缝合模板名-漫画缝合版
      var targetBase = baseName + "-漫画缝合版";
      var newName = targetBase;
      var counter = 1;
      while (usedNames.indexOf(newName) >= 0) {
        newName = targetBase + " (" + (counter++) + ")";
      }
      var merged = JSON.parse(JSON.stringify(currentTemplate));
      merged.mate = merged.mate || { type: "chatSheets", version: 2 };
      merged.mate.presetName = newName;

      var nai5Template = BUNDLED_ASSETS.template || {};

      for (var tk in nai5Template) {
        if (!tk.startsWith("sheet_")) continue;
        var nai5Sheet = nai5Template[tk];
        if (!nai5Sheet || typeof nai5Sheet !== "object") continue;
        var targetName = String(nai5Sheet.name || "").trim();

        // 查找当前模板中是否已存在同名表（或同 UID 表），实现精准同名覆盖
        var matchedKey = null;
        for (var k in merged) {
          if (!k.startsWith("sheet_")) continue;
          var s = merged[k];
          if (!s || typeof s !== "object") continue;
          var sName = String(s.name || "").trim();
          if (sName === targetName || k === tk || s.uid === nai5Sheet.uid) {
            matchedKey = k;
            break;
          }
        }

        var finalKey = matchedKey || tk;
        merged[finalKey] = JSON.parse(JSON.stringify(nai5Sheet));
        merged[finalKey].uid = finalKey;

        // 清理当前模板中可能存在的其他重名冗余表，杜绝重名冲突
        for (var k2 in merged) {
          if (!k2.startsWith("sheet_") || k2 === finalKey) continue;
          if (String(merged[k2].name || "").trim() === targetName) {
            delete merged[k2];
          }
        }
      }

      for (var key in merged) {
        if (!key.startsWith("sheet_")) continue;
        if (nai5Template[key]) continue;
        if (!keepData) {
          if (Array.isArray(merged[key].content) && merged[key].content.length > 0) {
            merged[key].content = [merged[key].content[0]];
          }
        }
      }

      var sheetKeys = Object.keys(merged).filter(function (k) { return k.startsWith("sheet_"); });
      sheetKeys.forEach(function (k, idx) {
        merged[k].orderNo = idx;
      });

      var importResult = await api.importTemplateFromData(merged, { scope: "global", presetName: newName });
      if (!importResult || !importResult.success) {
        throw new Error("保存缝合模板失败：" + ((importResult && importResult.message) || "未知错误"));
      }

      if (scope === "chat") {
        if (typeof api.injectTemplatePresetToCurrentChat === "function") {
          await api.injectTemplatePresetToCurrentChat(newName);
        } else if (typeof api.switchTemplatePreset === "function") {
          await api.switchTemplatePreset(newName, { scope: "chat" });
        }
      } else {
        if (typeof api.switchTemplatePreset === "function") {
          await api.switchTemplatePreset(newName, { scope: "global" });
        }
      }

      var successMsg = "已生成并挂载“" + newName + "”（" + (scope === "chat" ? "仅当前聊天生效" : "全局默认生效") + "）";
      setStatus(successMsg, "ok");
      addLog("success", "一键缝合成功", successMsg);
      settingSucceeded("一键缝合完成");
    } catch (e) {
      var errMsg = e && e.message ? e.message : String(e);
      setStatus("缝合失败：" + errMsg, "error");
      addLog("error", "一键缝合失败", errMsg);
    } finally {
      b.disabled = false;
    }
  }
  /* MOBI_EXPORT_BEGIN */
  function buildFloorMobi(images, title) {
    if (!images.length) throw new Error('楼层中没有可导出的图片');
    var enc = new TextEncoder();
    function bytes(s) { return enc.encode(s); }
    function join(parts) {
      var size = parts.reduce(function (n,p) { return n + p.length; }, 0);
      var out = new Uint8Array(size), pos = 0;
      parts.forEach(function (p) { out.set(p, pos); pos += p.length; }); return out;
    }
    function header(n) { var b = new Uint8Array(n); return { b: b, v: new DataView(b.buffer) }; }
    var html = '<html><head><title>' + String(title).replace(/[<>&]/g, '') + '</title></head><body>';
    images.forEach(function (_, i) {
      if (i) html += '<mbp:pagebreak/>';
      html += '<p align="center"><img recindex="' + (i + 1) + '" /></p>';
    });
    var text = bytes(html + '</body></html>'), chunks = [];
    for (var p = 0; p < text.length;) {
      var end = Math.min(p + 4096, text.length);
      while (end < text.length && (text[end] & 0xc0) === 0x80) end--;
      chunks.push(text.slice(p, end)); p = end;
    }
    var firstImage = 1 + chunks.length, flisIndex = firstImage + images.length, fcisIndex = flisIndex + 1;
    if (fcisIndex + 2 > 65535) throw new Error('图片数量超出 MOBI 记录限制');
    var name = bytes(title), nameOffset = 248;
    var r = header((nameOffset + name.length + 5) & ~3), v = r.v;
    v.setUint16(0, 1); v.setUint32(4, text.length); v.setUint16(8, chunks.length); v.setUint16(10, 4096);
    r.b.set(bytes('MOBI'), 16); v.setUint32(20, 232); v.setUint32(24, 2); v.setUint32(28, 65001);
    v.setUint32(32, Date.now() >>> 0); v.setUint32(36, 6);
    for (var o = 40; o <= 76; o += 4) v.setUint32(o, 0xffffffff);
    v.setUint32(80, firstImage); v.setUint32(84, nameOffset); v.setUint32(88, name.length);
    v.setUint32(92, 2052); v.setUint32(104, 6); v.setUint32(108, firstImage);
    v.setUint32(164, 0xffffffff); v.setUint32(168, 0xffffffff);
    v.setUint16(192, 1); v.setUint16(194, flisIndex - 1); v.setUint32(196, 1);
    v.setUint32(200, fcisIndex); v.setUint32(204, 1); v.setUint32(208, flisIndex); v.setUint32(212, 1);
    [224,232,236,244].forEach(function (o) { v.setUint32(o, 0xffffffff); });
    r.b.set(name, nameOffset);
    var flis = header(36); flis.b.set(bytes('FLIS'));
    flis.v.setUint32(4, 8); flis.v.setUint16(8, 65); flis.v.setUint32(16, 0xffffffff);
    flis.v.setUint16(20, 1); flis.v.setUint16(22, 3); flis.v.setUint32(24, 3);
    flis.v.setUint32(28, 1); flis.v.setUint32(32, 0xffffffff);
    var fcis = header(44); fcis.b.set(bytes('FCIS'));
    fcis.v.setUint32(4, 20); fcis.v.setUint32(8, 16); fcis.v.setUint32(12, 1);
    fcis.v.setUint32(20, text.length); fcis.v.setUint32(28, 32); fcis.v.setUint32(32, 8);
    fcis.v.setUint16(36, 1); fcis.v.setUint16(38, 1);
    var records = [r.b].concat(chunks, images, [flis.b, fcis.b, new Uint8Array([233,142,13,10])]);
    var pdb = header(78 + records.length * 8 + 2);
    pdb.b.set(bytes('MangaFloor').slice(0, 31));
    var now = Math.floor(Date.now() / 1000) + 2082844800;
    pdb.v.setUint32(36, now); pdb.v.setUint32(40, now);
    pdb.b.set(bytes('BOOKMOBI'), 60); pdb.v.setUint32(68, records.length + 1); pdb.v.setUint16(76, records.length);
    var offset = pdb.b.length;
    records.forEach(function (rec, i) {
      if (offset + rec.length > 0xffffffff) throw new Error('MOBI 文件过大');
      pdb.v.setUint32(78 + i * 8, offset); pdb.v.setUint32(82 + i * 8, i + 1); offset += rec.length;
    });
    return join([pdb.b].concat(records));
  }

  function collectFloorImageSources(message) {
    var text = String(message || '').replace(/```[^\n]*\n[\s\S]*?```/g, '');
    var api = getApi('showdown'), markdown = api && api.value;
    if (markdown && typeof markdown.Converter === 'function') text = new markdown.Converter().makeHtml(text);
    var doc = new Env.pwin.DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script, style, template').forEach(function (n) { n.remove(); });
    return Array.from(doc.querySelectorAll('img')).map(function (img) {
      var src = img.getAttribute('src') || img.getAttribute('data-src');
      if (!src) return '';
      var url = new Env.pwin.URL(src, Env.pdoc.baseURI);
      if (!/^(https?:|data:|blob:)$/.test(url.protocol)) throw new Error('不支持的图片地址协议');
      return mobiResolveImageUrl(url.href);
    }).filter(Boolean);
  }

  async function mobiImageBytes(src) {
    var controller = new Env.pwin.AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 60000);
    try {
      var response = await Env.pwin.fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error('图片读取失败（HTTP ' + response.status + '）');
      var blob = await response.blob();
      return await new Promise(function (resolve, reject) {
        var url = Env.pwin.URL.createObjectURL(blob), img = new Env.pwin.Image();
        var timeout = setTimeout(function () { finish(new Error('图片解码超时')); }, 60000), done = false;
        function finish(error, result) {
          if (done) return; done = true; clearTimeout(timeout);
          img.onload = img.onerror = null; Env.pwin.URL.revokeObjectURL(url);
          if (error) reject(error); else resolve(result);
        }
        img.onerror = function () { finish(new Error('图片无法解码')); };
        img.onload = function () {
          try {
            var canvas = Env.pdoc.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            var ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(function (jpeg) {
              if (!jpeg) return finish(new Error('图片转码失败'));
              jpeg.arrayBuffer().then(function (b) { finish(null, new Uint8Array(b)); }, finish);
            }, 'image/jpeg', 0.95);
          } catch (e) { finish(e); }
        };
        img.src = url;
      });
    } finally { clearTimeout(timer); }
  }

  async function beginMobiLoadSession() {
    var chat = Env.pdoc.getElementById('chat');
    var ctx = stContext(), epoch = sessionEpoch;
    if (!chat) throw new Error('找不到聊天视图，无法加载全部楼层');
    var original = new Set(Array.from(chat.querySelectorAll(':scope > .mes')));
    var more = chat.querySelector('#show_more_messages');
    var moreCopy = more ? more.cloneNode(true) : null;
    var next = more && more.nextSibling, top = chat.scrollTop, left = chat.scrollLeft;
    var changes = [], addedNodes = [], restored = false;
    function sameChat() {
      var now = stContext();
      return sessionEpoch === epoch && (!ctx || (now && now.chat === ctx.chat && now.chatId === ctx.chatId));
    }
    function check() { if (!sameChat()) throw new Error('聊天已切换，已取消导出'); }
    function restore() {
      if (restored) return; restored = true;
      changes.forEach(function (entry) {
        Object.keys(entry.attrs).forEach(function (key) {
          var value = entry.attrs[key];
          if (value == null) entry.img.removeAttribute(key); else entry.img.setAttribute(key, value);
        });
      });
      if (!sameChat()) return;
      addedNodes.forEach(function (node) { if (node.parentNode === chat) node.remove(); });
      if (moreCopy && !chat.querySelector('#show_more_messages')) chat.insertBefore(moreCopy, next && next.parentNode === chat ? next : chat.firstChild);
      chat.scrollTop = top; chat.scrollLeft = left;
      Env.pwin.requestAnimationFrame(function () { if (sameChat()) { chat.scrollTop = top; chat.scrollLeft = left; } });
    }
    try {
      var slash = getBoundFunction('triggerSlash');
      if (slash) await slash.fn('/chat-render');
      else if (ctx && typeof ctx.executeSlashCommandsWithOptions === 'function') await ctx.executeSlashCommandsWithOptions('/chat-render');
      else throw new Error('宿主缺少加载全部楼层的 /chat-render 接口');
      addedNodes = Array.from(chat.querySelectorAll(':scope > .mes')).filter(function (node) { return !original.has(node); });
      check();
      return {
        restore: restore, check: check,
        sources: async function (msg) {
          check();
          var node = chat.querySelector('.mes[mesid="' + Number(msg.message_id) + '"] .mes_text');
          if (!node) return collectFloorImageSources(msg.message);
          node.scrollIntoView({ block: 'center' });
          await new Promise(function (resolve) { setTimeout(resolve, 100); });
          check();
          var imgs = Array.from(node.querySelectorAll('img')), sources = [];
          for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i], lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
            var attrs = { src: img.getAttribute('src'), loading: img.getAttribute('loading') };
            changes.push({ img: img, attrs: attrs });
            img.setAttribute('loading', 'eager');
            if (lazy) img.setAttribute('src', lazy);
            mobiFixImgSrc(img);
            var src = lazy || img.currentSrc || img.getAttribute('src');
            if (!src) continue;
            if (!img.complete) await new Promise(function (resolve, reject) {
              var timer = setTimeout(function () { finish(new Error('楼层图片加载超时')); }, 60000);
              function finish(err) { clearTimeout(timer); img.removeEventListener('load', loaded); img.removeEventListener('error', failed); if (err) reject(err); else resolve(); }
              function loaded() { finish(); }
              function failed() { finish(new Error('楼层图片加载失败')); }
              img.addEventListener('load', loaded); img.addEventListener('error', failed);
              if (img.complete) finish();
            });
            check();
            var url = new Env.pwin.URL(lazy || img.currentSrc || img.getAttribute('src'), Env.pdoc.baseURI);
            if (!/^(https?:|data:|blob:)$/.test(url.protocol)) throw new Error('不支持的图片地址协议');
            sources.push(mobiResolveImageUrl(url.href));
          }
          return sources.length ? sources : collectFloorImageSources(msg.message);
        }
      };
    } catch (e) {
      if (sameChat()) addedNodes = Array.from(chat.querySelectorAll(':scope > .mes')).filter(function (node) { return !original.has(node); });
      restore(); throw e;
    }
  }

  var mobiExportBusy = false;
  // 移动端浏览器只在用户点击的同步调用栈内放行下载/分享：第一次点击只生成，第二次点击同步交付文件。
  var mobiPending = null, mobiButtonTimer = null;
  var MOBI_IDLE_TEXT = '导出为mobi', MOBI_PENDING_TTL = 5 * 60 * 1000;
  function mobiChatKey() {
    var ctx = stContext();
    return ctx && ctx.chatId != null ? String(ctx.chatId) : '';
  }
  // 存量楼层里的本机绝对地址（127.0.0.1 等）在手机上指向手机自己，导出时改到当前页面的来源
  function mobiLoopbackHost(host) {
    var h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '0.0.0.0' || h === '[::1]' || h === '::1' || /^127\./.test(h);
  }
  function mobiResolveImageUrl(href) {
    try {
      var url = new Env.pwin.URL(href), loc = Env.pwin.location;
      if (!/^https?:$/.test(url.protocol) || !mobiLoopbackHost(url.hostname) || mobiLoopbackHost(loc.hostname)) return href;
      return loc.origin + url.pathname + url.search + url.hash;
    } catch (e) { return href; }
  }
  function mobiFixImgSrc(img) {
    var raw = img.getAttribute('src');
    if (!raw) return;
    try {
      var abs = new Env.pwin.URL(raw, Env.pdoc.baseURI).href, fixed = mobiResolveImageUrl(abs);
      if (fixed !== abs) img.setAttribute('src', fixed);
    } catch (e) {}
  }
  function mobiChatTitle() {
    var name = mobiChatKey().replace(/\.jsonl$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
    name = name.replace(/^[\s.]+|[\s.]+$/g, '');
    if (name.length > 120) name = name.slice(0, 120).replace(/[\s.]+$/, '');
    return name || '漫画台-全部楼层';
  }
  function mobiReadyText(p) { return p.noShare ? '点击下载 mobi（' + p.count + ' 张）' : '点击保存 mobi（' + p.count + ' 张）'; }
  function setMobiButton(btn, text, ms) {
    if (mobiButtonTimer) { clearTimeout(mobiButtonTimer); mobiButtonTimer = null; }
    btn.textContent = text;
    if (ms) mobiButtonTimer = setTimeout(function () {
      mobiButtonTimer = null;
      if (!mobiExportBusy && !mobiPending) btn.textContent = MOBI_IDLE_TEXT;
    }, ms);
  }
  function discardMobiPending(btn) {
    if (!mobiPending) return;
    clearTimeout(mobiPending.timer); mobiPending = null;
    if (btn && !mobiExportBusy) setMobiButton(btn, MOBI_IDLE_TEXT);
  }
  function mobiPendingValid() {
    return !!mobiPending && mobiPending.epoch === sessionEpoch && mobiPending.chatKey === mobiChatKey();
  }
  function finishMobiDelivery(btn, p, how) {
    if (mobiPending === p) discardMobiPending(btn);
    setStatus('已' + how + '当前聊天全部楼层的 ' + p.count + ' 张图片', 'ok');
    addLog('success', 'MOBI 导出完成', p.floors + ' 个楼层，' + p.count + ' 张图片（' + how + '）');
  }
  function deliverMobiByLink(btn, p) {
    var url = Env.pwin.URL.createObjectURL(p.blob), a = Env.pdoc.createElement('a');
    a.href = url; a.download = p.filename; a.rel = 'noopener'; a.style.display = 'none';
    Env.pdoc.body.appendChild(a);
    try { a.click(); }
    finally {
      // 立即移除会让部分移动端浏览器取消下载
      setTimeout(function () { a.remove(); }, 1000);
      setTimeout(function () { Env.pwin.URL.revokeObjectURL(url); }, 60000);
    }
    finishMobiDelivery(btn, p, '下载');
  }
  function deliverMobi(btn) {
    var p = mobiPending, nav = Env.pwin.navigator, file = null, canShare = false;
    if (!p.noShare && nav && typeof nav.share === 'function' && typeof nav.canShare === 'function') {
      try {
        file = new Env.pwin.File([p.blob], p.filename, { type: 'application/octet-stream' });
        canShare = !!nav.canShare({ files: [file] });
      } catch (e) { canShare = false; }
    }
    if (!canShare) return deliverMobiByLink(btn, p);
    var shared;
    try { shared = nav.share({ files: [file], title: p.title }); } catch (e) { shared = Promise.reject(e); }
    btn.disabled = true;
    return Promise.resolve(shared).then(function () {
      btn.disabled = false;
      finishMobiDelivery(btn, p, '分享');
    }, function (e) {
      btn.disabled = false;
      if (mobiPending !== p) return;
      if (e && e.name === 'AbortError') {
        setMobiButton(btn, mobiReadyText(p));
        setStatus('已取消保存，可再次点击按钮保存 mobi', '');
        return;
      }
      // 异步回调里已失去点击手势，改为让用户再点一次走链接下载
      p.noShare = true; setMobiButton(btn, mobiReadyText(p));
      var msg = e && e.message ? e.message : String(e);
      setStatus('系统分享失败，请再点一次按钮直接下载：' + msg, 'error'); addLog('error', 'MOBI 分享失败', msg);
    });
  }
  // 必须由点击事件同步调用，不得包在 Promise/setTimeout 里
  function exportFloorMobi(btn) {
    if (mobiExportBusy) return;
    if (mobiPending) {
      if (mobiPendingValid()) return deliverMobi(btn);
      discardMobiPending(btn);
      setStatus('聊天已切换，已丢弃旧的 mobi，请重新导出', '');
      return;
    }
    return generateFloorMobi(btn);
  }
  async function generateFloorMobi(btn) {
    mobiExportBusy = true; btn.disabled = true;
    var loadSession = null, failed = '';
    var epoch = sessionEpoch, chatKey = mobiChatKey();
    try {
      setMobiButton(btn, '正在加载全部楼层…');
      loadSession = await beginMobiLoadSession();
      var lastId = Number(await latestMessageId());
      if (!Number.isInteger(lastId) || lastId < 0) throw new Error('当前聊天没有图片');
      var getMsgs = getBoundFunction('getChatMessages');
      if (!getMsgs) throw new Error('宿主 getChatMessages 不可用');
      var floors = await getMsgs.fn('0-' + lastId, { hide_state: 'all' });
      if (!Array.isArray(floors)) throw new Error('无法读取当前聊天的完整楼层列表');
      floors = floors.slice().sort(function (a, b) { return Number(a.message_id) - Number(b.message_id); });
      if (floors.length !== lastId + 1 || floors.some(function (m, i) { return Number(m.message_id) !== i; })) {
        throw new Error('聊天楼层读取不完整，请重试导出');
      }
      var sources = [];
      for (var floorIndex = 0; floorIndex < floors.length; floorIndex++) {
        var msg = floors[floorIndex];
        btn.textContent = '加载图片 ' + (floorIndex + 1) + '/' + floors.length;
        try { sources = sources.concat(await loadSession.sources(msg)); }
        catch (e) { throw new Error('楼层 #' + msg.message_id + '：' + e.message); }
      }
      if (!sources.length) throw new Error('当前聊天所有楼层都没有图片');
      var images = [];
      for (var i = 0; i < sources.length; i++) {
        btn.textContent = '导出中 ' + (i + 1) + '/' + sources.length;
        try { loadSession.check(); images.push(await mobiImageBytes(sources[i])); loadSession.check(); }
        catch (e) { throw new Error('第 ' + (i + 1) + ' 张图片：' + e.message); }
      }
      btn.textContent = '正在打包 mobi…';
      var title = mobiChatTitle();
      var blob = new Env.pwin.Blob([buildFloorMobi(images, title)], { type: 'application/octet-stream' });
      if (epoch !== sessionEpoch || chatKey !== mobiChatKey()) throw new Error('聊天已切换，已取消导出');
      var p = {
        blob: blob, title: title, filename: title + '.mobi', count: images.length, floors: floors.length,
        epoch: epoch, chatKey: chatKey, btn: btn, noShare: false, timer: null
      };
      p.timer = setTimeout(function () {
        if (mobiPending !== p) return;
        discardMobiPending(btn); setStatus('mobi 超过 5 分钟未保存，已丢弃，请重新导出', '');
      }, MOBI_PENDING_TTL);
      mobiPending = p;
      setStatus('mobi 已生成（' + images.length + ' 张图片），请再点一次按钮保存', 'ok');
    } catch (e) {
      failed = e && e.message ? e.message : String(e);
      setStatus('MOBI 导出失败：' + failed, 'error'); addLog('error', 'MOBI 导出失败', failed);
    } finally {
      try { if (loadSession) loadSession.restore(); }
      finally {
        mobiExportBusy = false; btn.disabled = false;
        if (mobiPending) setMobiButton(btn, mobiReadyText(mobiPending));
        else if (failed) setMobiButton(btn, '导出失败：' + (failed.length > 24 ? failed.slice(0, 24) + '…' : failed), 4000);
        else setMobiButton(btn, MOBI_IDLE_TEXT);
      }
    }
  }
  /* MOBI_EXPORT_END */

  async function renderDirectorPane() { hostApi.director.mount(refs.pane_director); }

  async function renderGeneratePane() {
    var pane = refs.pane_gen; pane.replaceChildren();

    if (hostApi.director) pane.appendChild(el("div", "n5c-hint", "通用模式：使用任意正文预设。先到编剧设置独立模型；生图时会自动为无分镜的最新模型楼层生成漫画分镜。"));
    // 1. 出图 (生图操作与并发调度)
    var gen = section(pane, "出图"), buttons = el("div", "n5c-btns");
    var run = button("为最新楼层生图", function () { return runRender({}); });
    var redraw = button("重画最新楼层", function () { return runRender({ force: true }); });
    var stop = button("中止", stopRender);
    refs.runButtons = [run, redraw]; refs.stopButton = stop; syncBusyUi();
    buttons.append(run, redraw, stop); gen.appendChild(buttons);
    var summary = el("div", "n5c-hint", "正在统计最新楼层…"); gen.appendChild(summary);
    latestMessageId().then(countPendingPages).then(function (c) { summary.textContent = "最新楼层共 " + c.total + " 页，待出图 " + c.pending + " 页，预计请求 " + c.pending + " 次"; }).catch(function () { summary.textContent = "暂无可读取的最新楼层"; });
    gen.appendChild(toggle(hostApi.director ? "正文后自动编剧并生图" : "自动出图", hostApi.director ? hostApi.director.config.auto : state.autoGenerate !== false, function (v) { if (hostApi.director) { hostApi.director.config.auto = v; hostApi.director.save(); return; } state.autoGenerate = v; return Store.save(); }));

    var concurrencyVal = Number(state.concurrency);
    if (concurrencyVal !== -1 && (isNaN(concurrencyVal) || concurrencyVal < 1)) {
      concurrencyVal = 1;
    }
    var stepperWrap = el("div", "n5c-stepper");
    var stepperDisplay = el("div", "n5c-stepper-val", String(concurrencyVal));
    var stepperArrows = el("div", "n5c-stepper-arrows");
    var upBtn = el("button", "n5c-stepper-btn up", "▲");
    upBtn.type = "button";
    upBtn.setAttribute("aria-label", "增加并发数");
    var downBtn = el("button", "n5c-stepper-btn down", "▼");
    downBtn.type = "button";
    downBtn.setAttribute("aria-label", "减少并发数");

    upBtn.addEventListener("click", function () {
      if (concurrencyVal === -1) {
        concurrencyVal = 1;
      } else {
        concurrencyVal++;
      }
      state.concurrency = concurrencyVal;
      stepperDisplay.textContent = String(concurrencyVal);
      saveSetting("并发数");
    });
    downBtn.addEventListener("click", function () {
      if (concurrencyVal > 1) {
        concurrencyVal--;
      } else if (concurrencyVal === 1) {
        concurrencyVal = -1;
      }
      state.concurrency = concurrencyVal;
      stepperDisplay.textContent = String(concurrencyVal);
      saveSetting("并发数");
    });
    stepperArrows.append(upBtn, downBtn);
    stepperWrap.append(stepperDisplay, stepperArrows);
    gen.appendChild(fieldRow("生图并发数", stepperWrap));
    gen.appendChild(el("div", "n5c-hint", "默认1，-1为不设批量限制；手动重画走独立通道，不占批量名额"));

    // 2. 数据库配套资产
    var assets = section(pane, "数据库配套资产"), api = databaseApi();
    var actions = el("div", "n5c-btns");
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "var(--n5c-space-6, 6px)";

    var templateBtn = button("导入模板", function () { return installAsset("template", templateBtn); });
    // 数据库 API 在点击时重新检测，避免初始化时序导致永久禁用。

    var mergeBtn = button("缝合模板", function () { return mergeWithActiveTemplate(mergeBtn); });
    // 数据库 API 在点击时重新检测，避免初始化时序导致永久禁用。

    var plotBtn = button("导入剧情推进", function () { return installAsset("plot", plotBtn); });
    // 数据库 API 在点击时重新检测，避免初始化时序导致永久禁用。

    actions.append(templateBtn, mergeBtn, plotBtn);
    assets.appendChild(actions);
    var scopeWrap = el("div", "n5c-scope-wrap");
    pills(scopeWrap, [
      { id: "chat", label: "仅当前聊天" },
      { id: "global", label: "全局生效" }
    ], state.mergeScope || "chat", function (v) {
      state.mergeScope = v;
      return Store.save();
    });
    assets.appendChild(fieldRow("缝合应用范围", scopeWrap));
    var keepDataToggle = toggle("保留其他表数据", state.mergeKeepData !== false, function (v) {
      state.mergeKeepData = v;
      return Store.save();
    });
    assets.appendChild(keepDataToggle);

    // 导出已迁移到酒馆扩展设置的漫画台入口。

    // 4. 运行日志 (可开关、可折叠、最近 50 条)
    var logSec = section(pane, "运行日志");
    var logBar = el("div", "n5c-btns");
    var toggleLogBtn = button(state.enableLog ? "关闭记录" : "开启记录", function () {
      state.enableLog = !state.enableLog;
      toggleLogBtn.textContent = state.enableLog ? "关闭记录" : "开启记录";
      renderLogView();
      Store.save();
      settingSucceeded(state.enableLog ? "已开启日志记录" : "已关闭日志记录");
    });
    var collapseBtn = button((state.logCollapsed ? "展开日志" : "折叠日志") + " (" + logEntries.length + ")", function () {
      state.logCollapsed = !state.logCollapsed;
      collapseBtn.textContent = (state.logCollapsed ? "展开日志" : "折叠日志") + " (" + logEntries.length + ")";
      if (refs.logContainer) refs.logContainer.style.display = state.logCollapsed ? "none" : "block";
      Store.save();
      positionPanel();
    });
    refs.logCollapseBtn = collapseBtn;
    var clearLogBtn = button("清空日志", function () {
      logEntries = [];
      renderLogView();
      collapseBtn.textContent = state.logCollapsed ? "展开日志 (0)" : "折叠日志 (0)";
      setStatus("日志已清空", "ok");
    });
    logBar.append(toggleLogBtn, collapseBtn, clearLogBtn);
    logSec.appendChild(logBar);

    var logBox = el("div", "n5c-log-box");
    if (state.logCollapsed) logBox.style.display = "none";
    refs.logContainer = logBox;
    logSec.appendChild(logBox);
    renderLogView();
  }

  function resetChatStatus() {
    sessionEpoch++; stopRender(); if (!lifecycle.destroyed && !running.busy) setStatus("等待正文生成漫画提示词", "");
  }

  async function autoRenderMessage(messageId) {
    if (!state.autoGenerate || lifecycle.destroyed || currentBatchTask !== null) return { ok: true, skipped: true };
    if (messageId == null) messageId = await latestMessageId();
    var message = await readMessage(messageId);
    if (message.role === "user" || message.role === "system" || message.is_user || message.is_system) return { ok: true, skipped: true };
    var blocks = extractBlocks(message.message || "");
    if (!blocks.length) {
      if (Number(messageId) > 0 && !nonEmpty(message.message)) {
        var detail = "正文回复为空，未产生漫画提示词；请检查正文接口返回的拒绝或错误信息。生图尚未启动。";
        setStatus(detail, "");
        addLog("info", "正文未返回内容", detail);
      }
      return { ok: true, skipped: true, reason: "waiting-for-image" };
    }
    try {
      if (typeof scanPlaceholderViews === "function") scanPlaceholderViews();
      for (var bi = 0; bi < blocks.length; bi++) {
        setPlaceholderState(messageId, bi + 1, "loading");
      }
    } catch (e) {}
    return runRender({}, messageId, true);
  }

  async function runRender(options, messageId, automatic) {
    var origin = automatic ? "background" : "";
    try {
      if (hostApi.director) { messageId = messageId == null ? hostApi.director.latest() : Number(messageId); await hostApi.director.ensurePlan(messageId); }
      var result = await renderMessage(messageId == null ? null : messageId, options, function (p) {
        var phase = { reading: "正在读取消息和词库…", generating: "生成中", saving: "保存中", done: "完成", error: "失败" }[p.phase] || p.phase;
        setStatus((p.page ? "第 " + p.page + "/" + p.total + " 页：" : "") + phase + (p.error ? "，" + p.error : ""), p.error ? "error" : "", origin);
      });
      if (!result.ok) {
        if (automatic && result.reason === "busy") return result;
        var waiting = result.reason === "no-blocks" || result.reason === "empty-message";
        var reasonMsg = result.reason === "empty-message"
          ? "正文回复为空，尚未生成漫画提示词；请先检查正文接口的拒绝或错误信息"
          : result.reason === "no-blocks"
            ? "当前楼层没有完整的 <image> 提示词块，请先让正文 AI 生成漫画提示词"
            : "当前任务仍在执行，可点击中止结束后重试";
        setStatus(reasonMsg, "", origin);
        if (!automatic) addLog("info", waiting ? "等待正文提示词" : "任务未启动", reasonMsg);
        return result;
      }
      var status = (result.cancelled ? "已中止。" : "") + "完成 " + result.done + " 页，跳过 " + result.skipped + " 页，失败 " + result.failed + " 页";
      if (result.error) status += "；" + result.error;
      setStatus(status, result.failed ? "error" : "ok", origin);
      addLog(result.failed ? "error" : "success", "楼层生图" + (result.cancelled ? "中止" : "完成"), status);
      return result;
    } catch (e) { setStatus("出图失败：" + e.message, "error", origin); }
    finally {
      // busy 拒绝也不能把现有任务的按钮解锁。
      syncBusyUi();
      if (!lifecycle.destroyed && refs.currentTab === "gen") await renderGeneratePane();
    }
  }

  function isCategoryFiltered(catName) {
    if (!catName) return true;
    var raw = String(state.categoryFilter || "").trim();
    if (!raw) return false;
    var rules = raw.split(/[,，\s]+/).filter(Boolean);
    var lower = catName.toLowerCase();
    return rules.some(function (r) {
      return lower.indexOf(r.toLowerCase()) >= 0;
    });
  }

  function categoryFromName(name) {
    var text = String(name || "").replace(/^[^一-龥A-Za-z0-9]+/, "");
    var bar = text.indexOf("丨"); if (bar >= 0) text = text.slice(bar + 1);
    var dash = text.indexOf("-");
    if (dash <= 0 || dash >= text.length - 1) return null;
    var catName = text.slice(0, dash).trim();
    var itemLabel = text.slice(dash + 1).trim();
    if (!/[\u4e00-\u9fa5]/.test(catName)) return null;
    if (isCategoryFiltered(catName)) return null;
    return { name: catName, label: itemLabel };
  }
  function isLibraryCategory(name) {
    return /^(画师串|画风|正面|正面词|正面词库|负面|负面词|负面词库)$/i.test(name);
  }
  function collectDynamicGroups(rows) {
    var map = {}, order = [];
    rows.forEach(function (row) {
      var c = categoryFromName(row.name);
      if (!c) return;
      if (!map[c.name]) {
        map[c.name] = { key: c.name, label: c.name, items: [] };
        order.push(map[c.name]);
      }
      map[c.name].items.push(Object.assign({}, row, { label: c.label }));
    });
    return order;
  }
  function libraryKey(label) {
    if (/画师串|画风/.test(label)) return "style";
    return null;
  }
  async function openStyleImportDialog() {
    if (refs.styleImportClose) return;
    var loadedApi = getBoundFunction("getLoadedPresetName");
    if (!loadedApi || !getBoundFunction("getPreset") || !getBoundFunction("replacePreset")) throw new Error("当前酒馆助手不支持画风导入，请更新后重试");
    var targetName = await loadedApi.fn();
    if (!targetName || targetName === "in_use") throw new Error("请先选择一个可保存的预设");
    if (refs.styleImportClose || lifecycle.destroyed) return;
    var session = { rows: [], selected: new Set(), batch: null, phase: "empty", worker: null, workerUrl: null, closed: false };
    var prior = Env.pdoc.activeElement;
    var mask = el("div", "n5c-history-mask n5c-style-import-mask");
    var modal = el("div", "n5c-history-modal n5c-style-import-modal");
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", "导入画风"); modal.tabIndex = -1;
    var heading = el("div", "n5c-history-head");
    var title = el("span", "n5c-history-title", "导入画风");
    var closeButton = iconButton("close", "关闭画风导入", function () { close(); });
    heading.append(title, closeButton);
    var tools = el("div", "n5c-style-import-tools");
    var count = el("span", "n5c-hint n5c-style-import-count", "尚未读取文件");
    var allButton = button("全选", function () {
      var countBefore = session.selected.size;
      session.rows.forEach(function (row, index) { if (row.selectable) session.selected.add(index); });
      if (session.selected.size !== countBefore) session.batch = null;
      refreshSelection();
    });
    var clearButton = button("取消", function () { session.selected.clear(); session.batch = null; refreshSelection(); });
    clearButton.setAttribute("aria-label", "取消全部选择");
    var submitButton = button("确认导入", async function () {
      if (session.phase !== "ready" || !session.selected.size) return;
      session.phase = "saving"; refreshSelection();
      status.textContent = "正在保存到“" + targetName + "”…"; status.classList.remove("n5c-error");
      try {
        if (await loadedApi.fn() !== targetName) throw new Error("当前预设已切换，请关闭后重新导入");
        if (!session.batch) {
          var readApi = getBoundFunction("getPreset");
          var current = await readApi.fn("in_use");
          var selectedRows = session.rows.filter(function (_, index) { return session.selected.has(index); });
          session.batch = buildStyleImportBatch(current, selectedRows);
        }
        var saved = await saveImportedStyles(targetName, session.batch);
        if (session.closed || lifecycle.destroyed) return;
        session.phase = "ready";
        close();
        PromptLibrary.invalidate();
        await renderPresetPane(true);
        if (!lifecycle.destroyed) {
          setStatus("已导入 " + saved.count + " 条画风，当前画风保持不变", "ok");
          addLog("success", "画风导入完成", "已保存到“" + targetName + "”：" + saved.count + " 条，同名自动加后缀");
          if (refs.styleImportButton && refs.styleImportButton.isConnected) refs.styleImportButton.focus();
        }
      } catch (error) {
        if (!session.closed) {
          session.phase = "ready"; status.textContent = error.message || "保存失败，请重试";
          status.classList.add("n5c-error"); refreshSelection();
        }
      }
    });
    var actionGroup = el("div", "n5c-style-import-actions");
    actionGroup.append(allButton, clearButton, submitButton);
    tools.append(count, actionGroup);
    var status = el("div", "n5c-hint", "支持通用画风数组与 st-chatu8 预设，只导入名称与提示词，不读取图片预览");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    var drop = button("拖入一个 JSON 文件，或点击选择文件", function () { if (session.phase !== "loading") fileInput.click(); }, "n5c-btn n5c-style-import-drop");
    var fileInput = el("input"); fileInput.type = "file"; fileInput.accept = ".json,application/json"; fileInput.hidden = true;
    var list = el("div", "n5c-style-import-list"); list.hidden = true; list.setAttribute("role", "group"); list.setAttribute("aria-label", "画风选择列表");
    var rowButtons = [];
    function stopWorker() {
      if (session.worker) { session.worker.onmessage = null; session.worker.onerror = null; session.worker.terminate(); session.worker = null; }
      if (session.workerUrl) { Env.pwin.URL.revokeObjectURL(session.workerUrl); session.workerUrl = null; }
      fileInput.value = "";
    }
    function close(force) {
      if (session.closed || (session.phase === "saving" && force !== true)) return;
      session.closed = true; stopWorker();
      session.rows = []; session.selected.clear(); session.batch = null; rowButtons = [];
      mask.remove(); refs.styleImportClose = null;
      if (prior && prior.isConnected) prior.focus();
    }
    function refreshSelection() {
      var ready = session.phase === "ready";
      var valid = session.rows.filter(function (row) { return row.selectable; }).length;
      allButton.disabled = !ready || !valid;
      clearButton.disabled = !ready || !session.selected.size;
      submitButton.disabled = !ready || !session.selected.size;
      closeButton.disabled = session.phase === "saving";
      if (session.phase === "saving") modal.focus();
      drop.disabled = session.phase === "loading" || session.phase === "saving";
      submitButton.textContent = session.phase === "saving" ? "正在导入…" : "确认导入";
      count.textContent = session.rows.length ? "已选 " + session.selected.size + " / " + valid + "，共 " + session.rows.length + " 项" : "尚未读取文件";
      rowButtons.forEach(function (row, index) {
        row.disabled = !ready || !session.rows[index].selectable;
        row.setAttribute("aria-checked", String(session.selected.has(index)));
      });
    }
    function showRows(rows) {
      session.rows = rows; session.selected.clear(); session.batch = null; session.phase = "ready";
      drop.hidden = true; list.hidden = false; list.replaceChildren(); rowButtons = [];
      rows.forEach(function (row, index) {
        var item = button(null, function () {
          if (session.phase !== "ready" || !row.selectable) return;
          if (session.selected.has(index)) session.selected.delete(index); else session.selected.add(index);
          session.batch = null; refreshSelection();
        }, "n5c-btn n5c-style-import-row");
        item.setAttribute("role", "checkbox"); item.setAttribute("aria-checked", "false");
        item.setAttribute("aria-label", row.name + (row.reason ? "，" + row.reason : ""));
        var name = el("span", "n5c-style-import-name", row.name + (row.reason ? " · " + row.reason : ""));
        name.title = row.name;
        item.append(name, el("span", "n5c-style-import-check"));
        list.appendChild(item); rowButtons.push(item);
      });
      status.textContent = rows.length ? "选择需要的画风；取消仅清空勾选，同名画风将自动加后缀。" : "文件中没有画风条目。";
      refreshSelection();
      var first = rowButtons.find(function (row) { return !row.disabled; });
      if (first) first.focus();
    }
    function failRead(message) {
      stopWorker(); session.phase = "empty"; session.rows = []; session.selected.clear(); session.batch = null;
      drop.hidden = false; list.hidden = true; list.replaceChildren(); rowButtons = [];
      status.textContent = message || "JSON 读取失败，请重新选择"; status.classList.add("n5c-error"); refreshSelection();
    }
    function readFile(files) {
      if (session.phase === "loading" || session.phase === "saving") return;
      if (!files || files.length !== 1) { failRead("一次请选择一个 JSON 文件"); return; }
      var file = files[0]; fileInput.value = "";
      if (!/\.json$/i.test(file.name || "")) { failRead("请选择 .json 文件"); return; }
      stopWorker(); session.phase = "loading"; session.selected.clear(); session.batch = null;
      status.classList.remove("n5c-error"); status.textContent = "正在解析 0%…"; refreshSelection();
      try {
        var code = "(" + styleImportWorkerMain.toString() + ")(" + createStyleJsonParser.toString() + ");";
        session.workerUrl = Env.pwin.URL.createObjectURL(new Env.pwin.Blob([code], { type: "text/javascript" }));
        session.worker = new Env.pwin.Worker(session.workerUrl);
        session.worker.onmessage = function (event) {
          if (session.closed) return;
          var data = event.data;
          if (data.type === "progress") status.textContent = "正在解析 " + Math.floor(data.total ? data.loaded / data.total * 100 : 0) + "%（" + data.count + " 项）…";
          else if (data.type === "done") { stopWorker(); showRows(data.rows); }
          else if (data.type === "error") failRead(data.message);
        };
        session.worker.onerror = function () { if (!session.closed) failRead("解析任务启动或执行失败，请检查浏览器 Worker 支持后重试"); };
        session.worker.postMessage({ file: file });
        file = null;
      } catch (error) { file = null; failRead(error.message); }
    }
    fileInput.addEventListener("change", function () { var files = Array.from(fileInput.files || []); readFile(files); });
    drop.addEventListener("dragover", function (event) { event.preventDefault(); if (session.phase !== "loading") drop.classList.add("n5c-dragging"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("n5c-dragging"); });
    drop.addEventListener("drop", function (event) { event.preventDefault(); drop.classList.remove("n5c-dragging"); readFile(Array.from(event.dataTransfer.files || [])); });
    mask.addEventListener("dragover", function (event) { event.preventDefault(); });
    mask.addEventListener("drop", function (event) { event.preventDefault(); });
    mask.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        var focusable = Array.from(modal.querySelectorAll("button:not(:disabled), input:not(:disabled)")).filter(function (item) { return !item.hidden && item.getClientRects().length; });
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); modal.focus(); return; }
        if (event.shiftKey && Env.pdoc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && Env.pdoc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    modal.append(heading, tools, status, drop, fileInput, list); mask.appendChild(modal); Env.pdoc.body.appendChild(mask); pinOverlays();
    refs.styleImportClose = close;
    refreshSelection(); drop.focus();
  }

  async function renderPresetPane(force) {
    var pane = refs.pane_preset, epoch = (refs.presetEpoch || 0) + 1; refs.presetEpoch = epoch;
    pane.replaceChildren(el("div", "n5c-hint", "正在读取当前预设…"));
    if (force) PromptLibrary.invalidate();
    var res = await PresetAdapter.current(); if (!res.ok) { pane.replaceChildren(el("div", "n5c-error", res.reason)); return; }
    var rows = presetRows(res.preset || {}), groups = collectDynamicGroups(rows);
    var lib = await PromptLibrary.load(!!force); pane.replaceChildren();
    if (!lib.ok) { pane.appendChild(el("div", "n5c-error", lib.reason)); return; }

    groups.forEach(function (g) {
      var sectionNode = section(pane, g.label), lk = libraryKey(g.label);
      var stateKey = lk ? (lk === "style" ? "styleId" : lk + "Id") : null;
      var activeId;
      if (lk) {
        var found = g.items.find(function (x) {
          return x.identifier === state[stateKey] || x.label === state[stateKey];
        });
        if (!found) {
          found = g.items.find(function (x) { return x.enabled; });
        }
        activeId = found ? found.identifier : (g.items[0] && g.items[0].identifier);
        if (activeId && state[stateKey] !== activeId) {
          state[stateKey] = activeId;
          Store.save();
        }
      } else {
        var active = g.items.find(function (x) { return x.enabled; });
        activeId = active ? active.identifier : null;
      }
      if (g.items.length < 1) return;

      pills(sectionNode, g.items.map(function (x) { return { id: x.identifier, label: x.label }; }), activeId, async function (id) {
        var item = g.items.find(function (x) { return x.identifier === id; });
        if (lk) {
          await chooseLibraryItem(lk, id, g.items);
          settingSucceeded((item && item.label) || g.label);
          await renderPresetPane();
          return;
        }
        var isToggleOff = (activeId === id);
        var desired = {};
        g.items.forEach(function (x) { desired[x.identifier] = isToggleOff ? false : (x.identifier === id); });
        var update = await PresetAdapter.applyEnabled(desired);
        if (!update.ok) throw new Error(update.reason || "预设修改失败");
        settingSucceeded(isToggleOff ? (g.label + "已关闭") : ((item && item.label) || g.label));
        await renderPresetPane();
      });
    });

    if (!groups.length) pane.appendChild(el("div", "n5c-warn", "当前预设没有可按“分类-选项”识别的条目。"));

    // 排除分类已迁移到酒馆扩展设置的漫画台入口。

    var reload = el("div", "n5c-seg");
    reload.appendChild(button("重读提示词库", async function () { await renderPresetPane(true); setStatus("已重读当前预设", "ok"); }));
    refs.styleImportButton = button("导入画风", openStyleImportDialog);
    reload.appendChild(refs.styleImportButton);
    refs.styleExportButton = button("导出画风", exportStyles);
    reload.appendChild(refs.styleExportButton);
    pane.appendChild(reload);
    if (hostApi.director) hostApi.director.mountEditor(pane);

    positionPanel();
  }
  function connectionFields(p) { return { channel: p.channel === "mirror" ? "mirror" : "official", customUrl: String(p.customUrl || ""), naiToken: String(p.naiToken || "") }; }
  function beginConnection(id) {
    var p = state.connectionProfiles.find(function (x) { return x.id === id; });
    refs.connectionId = p ? p.id : ""; refs.connectionDraft = connectionFields(p || {}); refs.connectionDirty = false;
  }
  async function applyConnection(p) {
    await ConnectionStore.update(function (next) { next.activeConnectionId = p ? p.id : ""; });
  }
  async function saveConnection() {
    if (!ConnectionStore.ready) await ConnectionStore.load();
    var old = state.connectionProfiles.find(function (p) { return p.id === refs.connectionId; });
    var name = old ? old.name : await ask("保存 API 配置：输入名称", "新连接"); if (!name) return;
    if (!old && state.connectionProfiles.some(function (p) { return p.name === name; })) throw new Error("已有同名配置，请使用不同名称");
    var p = Object.assign({ id: old ? old.id : "connection-" + Date.now(), name: name }, connectionFields(refs.connectionDraft));
    if (!p.naiToken) throw new Error("请填写 Key 后再保存 API 配置");
    naiEndpoint(p);
    await ConnectionStore.update(function (next) {
      var index = next.connectionProfiles.findIndex(function (x) { return x.id === p.id; });
      if (index < 0 && next.connectionProfiles.some(function (x) { return x.name === p.name; })) throw new Error("已有同名配置，请使用不同名称");
      if (index < 0) next.connectionProfiles.push(p); else next.connectionProfiles[index] = p;
      next.activeConnectionId = p.id;
    });
    beginConnection(p.id); renderSettingPane(); setStatus("已保存 API 配置", "ok");
  }
  function renderParameters(parent) {
    var s = section(parent, "模型参数");
    s.appendChild(fieldRow("模型", el("span", "n5c-hint", "nai-diffusion-5-full（仅支持）")));
    var customSize = el("div", "n5c-custom-size");
    customSize.hidden = state.sizeMode !== "custom";
    refs.sizeDraftInvalid = false;
    var sizeHint = el("div", "n5c-hint n5c-size-hint", "宽高须为 64 的倍数（64–2048）");
    var widthInput = input(state.width, "number"), heightInput = input(state.height, "number");
    [widthInput, heightInput].forEach(function (control, index) {
      control.min = "64"; control.max = "2048"; control.step = "64";
      control.id = "n5c-control-" + (++controlSequence);
      control.setAttribute("aria-describedby", "n5c-custom-size-hint");
      var field = el("div", "n5c-size-field"), label = el("label", "n5c-hint", index ? "高" : "宽");
      label.htmlFor = control.id;
      field.append(label, control); customSize.appendChild(field);
      control.addEventListener("input", function () {
        var validWidth = isValidImageSize(widthInput.value, 64), validHeight = isValidImageSize(64, heightInput.value);
        widthInput.setAttribute("aria-invalid", String(!validWidth));
        heightInput.setAttribute("aria-invalid", String(!validHeight));
        widthInput.setCustomValidity(validWidth ? "" : "宽须为 64–2048 之间的 64 倍数");
        heightInput.setCustomValidity(validHeight ? "" : "高须为 64–2048 之间的 64 倍数");
        refs.sizeDraftInvalid = !validWidth || !validHeight;
        sizeHint.classList.toggle("n5c-error", refs.sizeDraftInvalid);
        sizeHint.textContent = refs.sizeDraftInvalid ? "宽高须为 64–2048 之间的 64 倍数；当前输入未保存，修正后才能出图" : "宽高须为 64 的倍数（64–2048）";
        if (refs.sizeDraftInvalid) return;
        state.width = Number(widthInput.value); state.height = Number(heightInput.value);
        state.sizeMode = "custom";
        saveSetting("自定义尺寸 " + state.width + "×" + state.height);
      });
    });
    sizeHint.id = "n5c-custom-size-hint";
    customSize.appendChild(sizeHint);
    var sizeOptions = [{ id: "custom", label: "自定义" }].concat(NAI_SIZES.map(function (x) { return { id: x.w + "x" + x.h, label: x.label, group: x.group }; }));
    s.appendChild(fieldRow("尺寸", select(sizeOptions, state.sizeMode === "custom" ? "custom" : state.width + "x" + state.height, function (value) {
      state.sizeMode = value === "custom" ? "custom" : "preset";
      if (value !== "custom") { var pair = value.split("x"); state.width = Number(pair[0]); state.height = Number(pair[1]); }
      widthInput.value = state.width; heightInput.value = state.height;
      [widthInput, heightInput].forEach(function (control) { control.setCustomValidity(""); control.setAttribute("aria-invalid", "false"); });
      refs.sizeDraftInvalid = false;
      sizeHint.classList.remove("n5c-error"); sizeHint.textContent = "宽高须为 64 的倍数（64–2048）";
      customSize.hidden = state.sizeMode !== "custom";
      saveSetting("尺寸"); positionPanel();
    })));
    s.appendChild(customSize);
    var names = ["Euler", "Euler Ancestral", "DPM++ 2S Ancestral", "DPM++ 2M SDE", "DPM++ 2M", "DPM++ SDE"];
    s.appendChild(fieldRow("采样器", select(NAI_SAMPLERS.map(function (id, i) { return { id: id, label: names[i] }; }), state.sampler, function (v) { state.sampler = v; saveSetting("采样器"); })));
    slider(s, "步数", "steps", 1, 50, 1, 0);
    slider(s, "提示词引导值", "scale", 0, 10, 0.1, 1);
    slider(s, "缩放引导值", "cfgRescale", 0, 1, 0.01, 2);
    var seed = input(state.seed); seed.inputMode = "numeric"; seed.placeholder = "留空随机，填写数字锁定种子";
    seed.addEventListener("change", function () {
      var v = seed.value.trim();
      if (v !== "" && (!/^\d+$/.test(v) || Number(v) > 4294967295)) { seed.setCustomValidity("请输入 0–4294967295 的整数，或留空随机"); seed.reportValidity(); seed.value = state.seed; return; }
      seed.setCustomValidity(""); state.seed = v === "" ? "" : Number(v); saveSetting("种子");
    });
    seed.addEventListener("input", function () { seed.setCustomValidity(""); });
    s.appendChild(fieldRow("种子", seed));
  }
  function renderSettingPane() {
    var pane = refs.pane_set; pane.replaceChildren();
    if (!refs.connectionDraft) beginConnection(state.activeConnectionId);
    var s = section(pane, "API");
    var options = [{ id: "", label: "--新建预设--" }].concat(state.connectionProfiles.map(function (p) { return { id: p.id, label: p.name }; }));
    var profiles = select(options, refs.connectionId, async function (id) {
      if (refs.connectionDirty && !await ask("放弃未保存的连接编辑并切换？")) { profiles.value = refs.connectionId; return; }
      try {
        if (id) await applyConnection(state.connectionProfiles.find(function (p) { return p.id === id; }));
        beginConnection(id);
        renderSettingPane();
      } catch (e) { profiles.value = refs.connectionId; throw e; }
    });
    var row = fieldRow("选择预设", profiles);
    row.appendChild(iconButton("save", "保存配置", saveConnection));
    var rename = iconButton("rename", "重命名配置", async function () {
      var p = state.connectionProfiles.find(function (x) { return x.id === refs.connectionId; }); if (!p) return;
      var name = await ask("重命名 API 配置", p.name); if (!name) return;
      if (state.connectionProfiles.some(function (x) { return x.id !== p.id && x.name === name; })) throw new Error("已有同名配置");
      await ConnectionStore.update(function (next) {
        var target = next.connectionProfiles.find(function (x) { return x.id === p.id; });
        target.name = name;
      });
      renderSettingPane(); setStatus("配置已重命名", "ok");
    });
    var remove = iconButton("trash", "删除配置", async function () {
      var p = state.connectionProfiles.find(function (x) { return x.id === refs.connectionId; });
      if (!p || !await ask("删除配置“" + p.name + "”？将移除该 v3 配置及其 Key；迁移前的 v2 历史存储保持不变。")) return;
      await ConnectionStore.update(function (next) {
        next.connectionProfiles = next.connectionProfiles.filter(function (x) { return x.id !== p.id; });
        next.activeConnectionId = "";
      });
      beginConnection(""); renderSettingPane(); setStatus("已删除配置", "ok");
    });
    rename.disabled = remove.disabled = !refs.connectionId; row.append(rename, remove); s.appendChild(row);
    var validPool = getValidConnectionProfiles();
    var rotateRow = toggle("账号轮询", !!state.accountRotationEnabled, async function (v) {
      await ConnectionStore.update(function (next) { next.accountRotationEnabled = v; });
      renderSettingPane();
      return true;
    });
    var rotateHint = el("div", "n5c-hint", "开启后按已保存配置顺序逐张轮换（当前有效连接: " + validPool.length + " 个）；手动重画也参与轮询");
    s.append(rotateRow, rotateHint);
    var draft = refs.connectionDraft;
    s.appendChild(fieldRow("通道", select([{ id: "official", label: "官网直连" }, { id: "mirror", label: "自定义" }], draft.channel, function (v) { draft.channel = v; refs.connectionDirty = true; renderSettingPane(); })));
    var url = input(draft.channel === "official" ? "https://image.novelai.net/ai/generate-image" : draft.customUrl);
    url.placeholder = "https://your-proxy.example"; url.disabled = draft.channel === "official";
    url.addEventListener("input", function () { draft.customUrl = url.value; refs.connectionDirty = true; });
    s.append(fieldRow("URL", url), el("div", "n5c-hint", "填站点根地址自动补 /ai/generate-image，填写完整地址则原样使用"));
    var key = input(draft.naiToken, "password"); key.autocomplete = "off"; key.placeholder = "pst…";
    key.addEventListener("input", function () { draft.naiToken = key.value; refs.connectionDirty = true; });
    s.append(fieldRow("Key", key), el("div", "n5c-hint", "Key 明文存于酒馆当前用户的服务器文件；有该用户文件访问权限者可读取，不写入聊天变量"));
    var test = button("测试", async function () {
      test.disabled = true; setStatus("正在测试当前表单连接…");
      try { await NAI.generate("simple circle, white background", "", Object.assign({}, draft, { width: 512, height: 512, steps: 4 })); setStatus("连接测试成功", "ok"); }
      catch (e) { setStatus(e.message || "连接测试失败", "error"); }
      finally { test.disabled = false; }
    });
    var actions = el("div", "n5c-seg"); actions.appendChild(test); s.append(actions, el("div", "n5c-hint", "测试会发起一次真实生图请求，可能消耗额度"));

    renderParameters(pane); positionPanel();
  }
  /* 图片缓存：独立 IndexedDB，不修改聊天历史；ZIP 使用标准 STORE 容器。 */
  var imageCacheDbPromise = null, imageCacheSelected = new Set(), imageCacheUrls = [];
  var imageCacheBusy = false, imageCachePage = 0, imageCacheRenderId = 0;
  function imageCacheDb() {
    if (!imageCacheDbPromise) imageCacheDbPromise = new Promise(function (resolve, reject) {
      var req = Env.pwin.indexedDB.open('n5c-image-cache-v1', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('images', { keyPath: 'id' }); };
      req.onsuccess = function () { var db = req.result; db.onversionchange = function () { db.close(); imageCacheDbPromise = null; }; resolve(db); };
      req.onerror = function () { imageCacheDbPromise = null; reject(req.error); };
      req.onblocked = function () { setStatus('图片缓存数据库被其他页面占用，请关闭旧页面后重试', 'error'); };
    });
    return imageCacheDbPromise;
  }
  async function imageCacheRequest(mode, action) {
    var db = await imageCacheDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('images', mode), req = action(tx.objectStore('images'));
      tx.oncomplete = function () { resolve(req && req.result); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('缓存事务失败')); };
    });
  }
  async function cacheGeneratedImage(bytes) {
    try {
      var id = Date.now() + '-' + Env.pwin.crypto.randomUUID();
      await imageCacheRequest('readwrite', function (s) { return s.put({ id: id, created: Date.now(), filename: 'comic-' + id + '.png', blob: new Blob([bytes], { type: 'image/png' }) }); });
      if (refs.currentTab === 'cache' && !lifecycle.destroyed) await renderImageCachePane();
    } catch (e) {
      addLog('error', '图片缓存失败', e.message || String(e));
      setStatus('图片已生成，但缓存失败：' + (e.message || e), 'error');
    }
  }
  function imageCacheReleaseUrls() {
    imageCacheUrls.forEach(function (u) { Env.pwin.URL.revokeObjectURL(u); }); imageCacheUrls = [];
  }
  function imageCacheSave(blob, name) {
    var url = Env.pwin.URL.createObjectURL(blob), a = Env.pdoc.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none'; Env.pdoc.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { Env.pwin.URL.revokeObjectURL(url); }, 60000);
  }
  function imageCacheCrc(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) { crc ^= bytes[i]; for (var b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function imageCacheZip(items) {
    if (items.length > 65535) throw new Error('单次最多打包 65535 张图片');
    var parts = [], central = [], offset = 0, centralSize = 0;
    for (var i = 0; i < items.length; i++) {
      var bytes = new Uint8Array(await items[i].blob.arrayBuffer()), name = new TextEncoder().encode(items[i].filename);
      if (offset + bytes.length + name.length + 30 > 0xffffffff) throw new Error('压缩包超过 4GB，请分批下载');
      var crc = imageCacheCrc(bytes), local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true); lv.setUint16(12, 33, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true); lv.setUint16(26, name.length, true); local.set(name, 30);
      var dir = new Uint8Array(46 + name.length), dv = new DataView(dir.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x800, true); dv.setUint16(14, 33, true);
      dv.setUint32(16, crc, true); dv.setUint32(20, bytes.length, true); dv.setUint32(24, bytes.length, true); dv.setUint16(28, name.length, true); dv.setUint32(42, offset, true); dir.set(name, 46);
      parts.push(local, items[i].blob); central.push(dir); offset += local.length + bytes.length; centralSize += dir.length;
    }
    if (offset + centralSize > 0xffffffff) throw new Error('压缩包超过 4GB，请分批下载');
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }
  async function imageCacheDownload(ids) {
    if (imageCacheBusy || !ids.length) return;
    imageCacheBusy = true;
    try {
      var items = [];
      for (var i = 0; i < ids.length; i++) {
        var item = await imageCacheRequest('readonly', function (s) { return s.get(ids[i]); });
        if (!item) throw new Error('部分图片已不存在，请刷新列表'); items.push(item);
      }
      if (items.length >= 10) imageCacheSave(await imageCacheZip(items), '漫画图片-' + Date.now() + '.zip');
      else for (var j = 0; j < items.length; j++) {
        imageCacheSave(items[j].blob, items[j].filename);
        if (j < items.length - 1) await new Promise(function (resolve) { setTimeout(resolve, 300); });
      }
      setStatus('已发起 ' + items.length + ' 张图片下载' + (items.length < 10 && items.length > 1 ? '；如有拦截，请允许浏览器多文件下载' : ''), 'success');
    } catch (e) { setStatus('下载失败：' + e.message, 'error'); }
    finally { imageCacheBusy = false; }
  }
  var imageCacheViewerClose = null;
  async function imageCacheDeleteSelected() {
    if (imageCacheBusy || !imageCacheSelected.size) return;
    var ids = Array.from(imageCacheSelected);
    imageCacheBusy = true;
    try {
      if (!await ask('删除选中的 ' + ids.length + ' 张缓存图片？删除后无法恢复。')) return;
      if (lifecycle.destroyed) return;
      await imageCacheRequest('readwrite', function (store) {
        ids.forEach(function (id) { store.delete(id); });
      });
      ids.forEach(function (id) { imageCacheSelected.delete(id); });
      if (imageCacheViewerClose) imageCacheViewerClose();
      await renderImageCachePane();
      setStatus('已删除 ' + ids.length + ' 张缓存图片', 'success');
    } catch (e) { setStatus('删除缓存失败：' + (e.message || e), 'error'); }
    finally { imageCacheBusy = false; }
  }
  function imageCacheOpenViewer(items, id) {
    if (imageCacheViewerClose) imageCacheViewerClose();
    var index = items.findIndex(function (item) { return item.id === id; });
    if (index < 0 || lifecycle.destroyed) return;
    var prior = Env.pdoc.activeElement, url = null, start = null, closed = false;
    var host = el('dialog'), surface = el('div'), shadow = surface.attachShadow({ mode: 'open' });
    surface.style.cssText = 'display:block!important;width:100%!important;height:100%!important;max-height:none!important'; host.appendChild(surface);
    var mask = el('div'), stage = el('div'), img = el('img'), caption = el('div'), controls = el('div');
    host.id = 'n5c-cache-viewer';
    host.setAttribute('aria-label', '缓存图片大图预览');
    var isolatedStyle = el('style');
    isolatedStyle.textContent = ':host{all:initial}*{box-sizing:border-box}button:disabled{opacity:.35;cursor:default!important}';
    shadow.append(isolatedStyle, mask);
    function sizeViewer() {
      var v = Env.pwin.visualViewport;
      var w = v ? v.width : Env.pwin.innerWidth, h = v ? v.height : Env.pwin.innerHeight;
      var styles = {position:'fixed',left:(v ? v.offsetLeft : 0)+'px',top:(v ? v.offsetTop : 0)+'px',right:'auto',bottom:'auto',width:w+'px',height:h+'px','max-width':'none','max-height':'none','min-width':'0','min-height':'0',margin:'0',padding:'0',border:'0',background:'#080808',opacity:'1',transform:'none',filter:'none',overflow:'hidden','z-index':'2147483647',display:'block','box-sizing':'border-box'};
      Object.keys(styles).forEach(function (key) { host.style.setProperty(key,styles[key],'important'); });
      mask.style.width = w+'px'; mask.style.height = h+'px';
    }
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true'); mask.setAttribute('aria-label', '缓存图片大图预览');
    mask.style.cssText = 'position:relative;background:#080808;color:#fff;display:flex;flex-direction:column;padding:12px;box-sizing:border-box;overscroll-behavior:contain;font:14px/1.4 sans-serif;text-shadow:none;overflow:hidden';
    stage.style.cssText = 'position:relative;flex:1 1 0;min-height:0;min-width:0;width:100%;display:flex;align-items:center;justify-content:center;touch-action:pan-y pinch-zoom;overflow:hidden';
    img.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;user-select:none;-webkit-user-select:none'; img.draggable = false;
    caption.style.cssText = 'flex:0 0 auto;text-align:center;padding:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px'; caption.setAttribute('aria-live','polite');
    controls.style.cssText = 'display:flex;justify-content:center;gap:12px;flex-wrap:wrap;flex-shrink:0';
    function close() {
      if (closed) return; closed = true;
      Env.pdoc.removeEventListener('keydown', onKey, true);
      Env.pwin.removeEventListener('resize', sizeViewer);
      if (Env.pwin.visualViewport) { Env.pwin.visualViewport.removeEventListener('resize', sizeViewer); Env.pwin.visualViewport.removeEventListener('scroll', sizeViewer); }
      if (host.open) host.close(); host.remove(); if (url) Env.pwin.URL.revokeObjectURL(url);
      imageCacheViewerClose = null;
      if (prior && prior.isConnected) prior.focus();
    }
    function show(delta) {
      index = Math.max(0, Math.min(items.length - 1, index + delta));
      var oldUrl = url; url = Env.pwin.URL.createObjectURL(items[index].blob);
      img.src = url; img.alt = items[index].filename;
      if (oldUrl) Env.pwin.URL.revokeObjectURL(oldUrl);
      caption.textContent = (index + 1) + ' / ' + items.length + ' · 左右滑动切换';
      prev.disabled = index === 0; next.disabled = index === items.length - 1;
    }
    var prev = button('← 上一张', function () { show(-1); });
    var next = button('下一张 →', function () { show(1); });
    var exit = button('关闭 ✕', close);
    [prev,next,exit].forEach(function (b) { b.style.cssText = 'padding:10px 16px;border:1px solid #777;border-radius:8px;background:#252525;color:#fff;cursor:pointer'; });
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(e.key === 'ArrowLeft' ? -1 : 1); }
      else if (e.key === 'Tab') {
        var buttons = [prev,next,exit].filter(function (b) { return !b.disabled; });
        var i = buttons.indexOf(shadow.activeElement);
        e.preventDefault(); buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
      }
    }
    stage.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary || e.button !== 0) { start = null; return; }
      start = { x:e.clientX, y:e.clientY, id:e.pointerId }; stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointerup', function (e) {
      if (!start || start.id !== e.pointerId) return;
      var dx = e.clientX-start.x, dy = e.clientY-start.y; start = null;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)*1.25) show(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', function () { start = null; });
    stage.addEventListener('lostpointercapture', function () { start = null; });
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    stage.appendChild(img); controls.append(prev,next,exit); mask.append(stage,caption,controls);
    Env.pdoc.body.appendChild(host); imageCacheViewerClose = close;
    sizeViewer();
    if (typeof host.showModal === 'function') host.showModal();
    else host.setAttribute('open', '');
    host.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    Env.pwin.addEventListener('resize', sizeViewer);
    if (Env.pwin.visualViewport) { Env.pwin.visualViewport.addEventListener('resize', sizeViewer); Env.pwin.visualViewport.addEventListener('scroll', sizeViewer); }
    Env.pdoc.addEventListener('keydown', onKey, true); show(0); exit.focus();
  }
  async function renderImageCachePane() {
    var pane = refs.pane_cache, renderId = ++imageCacheRenderId;
    var items = await imageCacheRequest('readonly', function (s) { return s.getAll(); });
    if (renderId !== imageCacheRenderId || refs.currentTab !== 'cache' || lifecycle.destroyed) return;
    items.sort(function (a, b) { return b.created - a.created; });
    var valid = new Set(items.map(function (x) { return x.id; }));
    imageCacheSelected.forEach(function (id) { if (!valid.has(id)) imageCacheSelected.delete(id); });
    imageCacheReleaseUrls(); pane.replaceChildren();
    pane.appendChild(el('div', 'n5c-hint', '生成图片自动缓存到当前浏览器（含重画版本）。刷新保留；清理网站数据会删除缓存。1–9 张下载原图，10 张及以上下载 ZIP。勾选后可删除；双击图片放大，左右滑动切换。'));
    var toolbar = el('div', 'n5c-seg'), count = el('div', 'n5c-hint'), grid = el('div');
    toolbar.style.flexWrap = 'wrap'; grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:12px';
    function update() { count.textContent = '共 ' + items.length + ' 张 · 已选 ' + imageCacheSelected.size + ' 张'; grid.querySelectorAll('input').forEach(function (x) { x.checked = imageCacheSelected.has(x.value); }); }
    toolbar.append(button('全选', function () { items.forEach(function (x) { imageCacheSelected.add(x.id); }); update(); }), button('取消全选', function () { imageCacheSelected.clear(); update(); }), button('下载所选', function () { imageCacheDownload(Array.from(imageCacheSelected)); }), button('删除所选', imageCacheDeleteSelected), button('刷新', function () { renderImageCachePane().catch(function (e) { setStatus(e.message, 'error'); }); }));
    pane.append(toolbar, count, grid); update();
    imageCachePage = Math.max(0, Math.min(imageCachePage, Math.ceil(items.length / 40) - 1));
    items.slice(imageCachePage * 40, imageCachePage * 40 + 40).forEach(function (item) {
      var card = el('div'), label = el('label'), check = el('input'), img = el('img');
      check.type = 'checkbox'; check.value = item.id; check.checked = imageCacheSelected.has(item.id); check.setAttribute('aria-label', '选择 ' + item.filename);
      check.onchange = function () { if (check.checked) imageCacheSelected.add(item.id); else imageCacheSelected.delete(item.id); update(); };
      var url = Env.pwin.URL.createObjectURL(item.blob); imageCacheUrls.push(url); img.src = url; img.alt = item.filename; img.loading = 'lazy'; img.style.cssText = 'width:100%;height:150px;object-fit:contain;display:block';
      img.style.cursor = 'zoom-in'; img.style.touchAction = 'manipulation'; img.tabIndex = 0; img.title = '双击放大查看';
      img.addEventListener('dblclick', function (e) { e.preventDefault(); e.stopPropagation(); imageCacheOpenViewer(items, item.id); });
      img.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); imageCacheOpenViewer(items, item.id); } });
      var lastTap = null;
      img.addEventListener('pointerup', function (e) {
        if (e.pointerType !== 'touch' || !e.isPrimary) return;
        var now = Date.now();
        if (lastTap && now - lastTap.time < 320 && Math.abs(e.clientX-lastTap.x) < 25 && Math.abs(e.clientY-lastTap.y) < 25) {
          lastTap = null; e.preventDefault(); imageCacheOpenViewer(items, item.id);
        } else lastTap = { time:now, x:e.clientX, y:e.clientY };
      });
      label.append(check, el('span', 'n5c-hint', ' 选择')); card.append(label, img, el('div', 'n5c-hint', new Date(item.created).toLocaleString()), button('下载原图', function () { imageCacheDownload([item.id]); })); grid.appendChild(card);
    });
    if (!items.length) grid.appendChild(el('div', 'n5c-hint', '暂无缓存，启用此预设后新生成的图片会自动显示在这里。'));
    var pages = el('div', 'n5c-seg');
    function turn(delta) { imageCachePage += delta; renderImageCachePane().catch(function (e) { setStatus(e.message, 'error'); }); }
    var prev = button('上一页', function () { turn(-1); }), next = button('下一页', function () { turn(1); }); prev.disabled = imageCachePage === 0; next.disabled = (imageCachePage + 1) * 40 >= items.length;
    pages.append(prev, el('span', 'n5c-hint', (imageCachePage + 1) + ' / ' + Math.max(1, Math.ceil(items.length / 40))), next); pane.appendChild(pages); positionPanel();
  }

  function switchTab(key) {
    if (key !== "cache") { imageCacheRenderId++; imageCacheReleaseUrls(); if (imageCacheViewerClose) imageCacheViewerClose(); }
    ["gen", "director", "cast", "preset", "cache", "set"].forEach(function (k) {
      refs["tab_" + k].classList.toggle("n5c-on", k === key);
      refs["tab_" + k].setAttribute("aria-selected", String(k === key));
      refs["pane_" + k].hidden = k !== key;
    });
    refs.currentTab = key;
    var task = key === "cast" ? hostApi.director.library.mount(refs.pane_cast) : key === "director" ? renderDirectorPane() : key === "gen" ? renderGeneratePane() : key === "preset" ? renderPresetPane() : key === "cache" ? renderImageCachePane() : renderSettingPane();
    Promise.resolve(task).then(function () { positionPanel(); Env.pwin.requestAnimationFrame(positionPanel); }).catch(function (e) { setStatus("面板读取失败：" + e.message, "error"); });
  }
  function visibleRect() {
    var win = Env.pwin, vv = win.visualViewport;
    if (vv) return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
    return { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
  }
  function placeOrb(left, top) {
    var inset = uiNumber("viewport-inset"), size = uiNumber("orb-size"), v = visibleRect();
    var minL = v.left + inset, minT = v.top + inset;
    var maxL = v.left + v.width - size - inset, maxT = v.top + v.height - size - inset;
    refs.orb.style.left = (maxL < minL ? minL : Math.max(minL, Math.min(left, maxL))) + "px";
    refs.orb.style.top = (maxT < minT ? minT : Math.max(minT, Math.min(top, maxT))) + "px";
    refs.orb.style.right = "var(--n5c-auto)";
    refs.orb.style.bottom = "var(--n5c-auto)";
  }
  function pinOverlays() {
    var v = visibleRect(), pad = uiNumber("space-16");
    if (!isFinite(pad)) pad = 16;
    var masks = Env.pdoc.querySelectorAll(".n5c-history-mask");
    for (var i = 0; i < masks.length; i++) {
      var node = masks[i];
      node.style.left = v.left + "px";
      node.style.top = v.top + "px";
      node.style.right = "auto";
      node.style.bottom = "auto";
      node.style.width = v.width + "px";
      node.style.height = v.height + "px";
      var modal = node.querySelector(".n5c-history-modal");
      if (modal) modal.style.maxHeight = Math.max(0, v.height - pad - pad) + "px";
    }
  }
  function positionPanel() {
    if (!refs.panel || !refs.orb || !refs.panel.classList.contains("n5c-open")) return;
    var orb = refs.orb.getBoundingClientRect(), inset = uiNumber("viewport-inset"), gap = uiNumber("panel-orb-gap");
    if (state.hideOrb) {
      var orbLeft = parseFloat(refs.orb.style.left), orbTop = parseFloat(refs.orb.style.top);
      orb = { left: orbLeft || inset, top: orbTop || inset, right: (orbLeft || inset) + uiNumber('orb-size') };
    }
    var v = visibleRect();
    var width = Math.min(uiNumber("panel-width"), Math.max(0, v.width - inset - inset));
    var maxH = Math.max(0, v.height - inset - inset);
    refs.panel.style.width = width + "px";
    refs.panel.style.maxHeight = maxH + "px";
    var height = Math.min(refs.panel.offsetHeight || maxH, maxH);
    var minL = v.left + inset, maxL = v.left + v.width - width - inset;
    var left = orb.left - width - gap;
    if (left < minL) left = orb.right + gap;
    left = maxL < minL ? minL : Math.max(minL, Math.min(left, maxL));
    var minT = v.top + inset, maxT = v.top + v.height - height - inset;
    var top = maxT < minT ? minT : Math.max(minT, Math.min(orb.top, maxT));
    refs.panel.style.left = left + "px";
    refs.panel.style.top = top + "px";
  }
  function togglePanel(force) {
    var open = force == null ? !refs.panel.classList.contains("n5c-open") : force;
    if (refs.styleImportClose) refs.styleImportClose(true);
    if (refs.askClose) refs.askClose();
    var oldDialog = Env.pdoc.getElementById("n5c-history-dialog");
    if (oldDialog) oldDialog.remove();
    refs.panel.classList.toggle("n5c-open", open); refs.orb.classList.toggle("n5c-open", open && !state.hideOrb);
    syncOrbVisibility();
    refs.orb.setAttribute("aria-expanded", String(open));
    if (open) { positionPanel(); switchTab(refs.currentTab || "gen"); refs["tab_" + (refs.currentTab || "gen")].focus(); }
    else if (!state.hideOrb) refs.orb.focus();
  }
  /* NATIVE_FLOATING_UI_BEGIN */
  function syncOrbVisibility() {
    if (!refs.orb) return;
    refs.orb.hidden = !!state.hideOrb;
    refs.orb.style.display = state.hideOrb ? 'none' : '';
    if (state.hideOrb) refs.orb.classList.remove('n5c-open');
  }
  function bindPanelInteractions(head) {
    var drag = null, suppressDragClick = false;
    function resetDragClick() { suppressDragClick = false; }
    head.style.touchAction = 'none'; head.style.cursor = 'move';
    function down(e) {
      if (e.button !== 0 || e.target.closest('button,input,select,textarea,a')) return;
      var o = state.hideOrb ? { left: parseFloat(refs.orb.style.left), top: parseFloat(refs.orb.style.top) } : refs.orb.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, orbLeft: o.left, orbTop: o.top, moved: false };
      head.setPointerCapture(e.pointerId); e.preventDefault();
    }
    function move(e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < uiNumber('drag-threshold')) return;
      drag.moved = true;
      placeOrb(drag.orbLeft + dx, drag.orbTop + dy);
      positionPanel();
    }
    function up(e) {
      if (!drag) return;
      var moved = drag.moved; drag = null;
      suppressDragClick = moved;
      try { head.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        state.orbPos = { left: parseFloat(refs.orb.style.left), top: parseFloat(refs.orb.style.top) };
        Store.save();
      }
    }
    function outside(e) {
      if (suppressDragClick) { suppressDragClick = false; return; }
      if (!refs.panel.classList.contains('n5c-open')) return;
      if (refs.panel.contains(e.target) || refs.orb.contains(e.target)) return;
      if (e.target.closest('.n5c-history-mask,.n5c-ask-mask,.n5c-style-import-mask,#nai5-comic-console-extension,button,a,input,select,textarea,[role="button"],.menu_button,.qr--button')) return;
      togglePanel(false);
    }
    head.addEventListener('pointerdown',down); head.addEventListener('pointermove',move);
    head.addEventListener('pointerup',up); head.addEventListener('pointercancel',up);
    Env.pdoc.addEventListener('pointerdown',resetDragClick,true);
    Env.pdoc.addEventListener('click',outside);
    lifecycle.unbinds.push(function () {
      Env.pdoc.removeEventListener('pointerdown',resetDragClick,true);
      Env.pdoc.removeEventListener('click',outside);
      head.removeEventListener('pointerdown',down); head.removeEventListener('pointermove',move);
      head.removeEventListener('pointerup',up); head.removeEventListener('pointercancel',up);
    });
  }
  function registerNativeEntries() {
    var host = Env.pdoc.getElementById('extensions_settings2') || Env.pdoc.getElementById('extensions_settings');
    if (!host) { warn('酒馆扩展设置入口不可用'); return; }
    var previous = Env.pdoc.getElementById(APP_ID + '-extension');
    if (previous) previous.remove();
    var root = el('div', 'extension_container'); root.id = APP_ID + '-extension';
    var drawer = el('div', 'inline-drawer');
    var title = el('div', 'inline-drawer-toggle inline-drawer-header');
    title.append(el('strong', null, '漫画台'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    var content = el('div', 'inline-drawer-content');
    var label = el('label', 'checkbox_label'), hide = el('input'); hide.type='checkbox';hide.checked=!!state.hideOrb;
    label.append(hide, el('span', null, '隐藏悬浮按钮'));
    hide.addEventListener('change', function () {state.hideOrb=hide.checked;syncOrbVisibility();positionPanel();Store.save();});
    var filterLabel=el('label',null,'排除分类'), filter=el('input','text_pole');
    filter.id=APP_ID+'-category-filter';filterLabel.htmlFor=filter.id;filter.value=state.categoryFilter||'';
    filter.placeholder='分类关键词，逗号或空格分隔';
    filter.addEventListener('change',function () {state.categoryFilter=filter.value.trim();Store.save();if(refs.currentTab==='preset')renderPresetPane();});
    var open=button('打开/关闭漫画台',function () {togglePanel();},'menu_button');
    var mobi=button('导出为mobi',null,'menu_button');
    // 同步调用：移动端只在点击事件的同步调用栈内放行下载/分享
    mobi.addEventListener('click',function () {
      function fail(err) {setStatus(err&&err.message?err.message:'操作失败','error');}
      try { var r=exportFloorMobi(mobi); if (r&&typeof r.then==='function') r.then(null,fail); } catch (err) {fail(err);}
    });
    var actions=el('div','flex-container flexGap5');
    actions.style.display='flex'; actions.style.flexWrap='wrap';
    [open,mobi].forEach(function (b) {
      b.style.width='auto'; b.style.minWidth='max-content'; b.style.flex='0 0 auto';
      b.style.whiteSpace='nowrap'; b.style.writingMode='horizontal-tb';
    });
    actions.append(open,mobi);
    content.append(label,filterLabel,filter,actions);
    drawer.append(title,content);root.append(drawer);host.append(root);
    var getEvent=getBoundFunction('getButtonEvent'), on=getBoundFunction('eventOn');
    if (getEvent && on) {
      var handle=on.fn(getEvent.fn('漫画台'),function () {togglePanel();});
      if(handle&&typeof handle.stop==='function')lifecycle.unbinds.push(function () { handle.stop(); });
    }
    lifecycle.unbinds.push(function () {root.remove();});
    syncOrbVisibility();
  }
  /* NATIVE_FLOATING_UI_END */

  function buildUi() {
    injectStyle();
    lifecycle.unbinds.push(imageCacheReleaseUrls);
    lifecycle.unbinds.push(function () { if (imageCacheViewerClose) imageCacheViewerClose(); });
    var orb = button(null, null, "n5c-orb"); orb.appendChild(icon("logo"));
    orb.title = "漫画台"; orb.setAttribute("aria-label", "打开漫画台"); orb.setAttribute("aria-expanded", "false"); refs.orb = orb;
    if (state.orbPos && Number.isFinite(state.orbPos.left) && Number.isFinite(state.orbPos.top)) {
      placeOrb(state.orbPos.left, state.orbPos.top);
    }
    var drag = null, suppressClick = false;
    orb.addEventListener("click", function () { if (suppressClick) { suppressClick = false; return; } togglePanel(); });
    orb.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, rect: orb.getBoundingClientRect(), moved: false };
      orb.setPointerCapture(e.pointerId);
    });
    orb.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < uiNumber("drag-threshold")) return;
      drag.moved = true; orb.classList.add("n5c-dragging");
      placeOrb(drag.rect.left + dx, drag.rect.top + dy);
      positionPanel();
    });
    function finishDrag(e) {
      if (!drag) return; suppressClick = drag.moved;
      if (drag.moved) { var r = orb.getBoundingClientRect(); state.orbPos = { left: Math.round(r.left), top: Math.round(r.top) }; Store.save(); }
      drag = null; orb.classList.remove("n5c-dragging"); try { orb.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    orb.addEventListener("pointerup", finishDrag); orb.addEventListener("pointercancel", finishDrag);
    var panel = el("div", "n5c-panel"); panel.id = APP_ID + "-panel"; refs.panel = panel;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "漫画台设置"); orb.setAttribute("aria-controls", panel.id);
    var head = el("div", "n5c-head"); head.append(icon("logo"), el("span", "n5c-title", "漫画台"), el("span", "n5c-ver", "v" + VERSION));
    var close = iconButton("close", "关闭", function () { togglePanel(false); }); close.classList.add("n5c-close"); head.appendChild(close); panel.appendChild(head);
    var tabs = el("div", "n5c-tabs"); tabs.setAttribute("role", "tablist");
    [["gen", "控制台"], ["director", "编剧"], ["cast", "角色 / 服装"], ["preset", "预设"], ["cache", "图片缓存"], ["set", "连接"]].forEach(function (t) {
      var b = button(t[1], function () { switchTab(t[0]); }, "n5c-tab"); b.setAttribute("role", "tab"); b.id = "n5c-tab-" + t[0]; b.setAttribute("aria-controls", "n5c-pane-" + t[0]); refs["tab_" + t[0]] = b; tabs.appendChild(b);
    });
    tabs.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      var keys = ["gen", "director", "cast", "preset", "cache", "set"], i = keys.indexOf(refs.currentTab || "gen"), key = keys[(i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]; e.preventDefault(); switchTab(key); refs["tab_" + key].focus();
    });
    panel.appendChild(tabs);
    var body = el("div", "n5c-body");
    ["gen", "director", "cast", "preset", "cache", "set"].forEach(function (k) { var pane = el("div", "n5c-pane"); pane.hidden = true; pane.id = "n5c-pane-" + k; pane.setAttribute("role", "tabpanel"); pane.setAttribute("aria-labelledby", "n5c-tab-" + k); refs["pane_" + k] = pane; body.appendChild(pane); });
    panel.appendChild(body); refs.foot = el("div", "n5c-foot"); refs.foot.hidden = true; refs.foot.setAttribute("role", "status"); refs.foot.setAttribute("aria-live", "polite"); panel.appendChild(refs.foot);
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); togglePanel(false); } });
    Env.pdoc.body.append(orb, panel);
    bindPanelInteractions(head);
    registerNativeEntries();
    var resize = function () {
      var r = state.hideOrb && state.orbPos ? state.orbPos : orb.getBoundingClientRect(), v = visibleRect(), size = uiNumber("orb-size");
      var left = state.orbPos ? r.left : v.left + v.width - size - uiNumber("orb-right");
      var top = state.orbPos ? r.top : v.top + v.height - size - uiNumber("orb-bottom");
      placeOrb(left, top);
      positionPanel();
      pinOverlays();
    };
    resize();
    Env.pwin.addEventListener("resize", resize);
    Env.pwin.addEventListener("orientationchange", resize);
    var vv = Env.pwin.visualViewport;
    if (vv) { vv.addEventListener("resize", resize); vv.addEventListener("scroll", resize); }
    lifecycle.unbinds.push(function () {
      Env.pwin.removeEventListener("resize", resize);
      Env.pwin.removeEventListener("orientationchange", resize);
      if (vv) { vv.removeEventListener("resize", resize); vv.removeEventListener("scroll", resize); }
    });
  }

  /* ------------------------------------------------------------
   * 事件与启动
   * ---------------------------------------------------------- */

  /* USER_STORY_VIEW_BEGIN：仅渲染用户层显示，原文仍从宿主聊天只读获取。 */
  var USER_STORY_LABELS = {
    recall: "记忆召回", lookup: "设定检索", scene: "场景", beat: "戏剧节拍", story: "剧情大纲", act: "角色演出",
    boundary: "认知边界", plot_track: "铺垫与伏笔", story_state: "推进状态", input: "用户输入", user_input: "用户输入",
    "本轮用户输入": "用户输入", thinking: "规划记录", thought: "规划记录", comic_plan: "规划记录",
    present: "当前情况", cb: "角色边界", soul: "角色状态", chaos: "事件", track: "状态跟踪",
    dm_story: "剧情线", dm_track: "场外动向"
  };
  function splitUserStorySections(raw) {
    var text = String(raw == null ? "" : raw);
    // 归一化可能存在的嵌套重复外层标签（如 <scene><scene> -> <scene>）
    text = text.replace(/<([a-z_0-9]+)>\s*<\1>/gi, "<$1>");
    text = text.replace(/<\/\s*([a-z_0-9]+)>\s*<\/\1>/gi, "</$1>");

    var sections = [], end = 0;
    var pattern = /<(recall|lookup|scene|beat|story|act|boundary|plot_track|story_state|input|user_input|本轮用户输入|thinking|thought|comic_plan|present|cb|soul|chaos|track|dm_story|dm_track)\s*>([\s\S]*?)<\/\1\s*>/gi;

    function push(key, content) {
      var trimmed = String(content || "").trim();
      // 剥离因模型输出或模板嵌套残留的孤立闭合标签（如 </scene>）
      trimmed = trimmed.replace(/^<\/[a-z_0-9]+>\s*/gi, "").replace(/\s*<\/[a-z_0-9]+>$/gi, "").trim();
      if (!trimmed || /^<\/[a-z_0-9]+>$/i.test(trimmed)) return;
      // 剥离内容开头意外包含的未闭合开始标签
      trimmed = trimmed.replace(/^<[a-z_0-9]+>\s*/i, "").replace(/\s*<\/[a-z_0-9]+>$/i, "").trim();
      if (!trimmed) return;
      sections.push({ key: key, title: USER_STORY_LABELS[key] || (key === "input_text" ? "用户输入" : "补充说明"), text: trimmed });
    }

    var match;
    while ((match = pattern.exec(text))) {
      push(end === 0 ? "input_text" : "notes", text.slice(end, match.index));
      push(match[1].toLowerCase(), match[2]);
      end = pattern.lastIndex;
    }
    push(end === 0 ? "input_text" : "notes", text.slice(end));
    if (!sections.length) sections.push({ key: "input_text", title: "用户输入", text: "（空白内容）" });
    return sections;
  }
  function escapeUserStoryHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function renderUserStoryContent(target, raw) {
    var showdownApi = getApi("showdown"), purifierApi = getApi("DOMPurify");
    var markdown = showdownApi && showdownApi.value, purifier = purifierApi && purifierApi.value;
    if (!markdown || typeof markdown.Converter !== "function" || !purifier || typeof purifier.sanitize !== "function") {
      target.textContent = raw;
      target.classList.add("n5c-story-plain");
      return;
    }
    var converter = new markdown.Converter({ tables: true, simpleLineBreaks: true, strikethrough: true, literalMidWordUnderscores: true });
    // 用户 HTML 先转义，再解析 Markdown；图片以可读链接展示，不自动请求外部图片。
    var escaped = escapeUserStoryHtml(raw).replace(/!\[([^\]]*)\]\(([^\n]+?)\)/g, "[图片：$1]($2)");
    var html = converter.makeHtml(escaped);
    target.innerHTML = purifier.sanitize(html, {
      ALLOWED_TAGS: ["p", "br", "strong", "em", "b", "i", "u", "del", "s", "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "hr", "a"],
      ALLOWED_ATTR: ["href", "title", "start", "colspan", "rowspan"],
      ALLOW_DATA_ATTR: false,
      RETURN_DOM: false, RETURN_DOM_FRAGMENT: false, RETURN_TRUSTED_TYPE: false,
      FORBID_TAGS: ["script", "style", "iframe", "form", "input", "button", "img", "svg", "math"]
    });
    target.querySelectorAll("a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href && !/^(https?:|mailto:|#)/i.test(href)) a.removeAttribute("href");
      if (/^https?:/i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    });
  }
  function parsePlotRerollInput(raw) {
    var text = String(raw == null ? "" : raw);
    var pattern = /<(recall|lookup|scene|beat|story|act|boundary|plot_track|story_state|input|user_input|thinking|thought|comic_plan|present|cb|soul|chaos|track|dm_story|dm_track)\s*>/i;
    var match = pattern.exec(text);
    var head = (match ? text.slice(0, match.index) : text).trim();
    if (head) return head;
    var tagged = /<(input|user_input)\s*>([\s\S]*?)<\/\1\s*>/i.exec(text);
    if (tagged && String(tagged[2] || "").trim()) return String(tagged[2]).trim();
    return text.trim();
  }
  function getPlotRerollJquery() {
    var api = getApi("$");
    if (api && api.value) return api.value;
    try { if (Env.pwin && Env.pwin.$) return Env.pwin.$; } catch (e) {}
    return null;
  }
  function rerollUserStory(root, button) {
    if (!button || button.getAttribute("data-state") === "busy") return;
    try {
      var jq = getPlotRerollJquery();
      if (!jq) throw new Error("未找到 jQuery");
      if (jq("#stop_but").is(":visible") || jq("#send_but").is(":hidden")) {
        throw new Error("AI 正在生成中，请稍后");
      }
      if (jq(".mes_edit_box:visible, .mes_edit_textarea:visible").length > 0) {
        throw new Error("请先退出消息编辑模式");
      }
      var context = stContext();
      var chat = context && context.chat;
      if (!chat || !chat.length) throw new Error("聊天记录为空");
      var mesNode = root.closest('.mes[is_user="true"][mesid]');
      var mesId = mesNode ? Number(mesNode.getAttribute("mesid")) : NaN;
      if (!Number.isInteger(mesId) || !chat[mesId] || chat[mesId].is_user !== true) {
        throw new Error("无法定位本轮用户输入");
      }
      var lastUser = -1;
      for (var i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) { lastUser = i; break; }
      }
      if (mesId !== lastUser) throw new Error("只能重roll最近一轮剧情");
      var typed = jq("#send_textarea").val();
      var raw = typeof chat[mesId].mes === "string" ? chat[mesId].mes : "";
      var newInput = typed && String(typed).trim() ? String(typed) : parsePlotRerollInput(raw);
      if (!newInput || !String(newInput).trim()) throw new Error("没有可发送的输入");
      var deleteCount = chat.length - mesId;
      if (deleteCount < 1) throw new Error("无法识别的消息结构，请手动处理");
      button.setAttribute("data-state", "busy");
      button.style.opacity = ".6";
      var host = Env.pwin;
      var runner = host.eval("(function(count,text){return (async function(){" +
        "var st=window.SillyTavern;var ctx=st.getContext();var $=window.$;" +
        "for(var i=0;i<count;i++){await ctx.deleteLastMessage();await new Promise(function(resolve){setTimeout(resolve,150);});}" +
        "var $ta=$(\"#send_textarea\");$ta.val(text).trigger(\"input\");" +
        "try{$ta.css(\"height\",\"auto\").css(\"height\",$ta[0].scrollHeight+\"px\");}catch(error){}" +
        "await new Promise(function(resolve){setTimeout(resolve,300);});" +
        "var $send=$(\"#send_but\");if($send&&$send.length)$send[0].click();" +
        "})();})");
      runner(deleteCount, newInput);
      
    } catch (error) {
      console.error("[漫画台剧情重roll]", error);
      toast(error.message || "操作失败", "error");
      button.removeAttribute("data-state");
      button.style.opacity = "";
      button.classList.add("shake");
      setTimeout(function () { button.classList.remove("shake"); }, 400);
    }
  }
  function mountUserStoryView(root, raw) {
    var sections = splitUserStorySections(raw), listeners = [];
    var prefix = "n5c-story-" + (++controlSequence), cards = [], buttons = [];
    root.classList.add("n5c-user-story");
    root.replaceChildren();
    var summary = el("summary", "n5c-story-summary"), title = el("span", "n5c-story-title", "用户输入 · 剧情推进");
    var count = el("span", "n5c-story-count", sections.length + " 个分区"), hint = el("span", "n5c-story-fold");
    var arrow = icon("chevron"); arrow.classList.add("n5c-story-chevron");
    var rerollBtn = el("button", "n5c-story-reroll");
    rerollBtn.type = "button";
    rerollBtn.title = "剧情重roll";
    rerollBtn.setAttribute("aria-label", "剧情重roll");
    rerollBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"></path><path d="M20 4v7h-7"></path></svg>重roll';
    var onRerollClick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      rerollUserStory(root, rerollBtn);
    };
    var onRerollDown = function (event) {
      event.preventDefault();
      event.stopPropagation();
    };
    rerollBtn.addEventListener("click", onRerollClick);
    rerollBtn.addEventListener("mousedown", onRerollDown);
    listeners.push(function () {
      rerollBtn.removeEventListener("click", onRerollClick);
      rerollBtn.removeEventListener("mousedown", onRerollDown);
    });
    summary.append(icon("logo"), title, count, rerollBtn, hint, arrow);
    var body = el("div", "n5c-story-body"), tabs = el("div", "n5c-story-tabs");
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "用户层内容标签");
    var panel = el("div", "n5c-story-content"); panel.id = prefix + "-panel";
    panel.setAttribute("role", "tabpanel"); panel.tabIndex = 0;
    sections.forEach(function (section, index) {
      var card = el("section", "n5c-story-card"), heading = el("h3", "n5c-story-card-title", section.title);
      heading.id = prefix + "-heading-" + index;
      card.setAttribute("aria-labelledby", heading.id);
      var content = el("div", "n5c-story-markdown");
      renderUserStoryContent(content, section.text);
      card.append(heading, content); panel.appendChild(card);
      cards.push({ key: section.key, node: card });
    });
    var choices = [{ key: "all", title: "全部" }], seen = new Set();
    sections.forEach(function (s) { if (!seen.has(s.key)) { seen.add(s.key); choices.push({ key: s.key, title: s.title }); } });
    function activate(index, focus) {
      buttons.forEach(function (b, i) { b.setAttribute("aria-selected", String(i === index)); b.tabIndex = i === index ? 0 : -1; });
      var key = choices[index].key;
      cards.forEach(function (card) { card.node.hidden = key !== "all" && card.key !== key; });
      panel.setAttribute("aria-labelledby", buttons[index].id); panel.scrollTop = 0;
      if (focus) buttons[index].focus();
    }
    choices.forEach(function (choice, index) {
      var tab = el("button", "n5c-story-tab", choice.title); tab.type = "button"; tab.id = prefix + "-tab-" + index;
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", panel.id);
      var click = function () { activate(index, false); };
      var keydown = function (event) {
        var next = index;
        if (event.key === "ArrowRight") next = (index + 1) % choices.length;
        else if (event.key === "ArrowLeft") next = (index + choices.length - 1) % choices.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = choices.length - 1;
        else return;
        event.preventDefault(); activate(next, true);
      };
      tab.addEventListener("click", click); tab.addEventListener("keydown", keydown);
      listeners.push(function () { tab.removeEventListener("click", click); tab.removeEventListener("keydown", keydown); });
      tabs.appendChild(tab); buttons.push(tab);
    });
    var toggle = function () { hint.textContent = root.open ? "收起" : "点击展开"; };
    root.addEventListener("toggle", toggle); listeners.push(function () { root.removeEventListener("toggle", toggle); });
    body.append(tabs, panel); root.append(summary, body); activate(0, false); toggle();
    return function () {
      listeners.forEach(function (off) { off(); });
      cards.forEach(function (card) { card.node.hidden = false; });
      tabs.remove(); panel.removeAttribute("role"); panel.removeAttribute("aria-labelledby");
    };
  }
  function bindUserStoryViews() {
    var chatNode = Env.pdoc.getElementById("chat");
    if (!chatNode || typeof Env.pwin.MutationObserver !== "function") return;
    var mounted = new Map(), queued = false, stopped = false;
    
    function scanPlaceholderViews() {
      var context = stContext();
      if (!context || !Array.isArray(context.chat)) return;
      var assistantNodes = chatNode.querySelectorAll('.mes[mesid]:not([is_user="true"])');
      assistantNodes.forEach(function (mesNode) {
        var mesText = mesNode.querySelector(".mes_text");
        if (!mesText) return;

        // 编辑模式守卫：若用户正在点小铅笔编辑此消息，严禁在此楼层挂载或显示占位框！
        var isEditing = Boolean(mesNode.querySelector("textarea") || mesText.querySelector("textarea") || mesNode.classList.contains("editing"));
        if (isEditing) {
          mesText.querySelectorAll(".n5c-placeholder").forEach(function (ph) { ph.remove(); });
          return;
        }
        var id = Number(mesNode.getAttribute("mesid"));
        if (!Number.isInteger(id) || !context.chat[id]) return;
        var rawText = typeof context.chat[id].mes === "string" ? context.chat[id].mes : "";
        var blocks = extractBlocks(rawText);
        if (!blocks.length) {
          mesText.querySelectorAll(".n5c-placeholder").forEach(function (ph) { ph.remove(); });
          return;
        }
        for (var i = 0; i < blocks.length; i++) {
          var pageNo = i + 1;
          var block = blocks[i];
          // 1. 原文层检测：若分镜块后已回填了图片容器且含真实图片，直接认定已成图
          var existingBox = boxAfter(rawText, block.raw);
          var hasImageInText = existingBox && (/<img\b/i.test(existingBox) || Boolean(parseBoxActiveSrc(existingBox)));

          // 2. DOM层增强选择器检测：覆盖 custom- 前缀变体及内嵌 img
          var realPageDom = mesNode.querySelector(
            '.n5c-page:not(.n5c-placeholder)[data-n5c-page="' + pageNo + '"], ' +
            '.custom-n5c-page:not(.n5c-placeholder)[data-n5c-page="' + pageNo + '"], ' +
            '.n5c-page-image[alt*="第' + pageNo + '页"], ' +
            '.custom-n5c-page-image[alt*="第' + pageNo + '页"], ' +
            '[data-n5c-page="' + pageNo + '"]:not(.n5c-placeholder) img'
          );

          var existingPh = mesText.querySelector('.n5c-placeholder[data-n5c-page="' + pageNo + '"]');

          if (hasImageInText || realPageDom) {
            // 已成图：立即彻底清除残留的占位框
            if (existingPh) existingPh.remove();
          } else {
            // 未成图：挂载专属纯黑占位框
            var isSpreadBlock = /(?:見開きページ|2ページ見開き|見開き)|(?:double-page spread|2-page spread|wide spread)/i.test(block.inner);
            var targetPh = existingPh;
            if (!targetPh) {
              targetPh = Env.pdoc.createElement("div");
              targetPh.className = "n5c-page n5c-placeholder" + (isSpreadBlock ? " n5c-landscape" : "");
              targetPh.setAttribute("data-n5c-page", String(pageNo));
              targetPh.innerHTML = '<div class="n5c-ph-inner">' +
                '<div class="n5c-ph-title">双击生图</div>' +
                '</div>';
            } else if (isSpreadBlock && !targetPh.classList.contains("n5c-landscape")) {
              targetPh.classList.add("n5c-landscape");
            }

            // 严格按 pageNo 升序插入 DOM，确保不连续出图时占位框绝不掉到底部
            var allPages = Array.from(mesText.children).filter(function (c) {
              return c && typeof c.getAttribute === "function" && c.hasAttribute("data-n5c-page") && c !== targetPh;
            });
            var nextSiblingPage = allPages.find(function (c) {
              return Number(c.getAttribute("data-n5c-page")) > pageNo;
            });
            if (nextSiblingPage) {
              if (targetPh.nextElementSibling !== nextSiblingPage) {
                mesText.insertBefore(targetPh, nextSiblingPage);
              }
            } else {
              if (targetPh.parentNode !== mesText || targetPh.nextElementSibling !== null) {
                mesText.appendChild(targetPh);
              }
            }
          }
        }
        mesText.querySelectorAll(".n5c-placeholder").forEach(function (ph) {
          var pNo = Number(ph.getAttribute("data-n5c-page"));
          if (pNo > blocks.length) ph.remove();
        });
      });
    }
    function scan() {
      queued = false;
      if (stopped || lifecycle.destroyed) return;
      mounted.forEach(function (entry, node) { if (!chatNode.contains(node)) { entry.dispose(); mounted.delete(node); } });
      var context = stContext();
      if (!context || !Array.isArray(context.chat)) return;
      chatNode.querySelectorAll('[data-n5c-user-story]').forEach(function (node) {
        var messageNode = node.closest('.mes[is_user="true"][mesid]');
        if (!messageNode || node.tagName !== "DETAILS" || !node.closest('.mes_text')) return;
        var id = Number(messageNode.getAttribute("mesid")), record = context.chat[id];
        if (!Number.isInteger(id) || !record || record.is_user !== true || typeof record.mes !== "string") return;
        var previous = mounted.get(node);
        if (previous && previous.raw === record.mes && node.querySelector('.n5c-story-body')) return;
        if (previous) previous.dispose();
        mounted.set(node, { raw: record.mes, dispose: mountUserStoryView(node, record.mes) });
      });

      // 扫描漫画未成图楼层，挂载独立纯黑占位框
      scanPlaceholderViews();
      redrawJobs.forEach(function (job) { syncRedrawOverlay(job.messageId, job.pageNo, true); });
    }
    function schedule() { if (!queued && !stopped) { queued = true; Promise.resolve().then(scan); } }
    var observer = new Env.pwin.MutationObserver(schedule);
    observer.observe(chatNode, { childList: true, subtree: true, attributes: true, attributeFilter: ["mesid", "is_user"] });
    lifecycle.unbinds.push(function () { stopped = true; observer.disconnect(); mounted.forEach(function (entry) { entry.dispose(); }); mounted.clear(); });
    var context = stContext(), source = context && context.eventSource, types = context && context.eventTypes;
    if (source && types && typeof source.on === "function" && typeof source.removeListener === "function") {
      ["USER_MESSAGE_RENDERED", "MESSAGE_UPDATED", "CHAT_CHANGED"].forEach(function (key) {
        if (!types[key]) return;
        source.on(types[key], schedule);
        lifecycle.unbinds.push(function () { source.removeListener(types[key], schedule); });
      });
    }
    scan();
  }
  /* USER_STORY_VIEW_END */

  function bindEvents() {
    var onFn = getBoundFunction("eventOn");

    var events = getApi("tavern_events");
    var MESSAGE_RECEIVED = (events && events.value && events.value.MESSAGE_RECEIVED) || "message_received";

    var handler = function (messageId) {
      if (!state.autoGenerate || lifecycle.destroyed) return;
      var timer = setTimeout(function () {
        if (!state.autoGenerate || lifecycle.destroyed) return;
        autoRenderMessage(messageId).catch(function (err) { setStatus("自动出图检查失败：" + err.message, "error"); });
      }, 1200);
      lifecycle.unbinds.push(function () { clearTimeout(timer); });
    };

    if (onFn) {
      try {
        var handle = onFn.fn(MESSAGE_RECEIVED, handler);
        if (handle && typeof handle.stop === "function") lifecycle.unbinds.push(handle.stop);
        var chatChanged = events && events.value && events.value.CHAT_CHANGED;
        if (chatChanged) {
          var chatHandle = onFn.fn(chatChanged, resetChatStatus);
          if (chatHandle && typeof chatHandle.stop === "function") lifecycle.unbinds.push(chatHandle.stop);
        }
      } catch (e) {
        warn("事件绑定失败", e);
      }
    }

    // 绑定漫画图片交互：双击重画当前页、长按500ms打开历史版本弹窗
    function findPageImage(target) {
      if (!target || !target.closest) return null;
      return target.closest(".n5c-page-image, .custom-n5c-page-image") ||
        (target.tagName === "IMG" && target.closest("[data-n5c-page]")) || null;
    }

    function findPageElement(img) {
      if (!img || !img.closest) return null;
      return img.closest(".n5c-page, .custom-n5c-page, [data-n5c-page]");
    }

    var longPressTimer = null;
    var startPos = null;
    var suppressClick = false;
    var suppressDblClickUntil = 0;

    var clearLongPress = function () {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      startPos = null;
    };

    var onDblClick = function (e) {
      if (Date.now() < suppressDblClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
      var ph = e.target && e.target.closest ? e.target.closest(".n5c-placeholder") : null;
      if (ph) {
        e.preventDefault();
        e.stopPropagation();
        var pageNo = Number(ph.getAttribute("data-n5c-page"));
        var mesEl = ph.closest(".mes[mesid]") || ph.closest("[mesid]");
        var messageId = mesEl ? mesEl.getAttribute("mesid") : null;
        if (!pageNo || !messageId) {
          toast("无法识别当前漫画页码或楼层", "warning");
          return;
        }
        redrawSinglePage(messageId, pageNo).catch(function (err) {
          if (err && err.name !== "AbortError") {
            setStatus("第 " + pageNo + " 页生图失败：" + err.message, "error");
          }
        });
        return;
      }
      var img = findPageImage(e.target);
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      var pageEl = findPageElement(img);
      var pageNo = pageEl ? Number(pageEl.getAttribute("data-n5c-page")) : null;
      var mesEl = img.closest(".mes[mesid]") || img.closest("[mesid]");
      var messageId = mesEl ? mesEl.getAttribute("mesid") : null;
      if (!pageNo) {
        toast("无法识别当前漫画页码", "warning");
        return;
      }
      redrawSinglePage(messageId, pageNo).catch(function (err) {
        if (err && err.name !== "AbortError") {
          setStatus("第 " + pageNo + " 页重画失败：" + err.message, "error");
        }
      });
    };

    var onPointerDown = function (e) {
      if (e.button !== 0) return;
      var img = findPageImage(e.target);
      var target = img || (e.target && e.target.closest ? e.target.closest(".n5c-placeholder") : null);
      if (!target) return;
      clearLongPress();
      startPos = { x: e.clientX, y: e.clientY };
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        suppressClick = true;
        suppressDblClickUntil = Date.now() + 600;
        openPageHistoryDialog(target);
      }, 500);
    };

    var onPointerMove = function (e) {
      if (!longPressTimer || !startPos) return;
      var dx = Math.abs(e.clientX - startPos.x);
      var dy = Math.abs(e.clientY - startPos.y);
      if (dx > 10 || dy > 10) {
        clearLongPress();
      }
    };

    var onPointerUp = function () {
      clearLongPress();
      if (suppressClick) {
        setTimeout(function () { suppressClick = false; }, 300);
      }
    };

    var onContextMenu = function (e) {
      var img = findPageImage(e.target);
      if (img) {
        e.preventDefault();
      }
    };

    var onClick = function (e) {
      var target = findPageImage(e.target) || (e.target && e.target.closest ? e.target.closest(".n5c-placeholder") : null);
      if (target && suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    };

    var onDragStart = function (e) {
      var img = findPageImage(e.target);
      if (img) {
        e.preventDefault();
      }
    };

    var doc = Env.pdoc;
    doc.addEventListener("dblclick", onDblClick);
    doc.addEventListener("pointerdown", onPointerDown);
    doc.addEventListener("pointermove", onPointerMove);
    doc.addEventListener("pointerup", onPointerUp);
    doc.addEventListener("pointercancel", onPointerUp);
    doc.addEventListener("contextmenu", onContextMenu);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("dragstart", onDragStart);

    lifecycle.unbinds.push(function () {
      doc.removeEventListener("dblclick", onDblClick);
      doc.removeEventListener("pointerdown", onPointerDown);
      doc.removeEventListener("pointermove", onPointerMove);
      doc.removeEventListener("pointerup", onPointerUp);
      doc.removeEventListener("pointercancel", onPointerUp);
      doc.removeEventListener("contextmenu", onContextMenu);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("dragstart", onDragStart);
      clearLongPress();
    });
  }

  function destroy() {
    lifecycle.destroyed = true;
    stopRender();
    running.cancel = true;
    if (running.task) running.task.controller.abort();
    if (refs.askClose) refs.askClose();
    lifecycle.unbinds.forEach(function (fn) { try { fn(); } catch (e) {} });
    lifecycle.unbinds = [];
    try { if (refs.orb) refs.orb.remove(); } catch (e) {}
    try { if (refs.panel) refs.panel.remove(); } catch (e) {}
    var style = Env.pdoc.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  async function boot() {
    /* 脚本重载时先清掉上一份 UI，避免悬浮球叠罗汉 */
    try {
      var old = Env.pwin[APP_ID];
      if (old && typeof old.destroy === "function") old.destroy();
    } catch (e) {}

    Store.load();
    var connectionLoadError = null;
    try { await ConnectionStore.load(); } catch (e) { connectionLoadError = e; }
    buildUi();
    Store.save();
    if (connectionLoadError) setStatus(connectionLoadError.message, "error");
    bindEvents();
    bindUserStoryViews();
    Shujuku.bind();

    Env.pwin[APP_ID] = {
      destroy: destroy,
      state: state,
      renderMessage: renderMessage,
      parseImageBlock: parseImageBlock,
      stop: stopRender,
      open: function () { togglePanel(true); },
      shujuku: Shujuku,
    };

    var onUnload = function () { destroy(); };
    window.addEventListener("unload", onUnload);
    lifecycle.unbinds.push(function () { window.removeEventListener("unload", onUnload); });

    log("已启动，预设接口" + (PresetAdapter.hasApi() ? "可用" : "不可用") +
      "，数据库" + (Shujuku.available() ? "已连接" : "未检测到"));
  }

  try { await boot(); return Env.pwin[APP_ID]; }
  catch (error) { destroy(); throw error; }
}
