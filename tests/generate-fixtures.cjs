// Create fictional manual-test documents in the ignored local test-data folder.
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('../vendor/sheetjs/xlsx.full.min.js');
const {grid,pdf} = require('./fixtures.cjs');
const target=path.resolve(__dirname,'../test-data');
fs.mkdirSync(target,{recursive:true});
function write(name,bytes) {
 const file=path.join(target,name);
 if(fs.existsSync(file)) {console.log(`Skipped existing synthetic fixture: ${name}`);return;}
 fs.writeFileSync(file,bytes,{flag:'wx'});
 console.log(`Created synthetic fixture: ${name}`);
}
write('synthetic-valid.pdf',pdf([grid()]));
write('synthetic-multipage.pdf',pdf([grid(),grid()]));
write('synthetic-no-text.pdf',pdf([[]]));
for(const type of ['xlsx','xls']) {
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(grid()),'Synthetic');
 write(`synthetic-valid.${type}`,XLSX.write(wb,{type:'buffer',bookType:type}));
}
const bad=grid();bad[2][3]='OX';bad[2][4]='';
const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(bad),'Synthetic local errors');
XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(grid()),'Synthetic healthy');
write('synthetic-multi-sheet.xlsx',XLSX.write(wb,{type:'buffer',bookType:'xlsx'}));
