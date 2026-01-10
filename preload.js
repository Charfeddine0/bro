const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("AutoIP", {
  getIpForTab: (tabId) => ipcRenderer.invoke("get-ip-for-tab", tabId),
  getMainIp: () => ipcRenderer.invoke("get-ip-main")
});

contextBridge.exposeInMainWorld("GeoAPI", {
  enrichIp: (ip) => ipcRenderer.invoke("geo:enrich-ip", ip)
});

contextBridge.exposeInMainWorld("CfgAPI", {
  get: () => ipcRenderer.invoke("cfg:get"),
  set: (payload) => ipcRenderer.invoke("cfg:set", payload)
});

contextBridge.exposeInMainWorld("HardeningAPI", {
  apply: (payload) => ipcRenderer.invoke("hardening:apply", payload),
  rollback: () => ipcRenderer.invoke("hardening:rollback")
});

contextBridge.exposeInMainWorld("ProxyCtl", {
  set: (cfg) => ipcRenderer.invoke("proxy:set", cfg),
  test: (payload) => ipcRenderer.invoke("proxy:test", payload)
});

contextBridge.exposeInMainWorld("UA", {
  set: (payload) => ipcRenderer.invoke("ua:set", payload)
});

contextBridge.exposeInMainWorld("ExtAPI", {
  pickFolder: () => ipcRenderer.invoke("ext:pickFolder"),
  list: () => ipcRenderer.invoke("ext:list"),
  add: (extPath) => ipcRenderer.invoke("ext:add", extPath),
  toggle: (payload) => ipcRenderer.invoke("ext:toggle", payload),
  remove: (payload) => ipcRenderer.invoke("ext:remove", payload)
});

contextBridge.exposeInMainWorld("BM", {
  list: () => ipcRenderer.invoke("bm:list"),
  add: (payload) => ipcRenderer.invoke("bm:add", payload),
  remove: (payload) => ipcRenderer.invoke("bm:remove", payload)
});

contextBridge.exposeInMainWorld("HIST", {
  list: () => ipcRenderer.invoke("hist:list"),
  add: (payload) => ipcRenderer.invoke("hist:add", payload),
  clear: () => ipcRenderer.invoke("hist:clear")
});

contextBridge.exposeInMainWorld("TabAPI", {
  create: (payload) => ipcRenderer.invoke("tab:create", payload),
  switch: (tabId) => ipcRenderer.invoke("tab:switch", tabId),
  close: (tabId) => ipcRenderer.invoke("tab:close", tabId),
  navigate: (payload) => ipcRenderer.invoke("tab:navigate", payload),
  back: (tabId) => ipcRenderer.invoke("tab:back", tabId),
  forward: (tabId) => ipcRenderer.invoke("tab:forward", tabId),
  reload: (tabId) => ipcRenderer.invoke("tab:reload", tabId),
  devtools: (tabId) => ipcRenderer.invoke("tab:devtools", tabId),
  setIp: (payload) => ipcRenderer.invoke("tab:set-ip", payload),
  resize: (payload) => ipcRenderer.invoke("tab:resize", payload),
  onUpdate: (handler) => {
    ipcRenderer.on("tab:update", (_event, payload) => {
      if (typeof handler === "function") handler(payload);
    });
  }
});
