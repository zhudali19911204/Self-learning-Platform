const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const keysOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key));
export function validStudyPosition(value) {
  if (!object(value) || !keysOnly(value, ['lessonId','tab','anchor','offset','scrollTop','label','syllabusCollapsed','collapsedBlockIds','updated'])) return false;
  if (!safeId(value.lessonId) || !['read','quiz','chat'].includes(value.tab) || !object(value.anchor)) return false;
  const anchor = value.anchor;
  if (!keysOnly(anchor, ['kind','id','index','version']) || !['top','intro','block','section','example','challenge','question','chat'].includes(anchor.kind)) return false;
  if (anchor.kind === 'block' ? !safeId(anchor.id) : anchor.id !== undefined) return false;
  if (['section','question','chat'].includes(anchor.kind) ? !Number.isInteger(anchor.index) || anchor.index < 0 || anchor.index > 1000 : anchor.index !== undefined) return false;
  if (anchor.kind === 'top' ? anchor.version !== '' : typeof anchor.version !== 'string' || !/^[a-f0-9]{16}$/.test(anchor.version)) return false;
  if ((value.tab === 'quiz' && !['top','question'].includes(anchor.kind)) || (value.tab === 'chat' && !['top','chat'].includes(anchor.kind)) || (value.tab === 'read' && ['question','chat'].includes(anchor.kind))) return false;
  return Number.isFinite(value.offset) && value.offset >= 0 && value.offset <= 10000000 && Number.isFinite(value.scrollTop) && value.scrollTop >= 0 && value.scrollTop <= 10000000
    && typeof value.label === 'string' && value.label.length <= 160 && typeof value.syllabusCollapsed === 'boolean'
    && Array.isArray(value.collapsedBlockIds) && value.collapsedBlockIds.length <= 1000 && value.collapsedBlockIds.every(safeId) && new Set(value.collapsedBlockIds).size === value.collapsedBlockIds.length
    && Number.isSafeInteger(value.updated) && value.updated >= 0;
}
export function studyPositionFor(plan, positions) {
  const position = object(positions) && Object.hasOwn(positions, plan.id) ? positions[plan.id] : null;
  return validStudyPosition(position) && plan.lessons.some(lesson => lesson.id === position.lessonId) ? position : null;
}
export function validStudyPositions(positions, plans) {
  return object(positions) && Object.keys(positions).length <= plans.length && Object.entries(positions).every(([planId, position]) => {
    const plan = plans.find(plan => plan.id === planId);
    return safeId(planId) && plan && studyPositionFor(plan, {[planId]:position}) === position;
  });
}
// A deterministic layout invalidation token, not an authentication hash.
export function studyAnchorVersion(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let a = 2166136261, b = 2654435769;
  for (let i=0;i<text.length;i++) { const code=text.charCodeAt(i); a=Math.imul(a^code,16777619); b=Math.imul(b^code,2246822519); }
  return [a,b].map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
}

