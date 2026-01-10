const { app, BrowserWindow, BrowserView, ipcMain, dialog, net, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

// WebRTC IP leak mitigation (system-level hint)
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("webrtc-hide-local-ips-with-mdns");

// Randomize TLS profile on startup (best-effort for fingerprint variance).
function applyRandomTlsProfile() {
  const profiles = [
    { name: "tls13-default" },
    { name: "tls12-compat", min: "tls1.2", max: "tls1.2" },
    { name: "tls13-strict", min: "tls1.2", max: "tls1.3", blacklist: "0x0005,0x000a" }
  ];
  const picked = profiles[Math.floor(Math.random() * profiles.length)];

  if (picked.min) app.commandLine.appendSwitch("ssl-version-min", picked.min);
  if (picked.max) app.commandLine.appendSwitch("ssl-version-max", picked.max);
  if (picked.blacklist) app.commandLine.appendSwitch("cipher-suite-blacklist", picked.blacklist);

  console.log("[TLS] profile:", picked.name);
}

applyRandomTlsProfile();

function formatError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function handleIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      console.warn(`[IPC] ${channel} failed:`, error?.stack || error);
      return { ok: false, error: formatError(error) };
    }
  });
}

/* =========================
   CONFIG (auto saved)
   ========================= */
function configPaths() {
  return {
    appPath: path.join(app.getAppPath(), "config.json"),
    userPath: path.join(app.getPath("userData"), "config.json")
  };
}

function defaultConfig() {
  return {
    proxy: {
      enabled: false,
      scheme: "socks5",
      host: "127.0.0.1",
      port: 1080,
      username: "",
      password: "",
      bypass: "<-loopback>"
    },
    userAgent: {
      mode: "preset",
      preset: "chrome-win",
      custom: "",
      suffix: ""
    },
    settings: {
      homeUrl: "https://duckduckgo.com",
      searchEngine: "duckduckgo",
      theme: "light"
    },
    extensions: [],
    bookmarks: [],
    history: [],
    historyLimit: 500
  };
}

function readConfig() {
  const base = defaultConfig();
  const { appPath, userPath } = configPaths();
  const paths = [appPath, userPath];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf-8");
      const cfg = JSON.parse(raw);
      return {
        ...base,
        ...cfg,
        proxy: { ...base.proxy, ...(cfg.proxy || {}) },
        userAgent: { ...base.userAgent, ...(cfg.userAgent || {}) },
        settings: { ...base.settings, ...(cfg.settings || {}) },
        extensions: Array.isArray(cfg.extensions) ? cfg.extensions : base.extensions,
        bookmarks: Array.isArray(cfg.bookmarks) ? cfg.bookmarks : base.bookmarks,
        history: Array.isArray(cfg.history) ? cfg.history : base.history
      };
    } catch (e) {
      console.warn("[CFG] readConfig failed for", p, ":", e);
    }
  }
  return base;
}

function writeConfig(cfg) {
  const { appPath, userPath } = configPaths();
  const serialized = JSON.stringify(cfg, null, 2);
  let saved = false;

  try {
    fs.writeFileSync(appPath, serialized, "utf-8");
    saved = true;
  } catch (e) {
    console.warn("[CFG] writeConfig failed for appPath:", e?.message || e);
  }

  if (!saved) {
    try {
      fs.mkdirSync(path.dirname(userPath), { recursive: true });
      fs.writeFileSync(userPath, serialized, "utf-8");
      saved = true;
    } catch (e) {
      console.warn("[CFG] writeConfig failed for userPath:", e?.message || e);
    }
  }

  return saved;
}

let CFG = defaultConfig();
const REGISTERED_PARTITIONS = new Set();
const PROXY_AUTH_BY_PARTITION = new Map();
const TAB_VIEWS = new Map();
const USER_AGENT_PRESETS = {
  "chrome-win": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "chrome-mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "chrome-linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "firefox-win": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "firefox-mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13.6; rv:128.0) Gecko/20100101 Firefox/128.0",
  "safari-mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "edge-win": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
};
const PROTECTION_SCRIPTS = [
  "webrtc_blocker.js",
  "canvas_blocker.js",
  "webgl_blocker.js",
  "audio_blocker.js",
  "battery_blocker.js",
  "client_hints_blocker.js"
];
let PROTECTION_CODE = null;
let MAIN_WINDOW = null;
let ACTIVE_TAB_ID = null;
let VIEW_TOP_OFFSET = 142;
let VIEW_RIGHT_INSET = 0;
let VIEW_LEFT_INSET = 0;

