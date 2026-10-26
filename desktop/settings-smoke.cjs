// Settings UI checks run only against the disposable --smoke-test profile.
const assert = require('node:assert/strict');
const { writeFile, readFile } = require('node:fs/promises');
const path = require('node:path');
exports.run = async (window, directory) => {
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const originalBounds = window.getBounds();
  await evaluate("new Promise((resolve,reject)=>{let tries=0;const timer=setInterval(()=>{if(document.querySelector('main h1')){clearInterval(timer);resolve()}else if(++tries>100){clearInterval(timer);reject(new Error('Initial settings load timed out'))}},50)})");
  const originalLayout = (await evaluate('window.learnflowDesktop.load()')).settingsLayout || {generator:true,reviewer:false,images:false,speech:false};
  try {
    // Four compact summaries, all configuration remains on this same page.
    await evaluate("document.querySelector('[data-page=settings]').click();document.querySelectorAll('.settings-model[open]>summary').forEach(summary=>summary.click())");
    await frames();
    assert.equal(await evaluate("document.querySelectorAll('.settings-model[open]').length"), 0);
    assert.equal(await evaluate("document.querySelector('#web-search-settings-form').closest('#settings-images')!==null"), true);
    assert.equal(await evaluate("document.querySelectorAll('.settings-data-groups>section').length"), 3);
    assert.equal(await evaluate("[...document.querySelectorAll('[data-model-check]')].every(button=>button.type==='button')"), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.settings-section-nav')).flexDirection"), 'row');
    await writeFile(path.join(directory, '..', 'settings-overview-smoke.png'), (await window.webContents.capturePage()).toPNG());
    // Open multiple forms, preserve that preference through a real reload.
    await evaluate("document.querySelector('#settings-generator>summary').click();document.querySelector('#settings-images>summary').click()");
    await frames();
    const saved = await evaluate('window.learnflowDesktop.load()');
    assert.equal(saved.settingsLayout.generator, true); assert.equal(saved.settingsLayout.images, true);
    const disk = JSON.parse(await readFile(path.join(directory,'settings-layout.json'),'utf8'));
    assert.deepEqual(Object.keys(disk.panels).sort(), ['generator','images','reviewer','speech']);
    assert.ok(Object.values(disk.panels).every(value=>typeof value==='boolean'));
    window.webContents.reload(); await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
    await evaluate("new Promise((resolve,reject)=>{let tries=0;const timer=setInterval(()=>{if(document.querySelector('main h1')){clearInterval(timer);resolve()}else if(++tries>100){clearInterval(timer);reject(new Error('Settings load timed out'))}},50)})");
    await evaluate("document.querySelector('[data-page=settings]').click()");
    assert.equal(await evaluate("document.querySelector('#settings-generator').open && document.querySelector('#settings-images').open"), true);
    // Changed fields must not be sent anywhere just by folding or navigating.
    await evaluate("document.querySelector('#image-model-key').value='unsaved-settings-smoke-only';document.querySelector('#image-model-key').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#settings-images>summary').click();document.querySelector('[data-page=wiki]').click();document.querySelector('[data-page=settings]').click()");
    assert.equal(await evaluate("document.querySelector('#image-model-key').value"), 'unsaved-settings-smoke-only');
    assert.equal(await evaluate("document.querySelector('#settings-images').open"), false);
    assert.equal(await evaluate("window.dispatchEvent(new Event('beforeunload',{cancelable:true}))"), false);
    assert.ok(!(await readFile(path.join(directory,'settings-layout.json'),'utf8')).includes('unsaved-settings-smoke-only'));
    // Test the smallest desktop window: fields stack and actions stay accessible.
    window.setSize(760, 820);
    await evaluate("document.querySelector('#settings-generator>summary').click();document.querySelector('#settings-speech>summary').click();document.querySelector('#settings-speech').scrollIntoView({block:'start'})");
    await frames();
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'Small settings window must not scroll horizontally');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#speech-settings-form .settings-fields')).gridTemplateColumns.split(' ').length"), 1);
    assert.equal(await evaluate("[...document.querySelectorAll('#speech-settings-form .settings-form-actions .btn')].every(button=>button.getBoundingClientRect().height>=(button.classList.contains('primary')?40:32))"), true, 'Settings actions follow the 40px primary / 32px secondary size contract');
    await writeFile(path.join(directory, '..', 'settings-narrow-smoke.png'), (await window.webContents.capturePage()).toPNG());
    console.log('SETTINGS_LAYOUT_SMOKE', JSON.stringify({passed:true,checks:['four-model-summaries','nested-web-search','separate-data-tasks','no-horizontal-overflow','layout-reload','draft-preservation','beforeunload-guard','narrow-window']}));
  } finally {
    window.setBounds(originalBounds);
    await evaluate(`window.learnflowDesktop.saveSettingsLayout(${JSON.stringify(originalLayout)})`);
    // Disposable test drafts are discarded on reload; never touch development data.
    window.webContents.reload(); await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
    await evaluate("new Promise((resolve,reject)=>{let tries=0;const timer=setInterval(()=>{if(document.querySelector('main h1')){clearInterval(timer);resolve()}else if(++tries>100){clearInterval(timer);reject(new Error('Settings restore timed out'))}},50)})");
    await evaluate("document.querySelector('[data-page=settings]').click()");
  }
};
