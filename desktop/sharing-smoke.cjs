// Offline desktop integration: real preload/IPC, fake native file dialogs, isolated data.
const assert = require('node:assert/strict');
const { dialog } = require('electron');
const path = require('node:path');
const { readFile, writeFile } = require('node:fs/promises');
exports.run = async (window, directory) => {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const original = { showSaveDialog: dialog.showSaveDialog, showOpenDialog: dialog.showOpenDialog, showMessageBox: dialog.showMessageBox };
  const filename = path.join(directory, 'shared.learnflow-course.json');
  const invalid = path.join(directory, 'invalid-course.json');
  const before = await evaluate('window.learnflowDesktop.load()');
  const planId = before.state.plans[0].id;
  try {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    dialog.showMessageBox = async () => ({ response: 0 });
    assert.equal(await evaluate(`window.learnflowDesktop.exportCourse(${JSON.stringify(planId)})`), false);
    await assert.rejects(readFile(filename));
    dialog.showMessageBox = async () => ({ response: 1 });
    assert.equal(await evaluate(`window.learnflowDesktop.exportCourse(${JSON.stringify(planId)})`), true);
    const packed = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(packed.format, 'learnflow-course');
    assert.equal(Object.keys(packed.lessons).length, before.state.plans[0].lessons.length);
    assert.equal(packed.progress, undefined);
    dialog.showMessageBox = async () => ({ response: 0 });
    assert.equal(await evaluate('window.learnflowDesktop.importCourse()'), null);
    assert.equal((await evaluate('window.learnflowDesktop.load()')).state.plans.length, before.state.plans.length);
    dialog.showMessageBox = async () => ({ response: 1 });
    const imported = await evaluate('window.learnflowDesktop.importCourse()');
    assert.equal(imported.state.plans.length, before.state.plans.length + 1);
    assert.notEqual(imported.planId, planId);
    const added = imported.state.plans.find(p => p.id === imported.planId);
    const lesson = await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(added.lessons[0].id)})`);
    assert.equal(lesson.lesson.intro, packed.lessons['lesson-1'].intro);
    assert.deepEqual(lesson.chats, []);
    await writeFile(invalid, JSON.stringify({ ...packed, version: 999 }));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [invalid] });
    await assert.rejects(evaluate('window.learnflowDesktop.importCourse()'), /课程包/);
    assert.equal((await evaluate('window.learnflowDesktop.load()')).state.plans.length, before.state.plans.length + 1);
    const ready = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload(); await ready;
    await evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(document.querySelector('[data-page=routes]')){clearInterval(timer);document.querySelector('[data-page=routes]').click();resolve();}else if(++n>100){clearInterval(timer);reject(new Error('UI timeout'));}},100);})`);
    assert.equal(await evaluate("!!document.querySelector('[data-action=export-course]') && !!document.querySelector('[data-action=import-course]')"), true);
    console.log('COURSE_SHARING_SMOKE_OK');
  } finally { Object.assign(dialog, original); }
};
