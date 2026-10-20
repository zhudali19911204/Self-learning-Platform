// Test-only local models; verifies real renderer -> IPC -> API -> saved courses.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
exports.run=async(window,directory)=>{
  window.webContents.setBackgroundThrottling(false);
  const {demoPlan}=await import('../public/demo.js');
  const evaluate=code=>window.webContents.executeJavaScript(code).catch(error=>{console.error('GENERATION_SMOKE_STEP',code.slice(0,200));throw error;});
  const wait=expression=>evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true);}else if(++n>150){clearInterval(timer);reject(new Error('Generation smoke timed out: '+document.querySelector('#toast')?.textContent));}},100);})`);
  const reload=async()=>{window.webContents.reload();await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));await wait("document.querySelector('main h1')");};
  const original=await evaluate('window.learnflowDesktop.load()'),requests=[];
  const reading=('## 配置身份\n\n首次提交前，先配置提交身份。\n\n'+'必要前提与简短解释。'.repeat(180)).slice(0,987)+'\n\n- `git config --get user.name` 用于核对用户名。\n\n代码标记只是字面量：`[S8E3]`。\n\n## 核对设置\n\n运行 git config --get user.name 核对用户名；不要将提交邮箱当远程登录密码。';
  assert.equal(reading.slice(989,1000),'- `git conf');
  const outline={intro:'先配置身份，再核对。',blocks:[{type:'reading',title:'身份配置方法',objective:'能解释提交身份并配置用户名邮箱'},{type:'example',title:'最小身份配置示例',objective:'能按照示例完成配置并核对结果'},{type:'practice',title:'独立核对配置',objective:'能独立判断当前配置是否符合要求'},{type:'quiz',title:'身份条件判断',objective:'能区分提交身份与远程登录'},{type:'summary',title:'身份配置判断规则',objective:'能提炼配置与核对的方法'}]};
  const server=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.authorization,'Bearer generation-smoke-not-real');let body='';for await(const chunk of req)body+=chunk;
      const payload=JSON.parse(body),input=JSON.parse(payload.messages[1].content);requests.push(input);
      assert.ok(!JSON.stringify(input).includes('private-note-test'));assert.equal(payload.model,'generation-smoke-model');
      let output;
      if(!input.block){assert.equal(input.minutes,15);assert.match(payload.messages[0].content,/总预算/);output=outline;}
      else if(input.block.type==='reading')output={text:reading};
      else if(input.block.type==='example'){
        const source=input.teachingContext.sources.find(s=>s.id===input.teachingContext.pairedReadingId);
        assert.equal(source.spans[0].text,reading);assert.equal(source.omitted,false);
        assert.equal(input.previous[0].excerpt,reading.slice(0,1000));
        output={text:'## 场景与输入\n\n教学示例：用户名 learner，邮箱 learner@example.test。\n\n## 核对\n\n配置后使用 git config --get user.name 核对预期值。'};
      }else if(input.block.type==='quiz'){
        assert.equal(input.teachingContext.coverage.pendingBefore,1);assert.equal(input.teachingContext.coverage.completeBefore,false);
        assert.ok(input.teachingContext.sources[0].spans[0].text.includes('不要将提交邮箱当远程登录密码'));
        assert.equal(input.questionCount,4);assert.equal(input.quizMode,'initial');
        output={questions:[{prompt:'提交身份配置是否等同远程登录？',options:['不等同','完全相同','提交邮箱就是密码','只取决于用户名'],answer:0,explanation:'提交记录的身份不是远程认证。'},{prompt:'哪个命令核对用户名？',options:['git config --get user.name','git init','git status','git log'],answer:0,explanation:'config --get 读取相应配置。'},{prompt:'哪个命令核对提交邮箱？',options:['git config --get user.email','git status','git log','git init'],answer:0,explanation:'读取user.email可核对配置。'},{prompt:'什么用于记录提交作者？',options:['user.name和user.email','远程密码','仓库目录名','分支名'],answer:0,explanation:'提交身份用于记录作者，不等同远程认证。'}]};
      }else if(input.block.type==='practice')output={text:'## 任务\n\n核对本机 Git 用户名和邮箱，不改动已有配置。\n\n## 完成标准\n\n写出当前配置，说明它是否等同远程登录。'};
      else{assert.equal(input.teachingContext.coverage.completeBefore,true);assert.deepEqual(input.teachingContext.sources.map(s=>s.type),['reading','example','practice']);output={text:'## 核心判断\n\n- 提交身份不是远程登录。\n- 配置后用读取命令核对。\n- 当前范围覆盖已经生成的讲解、案例与实践。'};}
      if(input.block?.type==='reading') await new Promise(resolve=>setTimeout(resolve,1200));
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));
    }catch{res.writeHead(500);res.end('Mock validation failed');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({provider:'compatible',model:'generation-smoke-model',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,localOnly:true,jsonMode:'on',timeoutMs:30000,maxTokens:8192,keyAction:'replace',apiKey:'generation-smoke-not-real'})})`);
    const plan={...structuredClone(demoPlan),id:`generation-${randomUUID()}`,title:'首次生成优化测试',goal:'在 Windows 中配置并核对 Git 提交身份',source:'ai',lessons:demoPlan.lessons.map((l,i)=>({...l,id:`generation-${randomUUID()}`,minutes:15,...(i===0?{title:'Git 提交身份配置与核对',objective:'能设置提交用户名邮箱并区别远程认证'}:{})}))},lessonId=plan.lessons[0].id;
    await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(plan)})`);await reload();
    await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('[data-action=generate-lesson]')");await evaluate("document.querySelector('[data-action=generate-lesson]').click()");
    await wait("document.querySelectorAll('[data-action=generate-block]').length===5");
    const detail=await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`);const blocks=detail.blockCourse.blocks;
    assert.equal(requests.length,1);assert.equal(detail.blockCourse.blocks.length,5);
    await evaluate(`document.querySelector('[data-action=generate-block][data-block="${blocks[3].id}"]').click()`);
    await wait("document.querySelector('#toast').textContent.includes('未调用模型')");assert.equal(requests.length,1);
    await evaluate(`window.learnflowDesktop.saveAnnotations(${JSON.stringify(lessonId)},[{id:'private-note',source:'intro',offset:0,quote:'',text:'private-note-test',created:Date.now()}])`);
    for(const index of [0,1,3,2,4]){
      await evaluate(`document.querySelector('[data-action=generate-block][data-block="${blocks[index].id}"]').click()`);
      if(index===0){
        await wait("document.querySelector('#generation-progress .is-running .generation-progress-message')?.textContent.includes('模型正在生成内容')");
        assert.equal(await evaluate("document.querySelector('#generation-progress [role=progressbar]').hasAttribute('aria-valuenow')"),false);
        assert.equal(await evaluate("document.querySelector('#generation-progress').matches(':popover-open')"),true);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert.equal(await evaluate("Math.round(document.querySelector('#generation-progress').getBoundingClientRect().width)"),340);
        await writeFile(path.join(directory,'..','generation-progress-smoke.png'),(await window.webContents.capturePage()).toPNG());
      }
      await wait(`!document.querySelector('[data-action=generate-block][data-block="${blocks[index].id}"]')`);
    }
    assert.equal(requests.length,6);
    const saved=await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`);
    assert.equal(saved.blockCourse.blocks[0].content.text,reading);assert.equal(saved.blockCourse.blocks[3].content.questions.length,4);assert.equal(saved.annotations[0].text,'private-note-test');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await writeFile(path.join(directory,'..','generation-smoke.png'),(await window.webContents.capturePage()).toPNG());
    await reload();await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('.teaching-reading .block-text')");assert.equal(requests.length,6);assert.equal((await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`)).blockCourse.blocks[3].content.questions.length,4);
    console.log('GENERATION_SMOKE',JSON.stringify({passed:true,requests:6,checks:['outline-time-budget','empty-quiz-no-request','paired-reading-full-source','truncated-list-code-span-context','literal-code-citation-preserved','partial-quiz-scope','summary-earlier-content','annotations-not-sent','desktop-save-and-reload'],screenshot:path.join(directory,'..','generation-smoke.png')}));
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({...original.settings,keyAction:'keep',apiKey:''})})`);
    await evaluate(`window.learnflowDesktop.setActivePlan(${JSON.stringify(original.state.active)})`);await reload();
  }
};