/* =========================
   IP Fetch (api.myip.com)
   ========================= */
async function fetchJsonWithSession(ses, url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, session: ses });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error("request timeout"));
    }, timeoutMs);

    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`request failed: ${res.statusCode}`));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error("invalid json response"));
        }
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

async function getMyIp(ses) {
  const url = "https://api.myip.com";
  try {
    if (!ses) throw new Error("missing session");
    return await fetchJsonWithSession(ses, url);
  } catch (e) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("api.myip.com failed: " + res.status);
      return await res.json(); // { ip, country, cc }
    } catch (fallbackError) {
      throw new Error(`api.myip.com request failed: ${formatError(fallbackError)}`);
    }
  }
}

/* =========================
   Proxy
   ========================= */
function normalizeProxyScheme(scheme) {
  const allowed = new Set(["socks4", "socks5", "socks5h", "http", "https"]);
  const value = String(scheme || "").toLowerCase().trim();
  return allowed.has(value) ? value : "socks5";
}

function normalizeProxyPort(port, fallback) {
  const numeric = Number(port);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded < 1 || rounded > 65535) return fallback;
  return rounded;
}

function normalizeProxyConfig(input = {}, previous = {}) {
  const base = defaultConfig().proxy;
  const enabled = !!input.enabled;
  const scheme = normalizeProxyScheme(input.scheme ?? previous.scheme ?? base.scheme);
  const host = String(input.host ?? previous.host ?? base.host).trim() || base.host;
  const port = normalizeProxyPort(input.port ?? previous.port ?? base.port, base.port);
  const username = String(input.username ?? previous.username ?? base.username);
  let password = "";

  if (input.password === "*****") {
    password = String(previous.password ?? base.password ?? "");
  } else if (typeof input.password === "string") {
    password = input.password;
  } else if (input.password == null) {
    password = String(previous.password ?? base.password ?? "");
  } else {
    password = String(input.password);
  }

  const bypass = String(input.bypass ?? previous.bypass ?? base.bypass ?? "").trim();

  return {
    enabled,
    scheme,
    host,
    port,
    username,
    password,
    bypass
  };
}

function getNormalizedProxyConfig() {
  const current = CFG.proxy || defaultConfig().proxy;
  const normalized = normalizeProxyConfig(current, current);
  CFG.proxy = normalized;
  return normalized;
}
function buildProxyRules(proxyConfig) {
  if (!proxyConfig.enabled) {
    return { mode: "direct" };
  }
  const rule = `${proxyConfig.scheme}://${proxyConfig.host}:${proxyConfig.port}`;
  const proxyRules = { proxyRules: rule };
  if (proxyConfig.bypass) proxyRules.proxyBypassRules = proxyConfig.bypass;
  return proxyRules;
}

async function applyProxyConfigToSession(ses, proxyConfig, logPrefix = "[PROXY]") {
  try {
    if (!ses) throw new Error("missing session");
    const proxyRules = buildProxyRules(proxyConfig);
    await ses.setProxy(proxyRules);
    const partitionKey = typeof ses.getPartition === "function" ? ses.getPartition() : "default";
    if (proxyConfig.enabled && (proxyConfig.username || proxyConfig.password)) {
      PROXY_AUTH_BY_PARTITION.set(partitionKey, {
        username: proxyConfig.username || "",
        password: proxyConfig.password || ""
      });
    } else {
      PROXY_AUTH_BY_PARTITION.delete(partitionKey);
    }
    if (proxyConfig.enabled) {
      console.log(logPrefix, "enabled:", proxyRules.proxyRules, proxyConfig.bypass ? `bypass=${proxyConfig.bypass}` : "");
    } else {
      console.log(logPrefix, "disabled (direct)");
    }
    return true;
  } catch (e) {
    console.warn(logPrefix, "setProxy failed:", e?.message || e);
    return false;
  }
}


/* =========================
   User Agent
   ========================= */
function normalizeUserAgentMode(mode) {
  const value = String(mode || "").toLowerCase().trim();
  return value === "custom" ? "custom" : "preset";
}

function normalizeUserAgentConfig(input = {}, previous = {}) {
  const base = defaultConfig().userAgent;
  const mode = normalizeUserAgentMode(input.mode ?? previous.mode ?? base.mode);
  const preset = String(input.preset ?? previous.preset ?? base.preset).trim() || base.preset;
  const custom = String(input.custom ?? previous.custom ?? base.custom);
  const suffix = String(input.suffix ?? previous.suffix ?? base.suffix).trim();

  return { mode, preset, custom, suffix };
}

