'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petbuddy', {
  // state
  getState: () => ipcRenderer.invoke('pb:get-state'),
  onState: (cb) => ipcRenderer.on('pb:state', (_e, snap) => cb(snap)),

  // pet window
  decide: (id, decision) => ipcRenderer.invoke('pb:decide', { id, decision }),
  setNeedHeight: (px) => ipcRenderer.invoke('pb:set-need-height', px),
  openSettings: () => ipcRenderer.invoke('pb:open-settings'),
  quit: () => ipcRenderer.invoke('pb:quit'),
  openDataDir: () => ipcRenderer.invoke('pb:open-data-dir'),
  openPetdex: () => ipcRenderer.invoke('pb:open-petdex'),
  dragBy: (dx, dy) => ipcRenderer.invoke('pb:drag-by', { dx, dy }),
  dragEnd: () => ipcRenderer.invoke('pb:drag-end'),
  rescanApps: () => ipcRenderer.invoke('pb:rescan-apps'),
  addApp: (entry) => ipcRenderer.invoke('pb:add-app', entry),
  updateApp: (id, patch) => ipcRenderer.invoke('pb:update-app', { id, patch }),
  deleteApp: (id) => ipcRenderer.invoke('pb:delete-app', id),
  fetchIcon: (id, site) => ipcRenderer.invoke('pb:fetch-icon', { id, site }),
  petdexInstall: (name) => ipcRenderer.invoke('pb:petdex-install', name),
  petdexSearch: (q) => ipcRenderer.invoke('pb:petdex-search', q),
  petdexList: () => ipcRenderer.invoke('pb:petdex-list'),
  petdexDelete: (name) => ipcRenderer.invoke('pb:petdex-delete', name),
  winMin: () => ipcRenderer.invoke('pb:win-min'),
  winClose: () => ipcRenderer.invoke('pb:win-close'),
  logLine: (line) => ipcRenderer.invoke('pb:log', line),
  setPinned: (on) => ipcRenderer.invoke('pb:set-pinned', on),

  // settings window
  getSettings: () => ipcRenderer.invoke('pb:get-settings'),
  patchSettings: (patch) => ipcRenderer.invoke('pb:patch-settings', patch),
  setAutostart: (enable) => ipcRenderer.invoke('pb:set-autostart', enable),
  testKeys: (appId, seq) => ipcRenderer.invoke('pb:test-keys', { appId, seq }),
  integration: (action, appId) => ipcRenderer.invoke('pb:integration', { action, appId }),
});
