import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),JSZip=createRequire(require.resolve('mammoth'))('jszip');
export async function wordFixture(text='每次保存文件后，应重新打开并核对文件名、保存位置与内容是否正确。') {
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map(p=>`<w:p><w:r><w:t>${p.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export function pdfFixture(pages=['Save the file and reopen it to check the content.','Check both the file name and the destination folder.']) {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for(let i=0;i<pages.length;i++) {
  const content=pages[i]?`BT /F1 12 Tf 50 750 Td (${pages[i].replace(/[()\\]/g,'\\$&')}) Tj ET`:'';
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
 }
 let output='%PDF-1.4\n',offsets=[0];
 objects.forEach((body,i)=>{offsets.push(output.length);output+=`${i+1} 0 obj\n${body}\nendobj\n`;});
 const start=output.length;
 output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 return Buffer.from(output);
}
