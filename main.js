const { app, BrowserWindow, ipcMain, dialog, net } = require("electron");
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

/* =========================
   CONFIG (auto saved)
   ========================= */
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
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
    extensions: [],
    bookmarks: [],
    history: [],
    historyLimit: 500
  };
}

function readConfig() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return defaultConfig();
    const raw = fs.readFileSync(p, "utf-8");
    const cfg = JSON.parse(raw);
    const base = defaultConfig();
    return {
      ...base,
      ...cfg,
      proxy: { ...base.proxy, ...(cfg.proxy || {}) },
      userAgent: { ...base.userAgent, ...(cfg.userAgent || {}) },
      extensions: Array.isArray(cfg.extensions) ? cfg.extensions : base.extensions,
      bookmarks: Array.isArray(cfg.bookmarks) ? cfg.bookmarks : base.bookmarks,
      history: Array.isArray(cfg.history) ? cfg.history : base.history
    };
  } catch (e) {
    console.warn("[CFG] readConfig failed:", e);
    return defaultConfig();
  }
}

function writeConfig(cfg) {
  try {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.warn("[CFG] writeConfig failed:", e);
    return false;
  }
}

let CFG = defaultConfig();

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
    const res = await fetch(url);
    if (!res.ok) throw new Error("api.myip.com failed: " + res.status);
    return await res.json(); // { ip, country, cc }
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

function getNormalizedUserAgentConfig() {
  const current = CFG.userAgent || defaultConfig().userAgent;
  const normalized = normalizeUserAgentConfig(current, current);
  CFG.userAgent = normalized;
  return normalized;
}

async function applyProxyToSession(ses) {
  const p = getNormalizedProxyConfig();

  if (!p.enabled) {
    await ses.setProxy({ mode: "direct" });
    console.log("[PROXY] disabled (direct)");
    return;
  }

  const rule = `${p.scheme}://${p.host}:${p.port}`;
  const proxyConfig = { proxyRules: rule };
  if (p.bypass) proxyConfig.proxyBypassRules = p.bypass;

  await ses.setProxy(proxyConfig);
  console.log("[PROXY] enabled:", rule, p.bypass ? `bypass=${p.bypass}` : "");
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
      webviewTag: true
    }
  });

  const ses = win.webContents.session;

  // ===== STRONG Anti-FP / Privacy hardening =====

  // 1) clear everything on startup
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
    if (authInfo && authInfo.isProxy && p.enabled) {
      event.preventDefault();
      callback(p.username || "", p.password || "");
      return;
    }
  });

  await applyProxyToSession(ses);
  await loadEnabledExtensions(ses);

  win.loadFile("index.html");
}

/* =========================
   App lifecycle
   ========================= */