function buildUserAgentString(cfg) {
  const mode = cfg?.mode === "custom" ? "custom" : "preset";
  const preset = USER_AGENT_PRESETS[cfg?.preset] || USER_AGENT_PRESETS["chrome-win"];
  const base = mode === "custom" && cfg?.custom ? String(cfg.custom) : preset;
  const suffix = String(cfg?.suffix || "").trim();
  return suffix ? `${base} ${suffix}` : base;
}

function getNormalizedUserAgentConfig() {
  const current = CFG.userAgent || defaultConfig().userAgent;
  const normalized = normalizeUserAgentConfig(current, current);
  CFG.userAgent = normalized;
  return normalized;
}

function normalizeSettingsConfig(input = {}, previous = {}) {
  const base = defaultConfig().settings;
  const homeUrl = String(input.homeUrl ?? previous.homeUrl ?? base.homeUrl).trim() || base.homeUrl;
  const searchEngine = String(input.searchEngine ?? previous.searchEngine ?? base.searchEngine).trim() || base.searchEngine;
  const themeValue = String(input.theme ?? previous.theme ?? base.theme).toLowerCase().trim();
  const theme = themeValue === "dark" ? "dark" : "light";

  return { homeUrl, searchEngine, theme };
}

function getNormalizedSettingsConfig() {
  const current = CFG.settings || defaultConfig().settings;
  const normalized = normalizeSettingsConfig(current, current);
  CFG.settings = normalized;
  return normalized;
}

function loadProtectionScriptsOnce() {
  if (PROTECTION_CODE) return PROTECTION_CODE;
  const loaded = [];
  for (const script of PROTECTION_SCRIPTS) {
    const scriptPath = path.join(__dirname, script);
    try {
      const code = fs.readFileSync(scriptPath, "utf-8");
      loaded.push({ script, code });
    } catch (error) {
      console.warn(`[PROTECT] Unable to load ${script}`, error?.message || error);
    }
  }
  PROTECTION_CODE = loaded;
  return PROTECTION_CODE;
}

function buildIPInjector(ip) {
  return `
    (function(){
      try{
        window.__PUBLIC_IP__ = ${JSON.stringify(String(ip || ""))};
        window.__PUBLIC_IP_TS__ = Date.now();
        console.log("[INJECT] IP injected:", window.__PUBLIC_IP__);
      }catch(e){}
    })();
  `;
}

async function injectProtectionIntoView(entry) {
  if (!entry?.view?.webContents) return;
  try {
    const scripts = loadProtectionScriptsOnce();
    for (const item of scripts) {
      if (!item.code) continue;
      await entry.view.webContents.executeJavaScript(item.code, true);
    }
    if (entry.ip) {
      await entry.view.webContents.executeJavaScript(buildIPInjector(entry.ip), true);
    }
  } catch (error) {
    console.warn("[PROTECT] inject failed:", error?.message || error);
  }
}

async function applyProxyToSession(ses) {
  const p = getNormalizedProxyConfig();
  return await applyProxyConfigToSession(ses, p);
}

function applyUserAgentToView(view) {
  if (!view?.webContents) return;
  const ua = buildUserAgentString(getNormalizedUserAgentConfig());
  view.webContents.setUserAgent(ua);
}

function applyUserAgentToAllViews() {
  for (const entry of TAB_VIEWS.values()) {
    applyUserAgentToView(entry.view);
  }
}

function sendTabUpdate(tabId, payload) {
  if (!MAIN_WINDOW || MAIN_WINDOW.isDestroyed()) return;
  MAIN_WINDOW.webContents.send("tab:update", { tabId, ...payload });
}

function resizeActiveView() {
  if (!MAIN_WINDOW || MAIN_WINDOW.isDestroyed() || !ACTIVE_TAB_ID) return;
  const entry = TAB_VIEWS.get(ACTIVE_TAB_ID);
  if (!entry?.view) return;
  const bounds = MAIN_WINDOW.getContentBounds();
  const height = Math.max(0, bounds.height - VIEW_TOP_OFFSET);
  const width = Math.max(0, bounds.width - VIEW_RIGHT_INSET - VIEW_LEFT_INSET);
  const x = Math.max(0, VIEW_LEFT_INSET);
  entry.view.setBounds({ x, y: VIEW_TOP_OFFSET, width, height });
}

