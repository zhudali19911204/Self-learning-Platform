// Test-only evaluator: no real account, keys, billing or daily learning data.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');

exports.run = async (window, directory) => {
  const { demoPlan } = await import('../public/demo.js');
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = expression => evaluate(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true);}else if(++attempts>150){clearInterval(timer);reject(new Error('Quality smoke timed out'));}},100);})`);
  const reload = async () => { window.webContents.reload(); await new Promise(resolve => window.webContents.once('did-finish-load', resolve)); await wait("document.querySelector('main h1')"); };
  const original = await evaluate('window.learnflowDesktop.load()');
  const requests = []; let checks = 0, invalidQuote = false;
  const model = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer quality-smoke-key-not-real');
      let body = ''; for await (const part of req) body += part;
      const payload = JSON.parse(body), input = JSON.parse(payload.messages[1].content);
      assert.equal(payload.model, 'quality-smoke-reviewer');
      let result;
      if (input.task === 'connection-test') { checks++; result = { ok: true }; }
      else {
        requests.push(input);
        assert.ok(!JSON.stringify(input).includes('"answer":'));
        assert.ok(!JSON.stringify(input).includes('"explanation":'));
        assert.ok(!input.chats && !input.progress && !input.annotations);
        const unit = input.units.find(u => !u.pending && u.text);
        result = { summary: '独立模型已审查当前材料；关键事实仍需外部核验。', dimensions: input.rubric.map(r => ({ id: r.id, rating: 4, reason: '已结合本课目标核对解释和操作步骤。' })),
          issues: [{ unitId: unit.id, severity: 'minor', kind: 'clarity', quote: invalidQuote ? '不存在于课程的伪造引文' : unit.text.slice(0, 100), reason: '可以说明验证结果的含义。', suggestion: '补充命令成功时的预期输出。' }],
          solutions: input.units.flatMap(u => (u.questions || []).map((q, questionIndex) => ({ unitId: u.id, questionIndex, answer: 1, ambiguous: false, reason: '测试独立作答与保存答案的分歧处理。' }))) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
    } catch { res.writeHead(500); res.end('Mock validation failed'); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${model.address().port}/v1`;
  const reset = { provider: 'ollama', model: '', baseUrl: '', localOnly: true, keyAction: 'clear', apiKey: '', jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  try {
    await evaluate(`window.learnflowDesktop.saveQualitySettings(${JSON.stringify(reset)})`);
    await reload();
    await evaluate("document.querySelector('[data-page=settings]').click()");
    await wait("document.querySelector('#quality-settings-form')");
    await evaluate(`document.querySelector('#quality-model-provider').value='compatible';document.querySelector('#quality-model-provider').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#quality-model-name').value=${JSON.stringify(original.settings.model)};document.querySelector('#quality-model-url').value=${JSON.stringify(origin)};document.querySelector('#quality-settings-form [name=localOnly]').checked=true;document.querySelector('#quality-model-key').value='quality-smoke-key-not-real';document.querySelector('#quality-settings-form').requestSubmit()`);
    await wait("document.querySelector('#quality-settings-error')?.textContent.includes('必须不同')");
    assert.equal((await evaluate('window.learnflowDesktop.load()')).qualitySettings.model, '');
    assert.equal(await evaluate("document.querySelector('#quality-model-key').value"), 'quality-smoke-key-not-real');
    await evaluate("document.querySelector('#model-name').value='pending-generator-draft';document.querySelector('#model-name').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#quality-model-name').value='quality-smoke-reviewer';document.querySelector('#quality-settings-form').requestSubmit()");
    await wait("document.querySelector('#quality-connection-result')?.textContent.includes('独立评审模型已保存')");
    assert.equal(await evaluate("document.querySelector('#model-name').value"), 'pending-generator-draft');
    const encrypted = await readFile(path.join(directory, 'quality-settings.json'), 'utf8');
    assert.ok(!encrypted.includes('quality-smoke-key-not-real')); assert.ok(JSON.parse(encrypted).encryptedApiKey);
    const configured = await evaluate('window.learnflowDesktop.load()');
    assert.equal(configured.qualityStatus.mode, 'ai'); assert.equal(configured.qualitySettings.apiKey, undefined);
    assert.equal(configured.settings.model, original.settings.model); assert.equal(requests.length, 0); assert.equal(checks, 0);
    const generatorConflict = await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({ ...original.settings, model: 'quality-smoke-reviewer', keyAction: 'keep', apiKey: '' })}).then(()=>'',error=>error.message)`);
    assert.match(generatorConflict, /必须不同/);
    await evaluate("document.querySelector('[data-action=test-quality-connection]').click()");
    await wait("document.querySelector('#quality-connection-result')?.textContent.includes('评审连接成功')");
    assert.equal(checks, 1); assert.equal(requests.length, 0);
    const plan = { ...structuredClone(demoPlan), id: `quality-${randomUUID()}`, title: '独立模型课程质量测试', goal: '在 Windows 中验证 Git 安装与版本', lessons: demoPlan.lessons.map((l, i) => ({ ...l, id: `quality-${randomUUID()}`, title: `验证 Git · 第 ${i + 1} 课`, objective: `能完成 Git 验证步骤 ${i + 1}` })) };
    const lessonId = plan.lessons[0].id;
    await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(plan)})`);
    const outline = await evaluate(`window.learnflowDesktop.saveOutline(${JSON.stringify(lessonId)},{intro:'通过命令核对安装。',blocks:[{type:'reading',title:'验证版本',objective:'能判断 Git 是否可用'},{type:'quiz',title:'命令选择',objective:'能选择版本命令'},{type:'example',title:'输出案例',objective:'能解释版本输出'}]})`);
    const reading = { text: '在 Windows PowerShell 中运行 git --version，检查是否输出版本号。' };
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)},${JSON.stringify(outline.blocks[0].id)},${JSON.stringify(reading)})`);
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)},${JSON.stringify(outline.blocks[1].id)},{questions:[{prompt:'哪个命令验证 Git 版本？',options:['git --version','git init','git commit','git status'],answer:0,explanation:'--version 显示版本。'}]})`);
    const before = await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`);
    await reload();
    await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('[data-action=open-quality][data-scope=lesson]')");
    await evaluate("document.querySelector('[data-action=open-quality][data-scope=lesson]').click()");
    await wait("document.querySelector('#quality-dialog').open");
    assert.equal(requests.length, 0);
    await evaluate("document.querySelector('[data-action=evaluate-quality]').click()");
    await wait("document.querySelector('.quality-report') && !document.querySelector('[data-action=evaluate-quality]').disabled");
    assert.equal(requests.length, 1);
    const inspected = await evaluate(`window.learnflowDesktop.inspectQuality('lesson',${JSON.stringify(lessonId)})`);
    assert.equal(inspected.reports[0].score, 100); assert.equal(inspected.reports[0].status, 'needs_revision'); assert.equal(inspected.reports[0].partial, true);
    assert.ok(inspected.reports[0].issues.some(i => i.kind === 'quiz' && i.severity === 'major'));
    assert.deepEqual(await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`), before);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(path.join(directory, '..', 'quality-smoke.png'), (await window.webContents.capturePage()).toPNG());
    invalidQuote = true;
    await evaluate("document.querySelector('[data-action=evaluate-quality]').click()");
    await wait("document.querySelector('#quality-error')?.textContent.includes('格式不符合要求') && !document.querySelector('[data-action=evaluate-quality]').disabled");
    assert.equal(requests.length, 2);
    assert.equal((await evaluate(`window.learnflowDesktop.inspectQuality('lesson',${JSON.stringify(lessonId)})`)).reports[0].id, inspected.reports[0].id);
    await evaluate("document.querySelector('[data-action=quality-locate]').click()");
    await wait("!document.querySelector('#quality-dialog').open && document.querySelector('.quality-target')");
    await reload();
    await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('[data-action=open-quality][data-scope=lesson]')");
    await evaluate("document.querySelector('[data-action=open-quality][data-scope=lesson]').click()");
    await wait("document.querySelector('#quality-dialog').open && document.querySelector('.quality-report')");
    assert.equal(requests.length, 2); assert.equal(checks, 1);
    await evaluate("document.querySelector('[data-action=close-quality]').click()");
    await evaluate(`window.learnflowDesktop.reviseBlock(${JSON.stringify(lessonId)},${JSON.stringify(outline.blocks[0].id)},{text:'在 Windows PowerShell 中先检查当前目录，再运行 git --version。'},${JSON.stringify(reading.text)})`);
    await evaluate("document.querySelector('[data-action=open-quality][data-scope=lesson]').click()");
    await wait("document.querySelector('#quality-dialog').textContent.includes('旧内容版本')");
    assert.equal((await evaluate(`window.learnflowDesktop.inspectQuality('lesson',${JSON.stringify(lessonId)})`)).currentReportId, null);
    assert.equal(requests.length, 2);
    await evaluate("document.querySelector('[data-action=close-quality]').click()");
    console.log('QUALITY_SMOKE', JSON.stringify({ passed: true, checks: ['independent-form-ipc-and-os-encryption', 'both-model-role-exclusions', 'save-load-open-no-evaluation', 'connection-test-no-course', 'partial-review-and-blind-quiz-solutions', 'failed-evidence-no-retry-no-overwrite', 'source-location', 'reload-report-persistence', 'stale-report-warning'], screenshot: path.join(directory, '..', 'quality-smoke.png') }));
  } finally {
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await evaluate(`window.learnflowDesktop.saveQualitySettings(${JSON.stringify(reset)})`);
    await evaluate(`window.learnflowDesktop.setActivePlan(${JSON.stringify(original.state.active)})`);
    await reload();
  }
};
