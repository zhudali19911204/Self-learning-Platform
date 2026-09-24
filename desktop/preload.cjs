const { contextBridge, ipcRenderer } = require('electron');
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('learnflowDesktop', Object.freeze({
  load: () => invoke('learnflow:load'),
  getLesson: id => invoke('learnflow:get-lesson', id),
  savePlan: value => invoke('learnflow:save-plan', value),
  setActivePlan: id => invoke('learnflow:set-active-plan', id),
  saveLesson: (id, value) => invoke('learnflow:save-lesson', id, value),
  saveOutline: (id, value) => invoke('learnflow:save-outline', id, value),
  appendBlock: (id, value) => invoke('learnflow:append-block', id, value),
  saveBlock: (id, blockId, value) => invoke('learnflow:save-block', id, blockId, value),
  saveProgress: (id, value) => invoke('learnflow:save-progress', id, value),
  saveReflection: (id, value) => invoke('learnflow:save-reflection', id, value),
  appendChat: (id, question, answer) => invoke('learnflow:append-chat', id, question, answer),
  saveNote: value => invoke('learnflow:save-note', value),
  saveSettings: value => invoke('learnflow:save-settings', value),
  request: (endpoint, data) => invoke('learnflow:request', endpoint, data),
  exportFile: (name, content) => invoke('learnflow:export', name, content),
  exportBackup: () => invoke('learnflow:export-backup'),
  openDataFolder: () => invoke('learnflow:open-data'),
  importBackup: () => invoke('learnflow:import')
}));