function setActiveTab(tabId) {
  if (!MAIN_WINDOW || MAIN_WINDOW.isDestroyed()) return;
  const entry = TAB_VIEWS.get(tabId);
  if (!entry) return;
  if (ACTIVE_TAB_ID && ACTIVE_TAB_ID !== tabId) {
    const previous = TAB_VIEWS.get(ACTIVE_TAB_ID);
    if (previous?.view) {
      try { MAIN_WINDOW.removeBrowserView(previous.view); } catch {}
    }
  }
  MAIN_WINDOW.addBrowserView(entry.view);
  ACTIVE_TAB_ID = tabId;
  resizeActiveView();
}

function createTabView(tabId, { incognito, url }) {
  const partition = incognito ? `temp:incog_${tabId}` : `persist:tab_${tabId}`;
  const ses = registerPartition(partition);
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      webviewTag: false
    }
  });

  const entry = { id: tabId, incognito: !!incognito, partition, view, ip: "" };
  TAB_VIEWS.set(tabId, entry);

  view.webContents.on("page-title-updated", (_event, title) => {
    sendTabUpdate(tabId, { title });
  });
  view.webContents.on("did-navigate", (_event, navigationUrl) => {
    sendTabUpdate(tabId, { url: navigationUrl });
  });
  view.webContents.on("did-navigate-in-page", (_event, navigationUrl) => {
    sendTabUpdate(tabId, { url: navigationUrl });
  });
  view.webContents.on("dom-ready", () => injectProtectionIntoView(entry));
  view.webContents.on("did-finish-load", () => injectProtectionIntoView(entry));

  applyProxyToSession(ses);
  applyUserAgentToView(view);

  return entry;
}
function registerPartition(partition) {
  const normalized = String(partition || "").trim();
  if (!normalized) return null;
  if (!REGISTERED_PARTITIONS.has(normalized)) {
    REGISTERED_PARTITIONS.add(normalized);
  }
  return session.fromPartition(normalized);
}

async function applyProxyToAllSessions() {
  const tasks = [];
  if (session.defaultSession) tasks.push(applyProxyToSession(session.defaultSession));
  for (const partition of REGISTERED_PARTITIONS) {
    const ses = session.fromPartition(partition);
    tasks.push(applyProxyToSession(ses));
  }
  const results = await Promise.allSettled(tasks);
  const failures = results.reduce((total, result) => {
    if (result.status === "rejected") return total + 1;
    return result.value ? total : total + 1;
  }, 0);
  return { ok: failures === 0, failures };
}

