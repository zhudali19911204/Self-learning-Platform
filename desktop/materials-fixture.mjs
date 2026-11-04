export function materialsFixture() {
 const counts={generations:0,searches:0,largestCatalog:0,largestDocumentCount:0,sentCharacters:0};
 const llm={status:()=>({mode:'ai',model:'local-material-fixture',providerLabel:'隔离测试',timeoutMs:1000}),generate:async(prompt,input,validate)=>{
  counts.generations++;
  counts.largestCatalog=Math.max(counts.largestCatalog,input.learningMaterialCatalog?.length||0);
  const docs=input.officialDocuments||input.learningMaterials||[];
  counts.largestDocumentCount=Math.max(counts.largestDocumentCount,docs.length);
  counts.sentCharacters=Math.max(counts.sentCharacters,docs.reduce((n,d)=>n+d.excerpts.reduce((a,e)=>a+e.text.length,0),0));
  let value;
  if(input.block) value=input.block.type==='quiz'?{questions:Array.from({length:4},(_,i)=>({prompt:`核对文件的第 ${i+1} 个问题`,options:['核对文件','不核对','删除文件','只看图标'],answer:0,explanation:'应重新打开并核对文件。'}))}:{text:`## 保存与核对\n\n保存后应重新打开并核对文件。[${input.officialDocuments[0].excerpts[0].id}]\n\n教学示例：新建一个练习文档，保存并重新打开检查。`};
  else if(input.route) value={intro:'根据导入的文件操作资料，练习保存与核对。',blocks:[{type:'reading',title:'保存与核对',objective:'理解保存后核对文件的步骤'},{type:'example',title:'保存练习文档的示例',objective:'观察保存并重新打开的操作'},{type:'quiz',title:'保存步骤小测',objective:'检验保存步骤理解'}]};
  else if(input.learningBrief) value={title:'导入资料课程测试',description:'根据提供的操作资料学习文件保存与核对。',lessons:['保存文件','命名文件','重新打开核对'].map(title=>({title,objective:`学会${title}并说明完成标准`,phase:'文件操作',minutes:20,tags:['文件']}))};
  else if(input.assessment) value={summary:'学习文件保存与核对',questions:input.assessment.gaps.map((gap,i)=>({question:`${gap.dimension}如何选择？`,why:gap.reason,type:'single',options:[{label:`使用练习文档 ${i+1}`,description:'按资料练习'},{label:`使用现有文档 ${i+1}`,description:'核对保存结果'}]}))};
  else value={scope:'focused',known:['需要学习文件操作'],gaps:[{dimension:'练习文件',reason:'决定实践素材'},{dimension:'验收结果',reason:'决定完成标准'}]};
  if(!validate(value)) throw Error('Material smoke fixture rejected');
  return value;
 }};
 return {llm,counts,courseSources:{prepare:async()=>{counts.searches++;throw Error('Imported materials must never search the web');}}};
}
