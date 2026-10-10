// Synthetic data only. These identities are fictional.
const start = Date.UTC(2026,10,9);
const dates = (count=28, first=start) => Array.from({length:count},(_,i)=>new Date(first+i*86400000).toISOString().slice(0,10));
function grid(ds=dates()) {return [['Synthetic schedule 2026'],['ID','Name',...ds],['EXAMPLE001','Example Nurse 1',...ds.map((_,i)=>['A','E','N','OF'][i%4])],['EXAMPLE002','Example Nurse 2',...ds.map(()=> 'O')]];}
function metadataGrid(ds=dates()) {
 return grid(ds).map((row,i)=>i===0?row:[...row.slice(0,2),i===1?'單位':'A',
  i===1?'11月預定夜班':'N',...row.slice(2),i===1?'12月預定夜班':'E']);
}
function items(rows, offset=0) {
 return rows.flatMap((row,r)=>row.map((str,c)=>({str:String(str),width: String(str).length * 4.8,height:8,transform:[1,0,0,1,(c===0?50:c===1?150:250+(c-2)*55)-String(str).length*2.4+offset,750-r*24]})));
}
// Minimal, real PDF: fictional rows; Unicode headers use local PDF.js CMaps.
function pdf(pageRows) {
 const objects=[];
 const add=s=>{objects.push(s);return objects.length;};
 const catalog=add(''),pages=add(''),font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
 let unicodeFont=null;
 if(pageRows.flat(2).some(v=>/[^\x00-\x7F]/.test(String(v)))) {
  const cid=add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 600 >>');
  unicodeFont=add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cid} 0 R] >>`);
 }
 const kids=[];
 const esc=s=>String(s).replace(/([\\()])/g,'\\$1');
 for(const rows of pageRows) {
  const commands=rows.flatMap((row,r)=>row.map((str,c)=>{
   const unicode=/[^\x00-\x7F]/.test(String(str));
   const encoded=unicode?`<${Array.from(String(str),ch=>ch.charCodeAt(0).toString(16).padStart(4,'0')).join('')}>`:`(${esc(str)})`;
   return `BT /${unicode?'F2':'F1'} 8 Tf 1 0 0 1 ${(c===0?50:c===1?150:250+(c-2)*55)-String(str).length*2.4} ${750-r*24} Tm ${encoded} Tj ET`;
  })).join('\n');
  const stream=add(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
  const pageWidth=Math.max(1700,250+(Math.max(...rows.map(r=>r.length))-3)*55+100);
  kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${pageWidth} 800] /Resources << /Font << /F1 ${font} 0 R ${unicodeFont?`/F2 ${unicodeFont} 0 R`:''} >> >> /Contents ${stream} 0 R >>`));
 }
 objects[catalog-1]=`<< /Type /Catalog /Pages ${pages} 0 R >>`;
 objects[pages-1]=`<< /Type /Pages /Kids [${kids.map(k=>`${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
 let output='%PDF-1.4\n',offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(output);
 output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(output);
}
module.exports={dates,grid,metadataGrid,items,pdf};