async function testProxyConnectivity(proxyConfig) {
  const normalized = normalizeProxyConfig(proxyConfig, CFG.proxy);
  const partition = `temp:proxy_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const ses = session.fromPartition(partition);
  const started = Date.now();

  try {
    await applyProxyConfigToSession(ses, normalized, "[PROXY][TEST]");
    const data = await fetchJsonWithSession(ses, "https://api.myip.com");
    return {
      ok: true,
      ip: data.ip,
      country: data.country,
      cc: data.cc,
      elapsedMs: Date.now() - started,
      proxy: { ...normalized, password: normalized.password ? "*****" : "" }
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e),
      elapsedMs: Date.now() - started,
      proxy: { ...normalized, password: normalized.password ? "*****" : "" }
    };
  } finally {
    PROXY_AUTH_BY_PARTITION.delete(partition);
  }
}


/* =========================
   Extensions load/unload
   ========================= */
function normalizeExtPath(p) {
  return path.resolve(String(p || ""));
}

async function loadEnabledExtensions(ses) {
  const list = Array.isArray(CFG.extensions) ? CFG.extensions : [];
  for (const item of list) {
    try {
      if (!item?.path || !item.enabled) continue;
      const extPath = normalizeExtPath(item.path);
      const ext = await ses.loadExtension(extPath, { allowFileAccess: true });
      console.log("[EXT] Loaded:", ext.name, "id:", ext.id, "path:", extPath);
    } catch (e) {
      console.warn("[EXT] load failed:", item?.path, e?.message || e);
    }
  }
}

function listLoadedExtensions(ses) {
  const map = ses.getAllExtensions();
  return Object.values(map).map(ext => ({
    id: ext.id,
    name: ext.name,
    version: ext.version,
    path: ext.path
  }));
}

async function unloadExtensionById(ses, id) {
  try {
    ses.removeExtension(String(id));
    return true;
  } catch (e) {
    console.warn("[EXT] unload failed:", id, e);
    return false;
  }
}

/* =========================
   External Geo Service (child)
   ========================= */
let GEO_CHILD = null;

function startGeoService() {
  const childPath = path.join(__dirname, "geo_service.js");
  const maxmindPath = path.join(__dirname, "node_modules", "maxmind");
  if (!fs.existsSync(maxmindPath)) {
    console.warn("[GEO] maxmind module not installed. Run `npm install` before starting the app.");
    return;
  }
  try {
    GEO_CHILD = fork(childPath, [], {
      stdio: "inherit",
      env: {
        ...process.env,
        GEO_PORT: "8787",
        NOMINATIM_EMAIL: "youremail@example.com",
        NOMINATIM_UA: "MyBrowser/1.0 (contact: youremail@example.com)",
        MMDB_PATH: path.join(__dirname, "GeoLite2-City.mmdb")
      }
    });
    console.log("[GEO] service started (child process)");
  } catch (e) {
    console.warn("[GEO] failed to start service:", e);
  }
}

/* =========================
   Window
   ========================= */
async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: false
    }
  });
  MAIN_WINDOW = win;

  const ses = win.webContents.session;

  // ===== STRONG Anti-FP / Privacy hardening =====

  // 1) clear everything on startup
  try {
    await ses.clearCache();
    await ses.clearStorageData({
      storages: [
        "cookies",
        "localstorage",
        "sessionstorage",
        "indexdb",
        "cachestorage",
        "serviceworkers",
        "websql"
      ],
      quotas: ["temporary", "persistent", "syncable"]
    });
    console.log("[PRIVACY] cleared cache + storage on startup");
  } catch (error) {
    console.warn("[PRIVACY] failed to clear cache/storage:", error?.message || error);
  }

  // 2) block sensitive permissions
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const blocked = new Set([
      "media",
      "geolocation",
      "notifications",
      "midi",
      "pointerLock",
      "clipboard-read",
      "display-capture",
      "hid",
      "serial",
      "usb",
      "bluetooth"
    ]);
    if (blocked.has(permission)) return callback(false);
    callback(true);
  });

  // 3) helper privacy headers
  ses.webRequest.onHeadersReceived((details, cb) => {
    const headers = details.responseHeaders || {};
    headers["Permissions-Policy"] = [
      "geolocation=(), microphone=(), camera=(), usb=(), payment=(), interest-cohort=()"
    ];
    cb({ responseHeaders: headers });
  });

  // Proxy auth if needed
  app.on("login", (event, webContents, request, authInfo, callback) => {
    const p = getNormalizedProxyConfig();
    if (authInfo && authInfo.isProxy) {
      const ses = webContents?.session;
      const partitionKey = ses && typeof ses.getPartition === "function" ? ses.getPartition() : "default";
      const auth = PROXY_AUTH_BY_PARTITION.get(partitionKey);
      if (auth) {
        event.preventDefault();
        callback(auth.username || "", auth.password || "");
        return;
      }
    }
    if (authInfo && authInfo.isProxy && p.enabled) {
      event.preventDefault();
      callback(p.username || "", p.password || "");
      return;
    }
  });

  await applyProxyToSession(ses);
  await loadEnabledExtensions(ses);

  win.loadFile("index.html").catch((error) => {
    console.warn("[WINDOW] Failed to load index.html:", error?.message || error);
  });

  win.on("resize", () => {
    resizeActiveView();
  });
  win.on("closed", () => {
    MAIN_WINDOW = null;
  });
}

/* =========================
   App lifecycle
   ========================= */
app.whenReady().then(() => {
  CFG = readConfig();
  CFG.proxy = getNormalizedProxyConfig();
  CFG.userAgent = getNormalizedUserAgentConfig();
  CFG.settings = getNormalizedSettingsConfig();
  writeConfig(CFG);
  startGeoService();
  createWindow();
});

app.on("before-quit", () => {
  try { if (GEO_CHILD) GEO_CHILD.kill(); } catch {}
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* =========================
   IPC: IP for tab
   ========================= */
handleIpc("get-ip-for-tab", async (event, tabId) => {
  const resolvedId = Number(tabId);
  if (!Number.isFinite(resolvedId)) return { ok: false, error: "Invalid tab id" };
  const entry = TAB_VIEWS.get(resolvedId);
  const ses = entry?.view?.webContents?.session || event.sender.session;
  if (!ses) return { ok: false, error: "Missing session" };
  const data = await getMyIp(ses);
  console.log("[BACKEND] New tab:", resolvedId, "IP:", data.ip, "Country:", data.country, data.cc);
  return { ok: true, tabId: resolvedId, ...data };
});

/* =========================
   IPC: external geo enrich
   ========================= */
handleIpc("geo:enrich-ip", async (event, ip) => {
  const targetIp = String(ip || "").trim();
  if (!targetIp) {
    return { ok: false, error: "Missing ip" };
  }
  const serviceUrl = `http://127.0.0.1:8787/enrich?ip=${encodeURIComponent(targetIp)}`;
  const r = await fetch(serviceUrl);
  if (!r.ok) return { ok: false, error: "geo_service failed: " + r.status };
  return await r.json();
});