app.whenReady().then(() => {
  CFG = readConfig();
  CFG.proxy = getNormalizedProxyConfig();
  CFG.userAgent = getNormalizedUserAgentConfig();
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
ipcMain.handle("get-ip-for-tab", async (event, tabId) => {
  const data = await getMyIp(event.sender.session);
  console.log("[BACKEND] New tab:", tabId, "IP:", data.ip, "Country:", data.country, data.cc);
  return { tabId, ...data };
});

/* =========================
   IPC: external geo enrich
   ========================= */
ipcMain.handle("geo:enrich-ip", async (event, ip) => {
  const serviceUrl = `http://127.0.0.1:8787/enrich?ip=${encodeURIComponent(String(ip || ""))}`;
  const r = await fetch(serviceUrl);
  if (!r.ok) throw new Error("geo_service failed: " + r.status);
  return await r.json();
});

/* =========================
   IPC: config get
   ========================= */
ipcMain.handle("cfg:get", async () => {
  CFG = readConfig();
  CFG.proxy = getNormalizedProxyConfig();
  CFG.userAgent = getNormalizedUserAgentConfig();
  return {
    proxy: { ...CFG.proxy, password: CFG.proxy?.password ? "*****" : "" },
    userAgent: CFG.userAgent,
    extensions: CFG.extensions || [],
    bookmarks: CFG.bookmarks || [],
    history: CFG.history || [],
    historyLimit: CFG.historyLimit || 500
  };
});

/* =========================
   IPC: proxy set (save + apply)
   ========================= */
ipcMain.handle("proxy:set", async (event, proxyConfig) => {
  CFG = readConfig();
  CFG.proxy = normalizeProxyConfig(proxyConfig, CFG.proxy);

  writeConfig(CFG);
  await applyProxyToSession(event.sender.session);

  return { ok: true, proxy: { ...CFG.proxy, password: CFG.proxy.password ? "*****" : "" } };
});

/* =========================
   IPC: user agent set
   ========================= */
ipcMain.handle("ua:set", async (event, payload) => {
  CFG = readConfig();
  CFG.userAgent = normalizeUserAgentConfig(payload, CFG.userAgent);
  writeConfig(CFG);
  return { ok: true, userAgent: CFG.userAgent };
});

/* =========================
   IPC: Extensions manager
   ========================= */
ipcMain.handle("ext:pickFolder", async () => {
  const r = await dialog.showOpenDialog({
    title: "Select unpacked Chrome extension folder (contains manifest.json)",
    properties: ["openDirectory"]
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle("ext:list", async (event) => {
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

ipcMain.handle("ext:add", async (event, extPath) => {
  const ses = event.sender.session;
  CFG = readConfig();

  const p = normalizeExtPath(extPath);
  if (!CFG.extensions.some(x => normalizeExtPath(x.path) === p)) {
    CFG.extensions.push({ path: p, enabled: true });
    writeConfig(CFG);
  }

  try {
    const ext = await ses.loadExtension(p, { allowFileAccess: true });
    return { ok: true, id: ext.id, name: ext.name, path: p };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), path: p };
  }
});

ipcMain.handle("ext:toggle", async (event, payload) => {
  const ses = event.sender.session;
  const p = normalizeExtPath(payload?.path);
  const enable = !!payload?.enabled;

  CFG = readConfig();
  const idx = CFG.extensions.findIndex(x => normalizeExtPath(x.path) === p);
  if (idx === -1) return { ok: false, error: "Extension not found in config." };

  CFG.extensions[idx].enabled = enable;
  writeConfig(CFG);

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

ipcMain.handle("ext:remove", async (event, payload) => {
  const ses = event.sender.session;
  const p = normalizeExtPath(payload?.path);

  CFG = readConfig();
  CFG.extensions = (CFG.extensions || []).filter(x => normalizeExtPath(x.path) !== p);
  writeConfig(CFG);

  const loaded = listLoadedExtensions(ses);
  const found = loaded.find(x => normalizeExtPath(x.path) === p);
  if (found?.id) await unloadExtensionById(ses, found.id);

  return { ok: true };
});

/* =========================
   IPC: Bookmarks
   ========================= */
ipcMain.handle("bm:list", async () => {
  CFG = readConfig();
  return { ok: true, bookmarks: CFG.bookmarks || [] };
});

ipcMain.handle("bm:add", async (event, payload) => {
  const title = String(payload?.title || "").trim() || "Bookmark";
  const url = String(payload?.url || "").trim();
  if (!url) return { ok: false, error: "Missing url" };

  CFG = readConfig();
  const exists = (CFG.bookmarks || []).some(b => String(b.url) === url);
  if (!exists) {
    CFG.bookmarks.push({ title, url, createdAt: Date.now() });
    writeConfig(CFG);
  }
  return { ok: true };
});

ipcMain.handle("bm:remove", async (event, payload) => {
  const url = String(payload?.url || "").trim();
  CFG = readConfig();
  CFG.bookmarks = (CFG.bookmarks || []).filter(b => String(b.url) !== url);
  writeConfig(CFG);
  return { ok: true };
});

/* =========================
   IPC: History
   ========================= */
ipcMain.handle("hist:list", async () => {
  CFG = readConfig();
  return { ok: true, history: CFG.history || [] };
});

ipcMain.handle("hist:clear", async () => {
  CFG = readConfig();
  CFG.history = [];
  writeConfig(CFG);
  return { ok: true };
});

ipcMain.handle("hist:add", async (event, payload) => {
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
    writeConfig(CFG);
    return { ok: true };
  }

  h.unshift({ url, title, ts: Date.now() });
  CFG.history = h.slice(0, Math.max(50, limit));
  writeConfig(CFG);

  return { ok: true };
});
