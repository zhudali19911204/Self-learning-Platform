const { contextBridge, ipcRenderer } = require('electron');
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('learnflowDesktop', Object.freeze({
  load: () => invoke('learnflow:load'),
  saveSettingsLayout: value => invoke('learnflow:save-settings-layout', value),
  getLesson: id => invoke('learnflow:get-lesson', id),
  setCourseSourceSearch: (id, enabled) => invoke('learnflow:set-course-source-search', id, enabled),
  openCourseSource: url => invoke('learnflow:open-course-source', url),
  savePlan: value => invoke('learnflow:save-plan', value),
  setActivePlan: id => invoke('learnflow:set-active-plan', id),
  deletePlan: id => invoke('learnflow:delete-plan', id),
  saveLesson: (id, value) => invoke('learnflow:save-lesson', id, value),
  saveOutline: (id, value) => invoke('learnflow:save-outline', id, value),
  appendBlock: (id, value) => invoke('learnflow:append-block', id, value),
  saveBlock: (id, blockId, value) => invoke('learnflow:save-block', id, blockId, value),
  reviseBlock: (id, blockId, value, expectedText) => invoke('learnflow:revise-block', id, blockId, value, expectedText),
  restoreBlock: (id, blockId, expectedText) => invoke('learnflow:restore-block', id, blockId, expectedText),
  saveProgress: (id, value) => invoke('learnflow:save-progress', id, value),
  saveReflection: (id, value) => invoke('learnflow:save-reflection', id, value),
  saveAnnotations: (id, value) => invoke('learnflow:save-annotations', id, value),
  appendChat: (id, question, answer) => invoke('learnflow:append-chat', id, question, answer),
  saveNote: value => invoke('learnflow:save-note', value),
  deleteNote: id => invoke('learnflow:delete-note', id),
  cardMarkdown: id => invoke('learnflow:card-markdown', id),
  saveSettings: value => invoke('learnflow:save-settings', value),
  saveQualitySettings: value => invoke('learnflow:save-quality-settings', value),
  setFactCheckEnabled: enabled => invoke('learnflow:set-fact-check-enabled', enabled),
  generateCourseBlock: (value, progressId) => invoke('learnflow:generate-course-block', value, progressId),
  checkBlockFacts: (lessonId, blockId, progressId) => invoke('learnflow:check-block-facts', lessonId, blockId, progressId),
  restoreFactCheck: (lessonId, blockId, recordId) => invoke('learnflow:restore-fact-check', lessonId, blockId, recordId),
  correctFactIssues: (value, progressId) => invoke('learnflow:correct-fact-issues', value, progressId),
  testQualityConnection: () => invoke('learnflow:test-quality-connection'),
  inspectQuality: (scope, id) => invoke('learnflow:inspect-quality', scope, id),
  evaluateQuality: (scope, id, fingerprint) => invoke('learnflow:evaluate-quality', scope, id, fingerprint),
  saveImageSettings: value => invoke('learnflow:save-image-settings', value),
  saveSpeechSettings: value => invoke('learnflow:save-speech-settings', value),
  checkSpeechConnection: () => invoke('learnflow:check-speech-connection'),
  prepareSpeech: value => invoke('learnflow:prepare-speech', value),
  generateSpeech: value => invoke('learnflow:generate-speech', value),
  checkImageConnection: () => invoke('learnflow:check-image-connection'),
  suggestIllustration: (id, blockId) => invoke('learnflow:suggest-illustration', id, blockId),
  searchCommonsImages: query => invoke('learnflow:search-commons-images', query),
  autoSearchCommonsImages: (id, blockId) => invoke('learnflow:auto-search-commons-images', id, blockId),
  useCommonsImage: value => invoke('learnflow:use-commons-image', value),
  openCommonsSource: url => invoke('learnflow:open-commons-source', url),
  saveWebSearchSettings: value => invoke('learnflow:save-web-search-settings', value),
  searchWebImages: query => invoke('learnflow:search-web-images', query),
  autoSearchWebImages: (id, blockId) => invoke('learnflow:auto-search-web-images', id, blockId),
  useWebImage: value => invoke('learnflow:use-web-image', value),
  openImageSource: url => invoke('learnflow:open-image-source', url),
  generateIllustration: value => invoke('learnflow:generate-illustration', value),
  getPendingIllustration: (id, blockId) => invoke('learnflow:get-pending-illustration', id, blockId),
  retryIllustrationDownload: value => invoke('learnflow:retry-illustration-download', value),
  discardIllustrationDownload: (id, blockId, pendingId) => invoke('learnflow:discard-illustration-download', id, blockId, pendingId),
  request: (endpoint, data, progressId) => invoke('learnflow:request', endpoint, data, progressId),
  onGenerationProgress: listener => {
    if (typeof listener !== 'function') return () => {};
    const receive = (_event, value) => {
      if (typeof value?.requestId === 'string' && ['preparing', 'searching', 'generating', 'validating', 'fact_checking', 'fact_correcting', 'fact_rechecking'].includes(value.stage)) listener({ requestId: value.requestId, stage: value.stage });
    };
    ipcRenderer.on('learnflow:generation-progress', receive);
    return () => ipcRenderer.removeListener('learnflow:generation-progress', receive);
  },
  exportFile: (name, content) => invoke('learnflow:export', name, content),
  exportBackup: () => invoke('learnflow:export-backup'),
  exportCourse: id => invoke('learnflow:export-course', id),
  importCourse: () => invoke('learnflow:import-course'),
  openDataFolder: () => invoke('learnflow:open-data'),
  importBackup: () => invoke('learnflow:import')
}));