/* =========================
   IPC: config get
   ========================= */
handleIpc("cfg:get", async () => {
  CFG = readConfig();
  CFG.proxy = getNormalizedProxyConfig();
  CFG.userAgent = getNormalizedUserAgentConfig();
  CFG.settings = getNormalizedSettingsConfig();
  return {
    proxy: { ...CFG.proxy, password: CFG.proxy?.password ? "*****" : "" },
    userAgent: CFG.userAgent,
    settings: CFG.settings,
    extensions: CFG.extensions || [],
    bookmarks: CFG.bookmarks || [],
    history: CFG.history || [],
    historyLimit: CFG.historyLimit || 500
  };
});

/* =========================
   IPC: settings set
   ========================= */
handleIpc("cfg:set", async (event, payload) => {
  CFG = readConfig();
  CFG.settings = normalizeSettingsConfig(payload, CFG.settings);
  const saved = writeConfig(CFG);
  if (!saved) return { ok: false, error: "Failed to save config." };
  return { ok: true, settings: CFG.settings };
});

/* =========================
   IPC: session partition register
   ========================= */
handleIpc("partition:register", async (event, partition) => {
  const ses = registerPartition(partition);
  if (!ses) return { ok: false, error: "Invalid partition" };
  const applied = await applyProxyToSession(ses);
  return applied ? { ok: true } : { ok: false, error: "Failed to apply proxy to partition." };
});

/* =========================
   IPC: proxy test
   ========================= */
handleIpc("proxy:test", async (event, payload) => {
  const proxyConfig = payload?.proxy || payload || {};
  return await testProxyConnectivity(proxyConfig);
});

/* =========================
   IPC: proxy set (save + apply)
   ========================= */
handleIpc("proxy:set", async (event, proxyConfig) => {
  CFG = readConfig();
  CFG.proxy = normalizeProxyConfig(proxyConfig, CFG.proxy);

  const saved = writeConfig(CFG);
  const appliedToSender = await applyProxyToSession(event.sender.session);
  const applyAll = await applyProxyToAllSessions();

  if (!saved) return { ok: false, error: "Failed to save proxy config." };
  if (!appliedToSender || !applyAll.ok) {
    return {
      ok: false,
      error: "Proxy saved but failed to apply to some sessions.",
      proxy: { ...CFG.proxy, password: CFG.proxy.password ? "*****" : "" }
    };
  }
  return { ok: true, proxy: { ...CFG.proxy, password: CFG.proxy.password ? "*****" : "" } };
});

/* =========================
   IPC: user agent set
   ========================= */
handleIpc("ua:set", async (event, payload) => {
  CFG = readConfig();
  CFG.userAgent = normalizeUserAgentConfig(payload, CFG.userAgent);
  const saved = writeConfig(CFG);
  if (!saved) return { ok: false, error: "Failed to save user agent config." };
  applyUserAgentToAllViews();
  return { ok: true, userAgent: CFG.userAgent };
});

/* =========================
   IPC: Extensions manager
   ========================= */