export function createStudyPositionTracker({document,window,getContext,onSave,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let rendered = null, anchors = [], timer = 0, restoring = false, ticket = 0, activeRestore = null, savedKey = '';
  const frame = fn => window.requestAnimationFrame ? window.requestAnimationFrame(fn) : fn();
  const current = () => {
    const context = getContext();
    return context && rendered?.lessonId === context.lessonId && rendered.tab === context.tab ? context : null;
  };
  const reader = () => document.querySelector?.('.lesson-content');
  const inset = () => (document.querySelector?.('.lesson-toolbar')?.getBoundingClientRect?.().height || 0) + 12;
  function cancelRestore() { ticket++; restoring=false; activeRestore=null; }
  function capture() {
    const context=current(), root=reader(), rect=root?.getBoundingClientRect?.();
    if (!context || restoring || !rect || (!rect.width && !rect.height)) return null;
    const line=inset(), scrollTop=Math.max(0,window.scrollY||0);
    let found=null;
    for (const anchor of anchors) {
      if (!anchor.element.isConnected) continue;
      const bounds=anchor.element.getBoundingClientRect();
      if (bounds.height>0 && bounds.top<=line+1) found={anchor,bounds};
      if (bounds.top>line) break;
    }
    const position={lessonId:context.lessonId,tab:context.tab,anchor:found?{...found.anchor.key}:{kind:'top',version:''},
      offset:found?Math.max(0,Math.min(line-found.bounds.top,found.bounds.height-1)):0,scrollTop,
      label:found?found.anchor.label:({read:'课程概览',quiz:'随堂练习',chat:'AI 答疑'}[context.tab]),
      syllabusCollapsed:!!context.syllabusCollapsed,collapsedBlockIds:[...(context.collapsedBlockIds||[])],updated:Date.now()};
    return validStudyPosition(position)?position:null;
  }
  function save(sync=false) {
    clearTimer(timer); timer=0;
    const position=capture(), context=current(); if (!position || !context) return;
    const key=JSON.stringify([context.planId,{...position,updated:0}]);
    if (!sync && savedKey===key) return;
    savedKey=key; return onSave(context.planId,position,sync);
  }
  function schedule() { clearTimer(timer); if (!restoring && current()) timer=setTimer(()=>save(),400); }
  function markRendered() {
    cancelRestore(); anchors=[];
    const context=getContext();
    if(!context||context.lessonId!==rendered?.lessonId||context.tab!==rendered?.tab)savedKey='';
    rendered=context?{lessonId:context.lessonId,tab:context.tab}:null;
    const root=reader(); if (!context || !root?.querySelectorAll) return;
    const add=(element,key,label,content)=>{if(element) anchors.push({element,key:{...key,version:studyAnchorVersion(content)},label:String(label).slice(0,160)});};
    if (context.tab==='read') {
      add(root.querySelector('.lesson-intro'),{kind:'intro'},'课程导读',context.course?.intro||context.lesson?.intro||'');
      if (context.course) {
        for (const element of root.querySelectorAll('[data-block-id]')) {
          const block=context.course.blocks.find(block=>block.id===element.dataset.blockId);
          if (block) add(element,{kind:'block',id:block.id},block.title,block.content?.text??block.content?.questions??null);
        }
      } else {
        [...root.querySelectorAll('.reading-section')].forEach((element,index)=>add(element,{kind:'section',index},context.lesson?.sections[index]?.heading||'知识讲解',context.lesson?.sections[index]||null));
        add(root.querySelector('.code-block'),{kind:'example'},'具体示例',context.lesson?.example||'');
        add(root.querySelector('.challenge'),{kind:'challenge'},'动手试一试',context.lesson?.challenge||'');
      }
    } else if (context.tab==='quiz') {
      [...root.querySelectorAll('.question')].forEach((element,index)=>add(element,{kind:'question',index},`随堂练习 · 第 ${index+1} 题`,context.lesson?.questions[index]||null));
    } else {
      [...root.querySelectorAll('.chat-message')].forEach((element,index)=>add(element,{kind:'chat',index},'AI 答疑',context.chats?.[index]||null));
    }
    for (const image of root.querySelectorAll('img')) image.addEventListener('load',()=>{
      if (activeRestore && current()) apply(activeRestore.position,activeRestore.ticket);
    },{once:true});
  }
  function apply(position, expected) {
    if (expected!==ticket || !current() || current().lessonId!==position.lessonId || current().tab!==position.tab) return false;
    const root=reader(); if (!root?.getBoundingClientRect) return false;
    let anchor=anchors.find(item=>item.key.kind===position.anchor.kind && (item.key.id??null)===(position.anchor.id??null) && (item.key.index??null)===(position.anchor.index??null));
    if(['section','question','chat'].includes(position.anchor.kind)&&anchor?.key.version!==position.anchor.version) anchor=anchors.find(item=>item.key.kind===position.anchor.kind&&item.key.version===position.anchor.version);
    if (!anchor && position.anchor.kind==='block') {
      const source=current().course?.blocks.find(block=>block.id===position.anchor.id);
      if (source?.type==='quiz' && source.title.startsWith('补充练习 · 第')) anchor=anchors.find(item=>item.key.kind==='block' && current().course.blocks.find(block=>block.id===item.key.id)?.type==='quiz');
    }
    let top;
    if (position.anchor.kind==='top') top=Math.min(position.scrollTop,Math.max(0,root.getBoundingClientRect().top+(window.scrollY||0)));
    else if (anchor) {
      const rect=anchor.element.getBoundingClientRect();
      const offset=anchor.key.version===position.anchor.version?Math.min(position.offset,Math.max(0,rect.height-32)):0;
      top=rect.top+(window.scrollY||0)+offset-inset();
    } else top=root.getBoundingClientRect().top+(window.scrollY||0)-16;
    restoring=true;
    window.scrollTo({top:Math.max(0,top),behavior:'auto'});
    frame(()=>{if(expected===ticket) restoring=false;});
    return true;
  }
  function restore(position) {
    if (!validStudyPosition(position)) return Promise.resolve(false);
    clearTimer(timer); const expected=++ticket; restoring=true; activeRestore={position,ticket:expected};
    return new Promise(resolve=>frame(()=>frame(()=>{
      const applied=apply(position,expected); if(!applied && expected===ticket) restoring=false;
      frame(()=>resolve(applied));
    })));
  }
  const onGesture=()=>{cancelRestore();schedule();};
  const onKey=event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) onGesture();};
  const onHidden=()=>{if(document.hidden) save();};
  const onUnload=()=>save(true);
  window.addEventListener?.('scroll',schedule,{passive:true});
  window.addEventListener?.('wheel',onGesture,{passive:true});
  window.addEventListener?.('touchstart',onGesture,{passive:true});
  window.addEventListener?.('pointerdown',onGesture,{passive:true});
  window.addEventListener?.('keydown',onKey);
  window.addEventListener?.('beforeunload',onUnload);
  window.addEventListener?.('pagehide',onUnload);
  document.addEventListener?.('visibilitychange',onHidden);
  return {capture,save,schedule,rendered:markRendered,restore,cancelRestore,dispose(){
    clearTimer(timer); cancelRestore();
    for(const [event,handler] of [['scroll',schedule],['wheel',onGesture],['touchstart',onGesture],['pointerdown',onGesture],['keydown',onKey],['beforeunload',onUnload],['pagehide',onUnload]]) window.removeEventListener?.(event,handler);
    document.removeEventListener?.('visibilitychange',onHidden);
  }};
}
