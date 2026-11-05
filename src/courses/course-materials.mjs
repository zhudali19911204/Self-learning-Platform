import { validMaterials, materialGuidance, MATERIAL_CONTEXT_LIMITS, localMaterialSource } from '../../public/materials.js';
import { blockGenerationContext, validBlockCourse } from '../../public/blocks.js';
import { validGrounding } from '../../public/course-sources.js';
export { materialGuidance };
const fail = message => { throw Object.assign(new Error(message),{status:422}); };
export function checkedMaterials(value) {
  if (!validMaterials(value)) fail('导入资料格式无效、已失效或超过上限，请重新导入。');
  return value;
}
const stopWords=new Set(['学习','理解','掌握','课程','教学','内容','能够','完成','说明','介绍','如何']);

// Dependent teaching blocks must not lose the original evidence already used
// by their saved readings/cases just because the task and file use different
// languages. Client-supplied context/URLs cannot donate preferred sources.
export function materialContextParts(materials, requested, savedCourse = null) {
  if (!['example','practice','summary'].includes(requested.block?.type) || !validBlockCourse(savedCourse)) return [];
  const target = savedCourse.blocks.find(b => b.id === requested.teachingContext?.targetId);
  if (!target || target.type !== requested.block.type || target.title !== requested.block.title || target.objective !== requested.block.objective) return [];
  const context = blockGenerationContext(savedCourse, target.id).teachingContext;
  const available = new Map(materials.map(m => [m.id, m])), selected = new Map();
  const sources = [...context.sources].sort((a,b) => (b.id===context.pairedReadingId?1:0)-(a.id===context.pairedReadingId?1:0) || b.position-a.position);
  for (const source of sources) {
    if (!['reading','example'].includes(source.type)) continue;
    const block = savedCourse.blocks.find(b => b.id === source.id);
    if (!validGrounding(block?.content?.grounding)) continue;
    for (const citation of block.content.grounding.citations) {
      if (!source.spans.some(span => span.text.includes(citation.claim))) continue;
      const local = localMaterialSource(citation.url), material = local && available.get(local.materialId);
      const part = material?.parts.find(p => p.id === citation.partId);
      if (!part || !part.text.includes(citation.quote)) continue;
      const key = `${material.id}:${part.id}`;
      if (!selected.has(key)) selected.set(key, { materialId: material.id, partId: part.id });
    }
  }
  return [...selected.values()];
}
function tokens(value) {
  return [...new Set((String(value).normalize('NFKC').toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g)||[])
    .flatMap(w=>/^[\u3400-\u9fff]+$/.test(w)?Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)):[w]).filter(t=>!stopWords.has(t)))];
}
// A bounded navigation index for planning across the whole library. These are
// literal samples, not AI summaries or a claim that the full files were read.
export function materialCatalog(materials) {
  checkedMaterials(materials);
  return materials.map(m=>({name:m.name,totalParts:m.parts.length,
    samples:[...new Set([0,Math.floor(m.parts.length/2),m.parts.length-1])].map(i=>({location:m.parts[i].location,text:m.parts[i].text.slice(0,80)})),
    scope:'目录与短原文样本，非全文；正文生成时须检索对应原文'}));
}
// Rank passages across the entire library. Library size never increases the
// source-ID range or per-request text budget. Keep exact original positions.
export function materialDocuments(materials, query, { planning=false, preferredParts=[] }={}) {
  checkedMaterials(materials);
  if(!materials.length) return [];
  const terms=tokens(String(query).slice(0,4000)).slice(0,256),wanted=new Set(terms),frequency=new Map(terms.map(t=>[t,0]));
  const preferred = new Map((Array.isArray(preferredParts)?preferredParts:[]).map((p,i)=>[`${p?.materialId}:${p?.partId}`,i]));
  const candidates=materials.map((m,index)=>({m,index,titleTerms:new Set(tokens(m.name)),parts:m.parts.map((part,index)=>{
    const matched=tokens(part.text).filter(t=>wanted.has(t));
    matched.forEach(t=>frequency.set(t,frequency.get(t)+1));
    return {part,index,matched,score:0,priority:preferred.get(`${m.id}:${part.id}`)??Infinity};
  })}));
  const count=candidates.reduce((n,c)=>n+c.parts.length,0);
  const weight=t=>Math.log(1+(count-(frequency.get(t)||0)+.5)/((frequency.get(t)||0)+.5));
  for(const c of candidates) {
    const titleScore=terms.reduce((n,t)=>n+(c.titleTerms.has(t)?weight(t)*2:0),0);
    c.parts.forEach(p=>p.score=p.matched.reduce((n,t)=>n+weight(t),0));
    c.parts.sort((a,b)=>b.score-a.score||a.index-b.index);
    c.score=titleScore+(c.parts[0]?.score||0)+.2*(c.parts[1]?.score||0);
    c.priority=Math.min(...c.parts.map(p=>p.priority));
  }
  let selected=candidates.filter(c=>c.score>0||Number.isFinite(c.priority)).sort((a,b)=>a.priority-b.priority||b.score-a.score||a.index-b.index).slice(0,MATERIAL_CONTEXT_LIMITS.documents);
  const fallback=selected.length===0;
  if(fallback) selected=[...new Set([0,Math.floor(candidates.length/2),candidates.length-1])].map(i=>candidates[i]);
  const queues=selected.map(c=>{
    const pinned=c.parts.filter(p=>Number.isFinite(p.priority)).sort((a,b)=>a.priority-b.priority);
    const neighbors=pinned.flatMap(p=>[-1,1].map(delta=>c.parts.find(n=>n.index===p.index+delta)).filter(Boolean));
    const seeds=planning?[...new Set([0,Math.floor(c.m.parts.length/2),c.m.parts.length-1])].map(index=>c.parts.find(p=>p.index===index)):[];
    // With no lexical match, the first eight chunks are not a reliable view of
    // a long or foreign-language file. Sample head/middle/tail neighborhoods.
    const spread=[];
    if(fallback&&!planning)for(let distance=0;distance<c.parts.length&&spread.length<MATERIAL_CONTEXT_LIMITS.excerpts;distance++)for(const index of [distance,Math.floor(c.parts.length/2)+distance,c.parts.length-1-distance]){
      const part=c.parts.find(p=>p.index===index);if(part&&!spread.includes(part))spread.push(part);
    }
    return [...new Set([...pinned,...neighbors,...seeds,...spread,...c.parts])].slice(0,MATERIAL_CONTEXT_LIMITS.excerpts);
  });
  const excerpts=selected.map(()=>[]);let used=0;
  for(let round=0;round<MATERIAL_CONTEXT_LIMITS.excerpts;round++) for(let i=0;i<queues.length;i++) {
    const p=queues[i][round];
    if(!p || used+p.part.text.length>MATERIAL_CONTEXT_LIMITS.characters) continue;
    excerpts[i].push(p);used+=p.part.text.length;
  }
  return selected.map((c,i)=>({c,parts:excerpts[i]})).filter(v=>v.parts.length).map(({c,parts},i)=>({
    id:`S${i+1}`,url:`learnflow-material:${c.m.id}`,title:c.m.name,publisher:'用户导入资料',retrievedAt:c.m.importedAt,totalParts:c.m.parts.length,
    selection:Number.isFinite(c.priority)?'优先提供已讲正文引用的原文与相邻片段，不代表全文覆盖':fallback?'未命中关键词，提供代表片段供判断，不代表全文覆盖':'从全部资料按当前目标检索的部分原文，不代表全文覆盖',
    excerpts:parts.sort((a,b)=>a.index-b.index).map(({part},j)=>({id:`S${i+1}E${j+1}`,text:part.text,partId:part.id,location:part.location}))
  }));
}
export const localSourceGuidance = `${materialGuidance} officialDocuments 是本次真正提供的本地资料片段。仅使用其中的 excerpt ID，在主要知识性句段末尾标注 [S1E1] 等引用；不要单独写链接、参考列表、citations、claim 或 quote，程序会关联真实文件和位置。引用前的句段应完整、简短，不将标记放入代码或链接。资料不足以支撑当前模块时返回 {"sourceInsufficient":true}，不能借用原文未提供的知识。随堂练习只检验已讲内容，解析仅在实际使用资料时标注。`;