handleIpc("ext:pickFolder", async () => {
  const r = await dialog.showOpenDialog({
    title: "Select unpacked Chrome extension folder (contains manifest.json)",
    properties: ["openDirectory"]
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

handleIpc("ext:list", async (event) => {
  const ses = event.sender.session;
  CFG = readConfig();
  const loaded = listLoadedExtensions(ses);
  const configured = Array.isArray(CFG.extensions) ? CFG.extensions : [];

  const merged = configured.map(item => {
    const p = normalizeExtPath(item.path);
    const found = loaded.find(x => normalizeExtPath(x.path) === p);
    return {
      path: p,
      enabled: !!item.enabled,
      id: found?.id || null,
      name: found?.name || "(not loaded)"
    };
  });

  return { ok: true, configured: merged, loaded };
});

handleIpc("ext:add", async (event, extPath) => {
  const ses = event.sender.session;
  CFG = readConfig();

  const p = normalizeExtPath(extPath);
  if (!CFG.extensions.some(x => normalizeExtPath(x.path) === p)) {
    CFG.extensions.push({ path: p, enabled: true });
    const saved = writeConfig(CFG);
    if (!saved) return { ok: false, error: "Failed to save extension config.", path: p };
  }

  try {
    const ext = await ses.loadExtension(p, { allowFileAccess: true });
    return { ok: true, id: ext.id, name: ext.name, path: p };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), path: p };
  }
});

handleIpc("ext:toggle", async (event, payload) => {
  const ses = event.sender.session;
  const p = normalizeExtPath(payload?.path);
  const enable = !!payload?.enabled;

  CFG = readConfig();
  const idx = CFG.extensions.findIndex(x => normalizeExtPath(x.path) === p);
  if (idx === -1) return { ok: false, error: "Extension not found in config." };

  CFG.extensions[idx].enabled = enable;
  const saved = writeConfig(CFG);
  if (!saved) return { ok: false, error: "Failed to save extension config." };

  const loaded = listLoadedExtensions(ses);
  const found = loaded.find(x => normalizeExtPath(x.path) === p);

  if (!enable) {
    if (found?.id) await unloadExtensionById(ses, found.id);
    return { ok: true, enabled: false };
  }

  try {
    const ext = await ses.loadExtension(p, { allowFileAccess: true });
    return { ok: true, enabled: true, id: ext.id, name: ext.name };
  } catch (e) {
    return { ok: false, enabled: false, error: String(e?.message || e) };
  }
});

handleIpc("ext:remove", async (event, payload) => {
  const ses = event.sender.session;
  const p = normalizeExtPath(payload?.path);

  CFG = readConfig();
  CFG.extensions = (CFG.extensions || []).filter(x => normalizeExtPath(x.path) !== p);
  const saved = writeConfig(CFG);
  if (!saved) return { ok: false, error: "Failed to save extension config." };

  const loaded = listLoadedExtensions(ses);
  const found = loaded.find(x => normalizeExtPath(x.path) === p);
  if (found?.id) await unloadExtensionById(ses, found.id);

  return { ok: true };
});

/* =========================
   IPC: Bookmarks
   ========================= */
handleIpc("bm:list", async () => {
  CFG = readConfig();
  return { ok: true, bookmarks: CFG.bookmarks || [] };
});

handleIpc("bm:add", async (event, payload) => {
  const title = String(payload?.title || "").trim() || "Bookmark";
  const url = String(payload?.url || "").trim();
  if (!url) return { ok: false, error: "Missing url" };

  CFG = readConfig();
  const exists = (CFG.bookmarks || []).some(b => String(b.url) === url);
  if (!exists) {
    CFG.bookmarks.push({ title, url, createdAt: Date.now() });
    const saved = writeConfig(CFG);
    if (!saved) return { ok: false, error: "Failed to save bookmark." };
  }
  return { ok: true };
});

handleIpc("bm:remove", async (event, payload) => {
  const url = String(payload?.url || "").trim();
  CFG = readConfig();
  CFG.bookmarks = (CFG.bookmarks || []).filter(b => String(b.url) !== url);
  const saved = writeConfig(CFG);
  if (!saved) return { ok: false, error: "Failed to save bookmarks." };
  return { ok: true };
});

/* =========================
   IPC: History
   ========================= */
handleIpc("hist:list", async () => {
  CFG = readConfig();
  return { ok: true, history: CFG.history || [] };
});

handleIpc("hist:clear", async () => {
  CFG = readConfig();
  CFG.history = [];
  const saved = writeConfig(CFG);
  return saved ? { ok: true } : { ok: false, error: "Failed to clear history." };
});

handleIpc("hist:add", async (event, payload) => {
  const url = String(payload?.url || "").trim();
  const title = String(payload?.title || "").trim();
  if (!url) return { ok: false };

  CFG = readConfig();
  const limit = Number(CFG.historyLimit || 500);

  const h = CFG.history || [];
  const last = h[0];
  if (last && last.url === url) {
    last.ts = Date.now();
    if (title) last.title = title;
    const saved = writeConfig(CFG);
    return saved ? { ok: true } : { ok: false, error: "Failed to save history." };
  }

  h.unshift({ url, title, ts: Date.now() });
  CFG.history = h.slice(0, Math.max(50, limit));
  const saved = writeConfig(CFG);
  return saved ? { ok: true } : { ok: false, error: "Failed to save history." };
});

/* =========================
   IPC: Tabs (BrowserView)
   ========================= */
handleIpc("tab:create", async (event, payload) => {
  const tabId = Number(payload?.tabId);
  if (!Number.isFinite(tabId)) return { ok: false, error: "Invalid tab id" };
  if (TAB_VIEWS.has(tabId)) return { ok: true };

  const incognito = !!payload?.incognito;
  const url = String(payload?.url || "");
  const entry = createTabView(tabId, { incognito, url });
  if (url && entry?.view?.webContents) {
    try {
      await entry.view.webContents.loadURL(url);
    } catch (error) {
      console.warn("[TAB] initial load failed:", error?.message || error);
      setActiveTab(tabId);
      return { ok: false, error: formatError(error) };
    }
  }
  setActiveTab(tabId);
  return { ok: true };
});

handleIpc("tab:switch", async (event, tabId) => {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return { ok: false, error: "Invalid tab id" };
  setActiveTab(id);
  return { ok: true };
});

handleIpc("tab:close", async (event, tabId) => {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return { ok: false, error: "Invalid tab id" };
  const entry = TAB_VIEWS.get(id);
  if (!entry) return { ok: true };
  if (ACTIVE_TAB_ID === id && MAIN_WINDOW && entry.view) {
    try { MAIN_WINDOW.removeBrowserView(entry.view); } catch {}
    ACTIVE_TAB_ID = null;
  }
  try { entry.view?.webContents?.destroy(); } catch {}
  TAB_VIEWS.delete(id);
  return { ok: true };
});

handleIpc("tab:navigate", async (event, payload) => {
  const id = Number(payload?.tabId);
  const url = String(payload?.url || "");
  const entry = TAB_VIEWS.get(id);
  if (!entry || !url) return { ok: false };
  try {
    await entry.view.webContents.loadURL(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
});

handleIpc("tab:back", async (event, tabId) => {
  const entry = TAB_VIEWS.get(Number(tabId));
  if (!entry?.view?.webContents) return { ok: false, error: "Tab not found" };
  if (entry.view.webContents.canGoBack()) entry.view.webContents.goBack();
  return { ok: true };
});

handleIpc("tab:forward", async (event, tabId) => {
  const entry = TAB_VIEWS.get(Number(tabId));
  if (!entry?.view?.webContents) return { ok: false, error: "Tab not found" };
  if (entry.view.webContents.canGoForward()) entry.view.webContents.goForward();
  return { ok: true };
});

handleIpc("tab:reload", async (event, tabId) => {
  const entry = TAB_VIEWS.get(Number(tabId));
  if (!entry?.view?.webContents) return { ok: false, error: "Tab not found" };
  entry.view.webContents.reload();
  return { ok: true };
});

handleIpc("tab:devtools", async (event, tabId) => {
  const entry = TAB_VIEWS.get(Number(tabId));
  if (!entry?.view?.webContents) return { ok: false, error: "Tab not found" };
  entry.view.webContents.openDevTools({ mode: "detach" });
  return { ok: true };
});

handleIpc("tab:set-ip", async (event, payload) => {
  const id = Number(payload?.tabId);
  const ip = String(payload?.ip || "");
  const entry = TAB_VIEWS.get(id);
  if (!entry) return { ok: false, error: "Tab not found" };
  entry.ip = ip;
  await injectProtectionIntoView(entry);
  return { ok: true };
});

handleIpc("tab:resize", async (event, payload) => {
  const offset = Number(payload?.topOffset);
  const rightInset = Number(payload?.rightInset);
  const leftInset = Number(payload?.leftInset);
  let touched = false;
  if (Number.isFinite(offset) && offset >= 0) {
    VIEW_TOP_OFFSET = offset;
    touched = true;
  }
  if (Number.isFinite(rightInset) && rightInset >= 0) {
    VIEW_RIGHT_INSET = rightInset;
    touched = true;
  }
  if (Number.isFinite(leftInset) && leftInset >= 0) {
    VIEW_LEFT_INSET = leftInset;
    touched = true;
  }
  if (!touched) return { ok: false, error: "Invalid resize payload." };
  resizeActiveView();
  return { ok: true };
});
