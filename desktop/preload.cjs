const { contextBridge, ipcRenderer } = require('electron');
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('learnflowDesktop', Object.freeze({
  load: () => invoke('learnflow:load'),
  saveState: value => invoke('learnflow:save-state', value),
  saveSettings: value => invoke('learnflow:save-settings', value),
  request: (endpoint, data) => invoke('learnflow:request', endpoint, data),
  exportFile: (name, content) => invoke('learnflow:export', name, content),
  openDataFolder: () => invoke('learnflow:open-data'),
  importBackup: () => invoke('learnflow:import')
}));
