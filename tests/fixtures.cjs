// Synthetic data only. These identities are fictional.
const start = Date.UTC(2026,10,9);
const dates = (count=28, first=start) => Array.from({length:count},(_,i)=>new Date(first+i*86400000).toISOString().slice(0,10));
function grid(ds=dates()) {return [['Synthetic schedule 2026'],['ID','Name',...ds],['EXAMPLE001','Example Nurse 1',...ds.map((_,i)=>['A','E','N','OF'][i%4])],['EXAMPLE002','Example Nurse 2',...ds.map(()=> 'O')]];}
function items(rows, offset=0) {
 return rows.flatMap((row,r)=>row.map((str,c)=>({str:String(str),width: String(str).length * 4.8,height:8,transform:[1,0,0,1,(c===0?50:c===1?150:250+(c-2)*55)-String(str).length*2.4+offset,750-r*24]})));
}
// Minimal, real PDF: ASCII labels, Helvetica, no hospital or staff data.
function pdf(pageRows) {
 const objects=[];
 const add=s=>{objects.push(s);return objects.length;};
 const catalog=add(''),pages=add(''),font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
 const kids=[];
 const esc=s=>String(s).replace(/([\\()])/g,'\\$1');
 for(const rows of pageRows) {
  const commands=rows.flatMap((row,r)=>row.map((str,c)=>`BT /F1 8 Tf 1 0 0 1 ${(c===0?50:c===1?150:250+(c-2)*55)-String(str).length*2.4} ${750-r*24} Tm (${esc(str)}) Tj ET`)).join('\n');
  const stream=add(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 1700 800] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
 }
 objects[catalog-1]=`<< /Type /Catalog /Pages ${pages} 0 R >>`;
 objects[pages-1]=`<< /Type /Pages /Kids [${kids.map(k=>`${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
 let output='%PDF-1.4\n',offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(output);
 output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(output);
}
module.exports={dates,grid,items,pdf};
