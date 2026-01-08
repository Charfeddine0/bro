const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("AutoIP", {
  getIpForTab: (tabId) => ipcRenderer.invoke("get-ip-for-tab", tabId)
});

contextBridge.exposeInMainWorld("GeoAPI", {
  enrichIp: (ip) => ipcRenderer.invoke("geo:enrich-ip", ip)
});

contextBridge.exposeInMainWorld("CfgAPI", {
  get: () => ipcRenderer.invoke("cfg:get")
});

contextBridge.exposeInMainWorld("ProxyCtl", {
  set: (cfg) => ipcRenderer.invoke("proxy:set", cfg)
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
