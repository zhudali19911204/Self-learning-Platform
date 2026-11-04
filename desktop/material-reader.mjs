import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import { MATERIAL_LIMITS, validMaterial } from '../public/materials.js';
const reject = message => { throw new Error(message); };
function checkZip(bytes) {
  // Inspect the central directory before any decompression (including images).
  let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--) if(bytes.readUInt32LE(p)===0x06054b50){end=p;break;}
  if(end<0) reject('Word 文件不是有效的 DOCX 压缩文档。');
  const entries=bytes.readUInt16LE(end+10); let offset=bytes.readUInt32LE(end+16),size=0,document=false;
  if(entries>2000 || entries===65535 || offset>=end) reject('Word 文件结构过大或不支持，请拆分后导入。');
  for(let i=0;i<entries;i++) {
    if(offset+46>end || bytes.readUInt32LE(offset)!==0x02014b50) reject('Word 文件结构损坏。');
    const flags=bytes.readUInt16LE(offset+8),unpacked=bytes.readUInt32LE(offset+24),length=bytes.readUInt16LE(offset+28);
    size+=unpacked;
    if(flags&1 || size>40*1024*1024 || unpacked===0xffffffff) reject('Word 文件加密或解压内容过大，请另存为较小的 DOCX。');
    const name=bytes.subarray(offset+46,offset+46+length).toString('utf8');
    if(name==='word/document.xml') document=true;
    offset+=46+length+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
  }
  if(!document) reject('未找到 Word 正文，请选择 DOCX 文件。');
}
async function extract(buffer,name) {
  const type=extname(name).slice(1).toLowerCase(),parts=[]; let characters=0;
  if(!['pdf','docx','md','txt'].includes(type)) reject('支持 PDF、Word（.docx）、Markdown（.md）和 UTF-8 文本；旧版 .doc 请先另存为 .docx。');
  if(!buffer.length || buffer.length>MATERIAL_LIMITS.bytes) reject('每份资料须大于 0 字节且不超过 10 MB。');
  const add=(value,location)=> {
    const cleaned=value.replace(/\x00/g,'').trim();
    for(let start=0;start<cleaned.length;start+=1100) {
      const text=cleaned.slice(start,start+1100); characters+=text.length;
      if(characters>MATERIAL_LIMITS.characters || parts.length>=MATERIAL_LIMITS.parts) reject('资料文字过多，请按章节拆分后导入。');
      if(text.trim()) parts.push({id:`part-${parts.length+1}`,location,text});
    }
  };
  let unreadable=0;
  if(type==='pdf') {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,isOffscreenCanvasSupported:false,verbosity:0});
    try {
      const pdf=await task.promise;
      if(pdf.numPages>MATERIAL_LIMITS.pages) reject('PDF 超过 200 页，请按章节拆分后导入。');
      for(let page=1;page<=pdf.numPages;page++) {
        const p=await pdf.getPage(page),content=await p.getTextContent();
        const text=content.items.map(item=>typeof item.str==='string'?item.str+(item.hasEOL?'\n':' '):'').join('');
        if(!text.trim()) unreadable++;
        add(text,`第 ${page} 页`);p.cleanup();
      }
    } catch(error) {
      if(error?.name==='PasswordException') reject('PDF 已加密，请解密后再导入。');
      if(/PDF 超过|资料文字过多/.test(error.message)) throw error;
      reject('PDF 无法解析，请检查文件是否损坏或加密。');
    } finally {await task.destroy();}
  } else if(type==='docx') {
    checkZip(buffer);
    const mammoth=await import('mammoth');
    let result;
    try {result=await mammoth.extractRawText({buffer});} catch {reject('Word 正文无法解析，请检查文件是否损坏，或另存为新的 DOCX 后导入。');}
    result.value.split(/\n\s*\n/).forEach((paragraph,i)=>add(paragraph,`第 ${i+1} 段`));
  } else {
    let source;
    try {source=new TextDecoder('utf-8',{fatal:true}).decode(buffer);} catch {reject('文本编码不支持，请另存为 UTF-8 后导入。');}
    const lines=source.replace(/\r\n?/g,'\n').split('\n'); let chunk=[],start=1,length=0;
    const flush=end=>{if(chunk.length)add(chunk.join('\n'),start===end?`第 ${start} 行`:`第 ${start}–${end} 行`);chunk=[];length=0;};
    lines.forEach((line,i)=>{if(length+line.length+1>1100&&chunk.length){flush(i);start=i+1;}if(!chunk.length)start=i+1;chunk.push(line);length+=line.length+1;});flush(lines.length);
  }
  if(characters<20) reject(type==='pdf'?'PDF 没有足够的可提取文字，可能是扫描图片；请先进行 OCR 文字识别，再导入。':'资料可读文字不足，请检查文件内容。');
  const material={version:1,id:createHash('sha256').update(buffer).digest('hex'),name:basename(name).replace(/[\\/\x00-\x1f]/g,'_').slice(0,160),type,bytes:buffer.length,importedAt:Date.now(),parts,
    ...(unreadable?{warning:`${unreadable} 页未提取到文字，图片内容未识别，请核对资料预览。`}:{})};
  if(!validMaterial(material)) reject('资料提取结果不符合存储要求。');
  return material;
}
export function readMaterialBuffer(buffer,name,{timeoutMs=30000}={}) {
  if(!Buffer.isBuffer(buffer)||buffer.length>MATERIAL_LIMITS.bytes) return Promise.reject(new Error('每份资料不得超过 10 MB。'));
  return new Promise((resolve,reject)=> {
    const worker=new Worker(new URL(import.meta.url),{workerData:{bytes:new Uint8Array(buffer),name},resourceLimits:{maxOldGenerationSizeMb:256},execArgv:[]});
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('资料解析超过 30 秒，请拆分文件后重试。'));},timeoutMs);
    const done=()=>clearTimeout(timer);
    worker.once('message',result=>{done();result.error?reject(new Error(result.error)):resolve(result.material);});
    worker.once('error',()=>{done();reject(new Error('资料解析失败或内存超限，请检查文件或拆分后重试。'));});
    worker.once('exit',()=>{done();reject(new Error('资料解析未完成，请拆分后重试。'));});
  });
}
if(!isMainThread) {
  try {parentPort.postMessage({material:await extract(Buffer.from(workerData.bytes),workerData.name)});}
  catch(error) {parentPort.postMessage({error:error.message});}
}
