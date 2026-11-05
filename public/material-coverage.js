import { materialId, materialPartId } from './materials.js';
const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
const unitId=v=>typeof v==='string'&&/^U[1-9]\d{0,4}$/.test(v);
export const materialPartRequiresTeaching=source=>/(?:^|\n)\s*(?:#{1,6}\s+\S|\d+(?:\.\d+)+\s+\S|[+=−-]\s*\d)|\b(?:must|shall|unless|except|required)\b|必须|不得|公式|计算规则/im.test(source);
export function validMaterialCoverage(value, materials, lessonCount) {
  if(!value||value.version!==1||value.complete!==true||!Number.isInteger(lessonCount)||lessonCount<1||lessonCount>12||!Array.isArray(materials)||!materials.length||!Array.isArray(value.units)||!value.units.length||value.units.length>20000)return false;
  const files=new Map(materials.map(m=>[m.id,m])),seen=new Set(),ids=new Set();
  for(const unit of value.units){
    if(!unit||!unitId(unit.id)||ids.has(unit.id)||!materialId(unit.materialId)||!text(unit.title,160)||!Array.isArray(unit.partIds)||!unit.partIds.length||!Array.isArray(unit.lessons)||new Set(unit.lessons).size!==unit.lessons.length||unit.lessons.some(i=>!Number.isInteger(i)||i<1||i>lessonCount))return false;
    if(unit.lessons.length===0&&!text(unit.referenceReason,400))return false;
    if(unit.lessons.length>0&&unit.referenceReason!==undefined)return false;
    const file=files.get(unit.materialId);if(!file)return false;
    for(const part of unit.partIds){const key=unit.materialId+':'+part,p=file.parts.find(p=>p.id===part);if(!materialPartId(part)||seen.has(key)||!p||(!unit.lessons.length&&materialPartRequiresTeaching(p.text)))return false;seen.add(key);}
    ids.add(unit.id);
  }
  return seen.size===materials.reduce((n,m)=>n+m.parts.length,0);
}
export function materialCoverageParts(plan, lessonId) {
  const index=plan?.lessons?.findIndex(l=>l.id===lessonId);
  if(!Number.isInteger(index)||index<0||!validMaterialCoverage(plan?.materialCoverage,plan?.materials,plan.lessons.length))return [];
  return plan.materialCoverage.units.filter(u=>u.lessons.includes(index+1)).flatMap(u=>u.partIds.map(partId=>({materialId:u.materialId,partId})));
}
