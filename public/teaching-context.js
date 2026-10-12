// Generation-only context: never persisted into course text or learning backups.
export const teachingContextLimits = Object.freeze({ sources: 24, catalog: 80, characters: 36000, sourceCharacters: 12000 });
const safeId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v) && !['__proto__','constructor','prototype'].includes(v);
const types = ['reading','example','practice','quiz','summary'];
const teachingTypes = ['reading','example','practice'];
const str = (v,max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const terms = text => [...new Set((text.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) || []).flatMap(s => /[\p{Script=Han}]/u.test(s) ? Array.from({length:Math.min(s.length-1,160)},(_,i)=>s.slice(i,i+2)) : [s]))];
const relevance = (text,tokens) => {const lower=text.toLowerCase();return tokens.reduce((n,t)=>n+(lower.includes(t)?1:0),0);};
function excerpts(text,quota,tokens) {
  if (text.length <= quota) return [{start:0,end:text.length,text}];
  const chunk = Math.max(1,Math.floor(quota/3)), candidates = [];
  const pattern = /[^\n]+(?:\n|$)/g; let match;
  while ((match=pattern.exec(text))) candidates.push({start:match.index,score:relevance(match[0],tokens)});
  candidates.sort((a,b)=>b.score-a.score || a.start-b.start);
  const center = Math.min(text.length-chunk, candidates[0]?.score ? candidates[0].start : Math.floor(text.length/2));
  const ranges = [{start:0,end:chunk},{start:center,end:center+chunk},{start:text.length-(quota-chunk*2),end:text.length}].sort((a,b)=>a.start-b.start);
  const merged=[];
  for(const range of ranges) {const last=merged.at(-1);if(last && range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  return merged.map(({start,end})=>({start,end,text:text.slice(start,end)}));
}
export function buildTeachingContext(course,targetId) {
  const position=course.blocks.findIndex(b=>b.id===targetId);if(position<0)return null;
  const target=course.blocks[position], all=course.blocks.map((b,i)=>({...b,position:i+1}));
  const before=all.slice(0,position).filter(b=>teachingTypes.includes(b.type));
  let paired=null;
  if(target.type==='example') {let i=position-1;while(i>=0 && all[i].type==='example')i--;if(all[i]?.type==='reading')paired=all[i];}
  const eligible=before.filter(b=>b.content?.text);
  if(target.type==='reading')for(let i=position+1;all[i]?.type==='example' && i<=position+2;i++)if(all[i].content?.text)eligible.push(all[i]);
  const tokens=terms(`${target.title} ${target.objective}`);
  let ordered;
  if(['quiz','summary'].includes(target.type)) {const scores=new Map(eligible.map(b=>[b.id,relevance(`${b.title} ${b.objective} ${b.content.text}`,tokens)]));ordered=[...eligible].sort((a,b)=>scores.get(b.id)-scores.get(a.id)||a.position-b.position);}
  else ordered=[...eligible].sort((a,b)=>(b.id===paired?.id?1:0)-(a.id===paired?.id?1:0)||b.position-a.position);
  // Include the earliest and latest teaching context even in unusually large lessons.
  if(['quiz','summary'].includes(target.type) && ordered.length>teachingContextLimits.sources){const priority=[eligible[0],eligible.at(-1),eligible.find(b=>['reading','example'].includes(b.type))].filter(Boolean);const first=[...new Map(priority.map(b=>[b.id,b])).values()];ordered=[...first,...ordered.filter(b=>!first.some(p=>p.id===b.id))];}
  const selected=ordered.slice(0,teachingContextLimits.sources), quotas=new Map();let remaining=teachingContextLimits.characters;
  if(paired?.content?.text && selected.some(b=>b.id===paired.id)){const amount=Math.min(paired.content.text.length,teachingContextLimits.sourceCharacters);quotas.set(paired.id,amount);remaining-=amount;}
  const pending=selected.filter(b=>!quotas.has(b.id));
  for(const b of [...pending].sort((a,b)=>a.content.text.length-b.content.text.length)){const count=pending.filter(b=>!quotas.has(b.id)).length,amount=Math.min(b.content.text.length,Math.floor(remaining/count));quotas.set(b.id,amount);remaining-=amount;}
  const sources=selected.map(b=>({id:b.id,type:b.type,title:b.title,objective:b.objective,position:b.position,textLength:b.content.text.length,spans:excerpts(b.content.text,quotas.get(b.id),tokens)})).map(s=>({...s,includedCharacters:s.spans.reduce((n,p)=>n+p.text.length,0),omitted:s.spans.reduce((n,p)=>n+p.text.length,0)<s.textLength})).sort((a,b)=>a.position-b.position);
  const priority=new Set([targetId,...sources.map(s=>s.id),...(paired?[paired.id]:[])]);
  const chosen=[...all.filter(b=>priority.has(b.id)),...all.filter(b=>!priority.has(b.id))].slice(0,teachingContextLimits.catalog).sort((a,b)=>a.position-b.position);
  const catalog=chosen.map(b=>({id:b.id,type:b.type,title:b.title,objective:b.objective.slice(0,320),position:b.position,generated:!!b.content}));
  const ready=before.filter(b=>b.content?.text).length, includedBefore=sources.filter(s=>s.position<position+1);
  return {version:1,targetId,targetType:target.type,targetPosition:position+1,totalBlocks:all.length,pairedReadingId:paired?.id || null,catalog,sources,coverage:{teachingBefore:before.length,generatedBefore:ready,includedBefore:includedBefore.length,omittedBefore:ready-includedBefore.length,pendingBefore:before.length-ready,catalogOmitted:all.length-catalog.length,excerpted:sources.some(s=>s.omitted),completeBefore:ready===before.length && includedBefore.length===ready && !includedBefore.some(s=>s.omitted)}};
}
export function validTeachingContext(v) {
  if(!v || v.version!==1 || !safeId(v.targetId) || !types.includes(v.targetType) || !Number.isInteger(v.totalBlocks) || v.totalBlocks<1 || v.totalBlocks>1000 || !Number.isInteger(v.targetPosition) || v.targetPosition<1 || v.targetPosition>v.totalBlocks || (v.pairedReadingId!==null && !safeId(v.pairedReadingId)))return false;
  if(!Array.isArray(v.catalog) || !v.catalog.length || v.catalog.length>teachingContextLimits.catalog || new Set(v.catalog.map(c=>c?.id)).size!==v.catalog.length || new Set(v.catalog.map(c=>c?.position)).size!==v.catalog.length || !v.catalog.every(c=>c && safeId(c.id) && types.includes(c.type) && str(c.title,160) && str(c.objective,320) && Number.isInteger(c.position) && c.position>=1 && c.position<=v.totalBlocks && typeof c.generated==='boolean'))return false;
  const target=v.catalog.find(c=>c.id===v.targetId);if(!target || target.type!==v.targetType || target.position!==v.targetPosition)return false;
  if(v.pairedReadingId && !v.catalog.some(c=>c.id===v.pairedReadingId && c.type==='reading' && c.position<v.targetPosition))return false;
  if(!Array.isArray(v.sources) || v.sources.length>teachingContextLimits.sources || new Set(v.sources.map(s=>s?.id)).size!==v.sources.length || !v.sources.every(s=>{
    const c=v.catalog.find(c=>c.id===s?.id);
    return c && c.generated && c.type===s.type && c.title===s.title && str(s.objective,1000) && c.objective===s.objective.slice(0,320) && c.position===s.position && s.id!==v.targetId && teachingTypes.includes(s.type) && Number.isInteger(s.textLength) && s.textLength>0 && s.textLength<=12000 && Array.isArray(s.spans) && s.spans.length>=1 && s.spans.length<=3 && s.spans.every((p,i)=>p && Number.isInteger(p.start) && Number.isInteger(p.end) && p.start>=0 && p.end>p.start && p.end<=s.textLength && typeof p.text==='string' && p.text.length===p.end-p.start && (i===0 || p.start>=s.spans[i-1].end)) && s.includedCharacters===s.spans.reduce((n,p)=>n+p.text.length,0) && s.omitted===(s.includedCharacters<s.textLength)
      && (s.position<v.targetPosition || (v.targetType==='reading' && s.type==='example' && s.position<=v.targetPosition+2));
  }) || v.sources.reduce((n,s)=>n+s.includedCharacters,0)>teachingContextLimits.characters)return false;
  const c=v.coverage;
  if(c && c.catalogOmitted===0){const prior=v.catalog.filter(b=>b.position<v.targetPosition && teachingTypes.includes(b.type));if(c.teachingBefore!==prior.length || c.generatedBefore!==prior.filter(b=>b.generated).length)return false;}
  return !!c && ['teachingBefore','generatedBefore','includedBefore','omittedBefore','pendingBefore','catalogOmitted'].every(k=>Number.isInteger(c[k]) && c[k]>=0 && c[k]<=1000)
    && c.teachingBefore<=v.targetPosition-1 && c.generatedBefore<=c.teachingBefore && c.includedBefore===v.sources.filter(s=>s.position<v.targetPosition).length && c.omittedBefore===c.generatedBefore-c.includedBefore && c.pendingBefore===c.teachingBefore-c.generatedBefore && c.catalogOmitted===v.totalBlocks-v.catalog.length && c.excerpted===v.sources.some(s=>s.omitted)
    && c.completeBefore===(c.generatedBefore===c.teachingBefore && c.includedBefore===c.generatedBefore && !v.sources.filter(s=>s.position<v.targetPosition).some(s=>s.omitted));
}
export function cleanTeachingContext(v) {
  return {version:v.version,targetId:v.targetId,targetType:v.targetType,targetPosition:v.targetPosition,totalBlocks:v.totalBlocks,pairedReadingId:v.pairedReadingId,catalog:v.catalog.map(({id,type,title,objective,position,generated})=>({id,type,title,objective,position,generated})),sources:v.sources.map(({id,type,title,objective,position,textLength,includedCharacters,omitted,spans})=>({id,type,title,objective,position,textLength,includedCharacters,omitted,spans:spans.map(({start,end,text})=>({start,end,text}))})),coverage:Object.fromEntries(['teachingBefore','generatedBefore','includedBefore','omittedBefore','pendingBefore','catalogOmitted','excerpted','completeBefore'].map(k=>[k,v.coverage[k]]))};
}
export function teachingContextNotice(course,targetId) {
  const index=course.blocks.findIndex(b=>b.id===targetId);if(index<0)return '';
  const target=course.blocks[index],prior=course.blocks.slice(0,index).filter(b=>teachingTypes.includes(b.type)),ready=prior.filter(b=>b.content?.text);
  if(['quiz','summary'].includes(target.type))return !ready.some(b=>['reading','example'].includes(b.type)) ? '请先生成前序讲解或案例，再生成测验或总结，不会自动生成其他模块。' : ready.length<prior.length ? `当前仅 ${ready.length}/${prior.length} 个前序教学模块已生成，本次只覆盖已提供内容；生成更多讲解后可补充测验或总结。` : '本次以已生成的前序正文为依据；材料过长时按目标选取片段，不宣称全面覆盖。';
  if(target.type==='example'){let i=index-1;while(i>=0&&course.blocks[i].type==='example')i--;if(course.blocks[i]?.type==='reading'&&!course.blocks[i].content)return '配套讲解尚未生成；建议先生成讲解。现在生成案例将说明必要前提，不假定已有讲解。';}
  return '';
}
