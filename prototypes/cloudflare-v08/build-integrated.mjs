// Explicit public-resource snapshot. Never scans private folders, secrets or schedules.
import {readFile,writeFile,mkdir,mkdtemp,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {directory,publicationRuntimeSource} from './build.mjs';
const root=path.resolve(directory,'../..');
const javascript=['schedule-model','schedule-validator','pdf-parser','excel-parser','import-confirmation',
  'schedule-publication','personal-schedule','swap-engine','swap-ui','app'];
async function publicBytes(filename) {
  const stat=await lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('Only regular public resources may be packaged.');
  const data=await readFile(filename);
  if(data.subarray(0,1024).includes(Buffer.from('%PDF-'))||data.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))||
    data.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])))throw new Error('Document content cannot be packaged as code.');
  return data;
}
async function vendorFiles(relative='vendor') {
  const entries=await readdir(path.join(root,relative),{withFileTypes:true}),files=[];
  for(const entry of entries) {
    if(entry.name.startsWith('.')||entry.isSymbolicLink())throw new Error('Unexpected vendor entry.');
    const name=`${relative}/${entry.name}`;
    if(entry.isDirectory())files.push(...await vendorFiles(name));
    else {
      if(!/\.(?:js|mjs|bcmap|pfb|ttf)$/.test(name)&&!['LICENSE','LICENSE_FOXIT','LICENSE_LIBERATION','README.md'].includes(entry.name))throw new Error('Unexpected vendor file.');
      files.push(name);
    }
  }
  return files;
}
export async function buildIntegrated() {
  await mkdir(path.join(directory,'dist'),{recursive:true});
  // Fresh directory on every build prevents old/private files being carried forward.
  const output=await mkdtemp(path.join(directory,'dist/ssf-')),assets=path.join(output,'public');
  await mkdir(assets);
  const inventory=[];
  async function save(relative,data) {
    const target=path.join(assets,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data);inventory.push(relative);
  }
  let html=(await publicBytes(path.join(root,'index.html'))).toString('utf8');
  const panel=await readFile(path.join(directory,'integration/central-panel.html'),'utf8');
  html=html.replace('<div class="workspace">',panel+'\n    <div class="workspace" id="manual-workspace" hidden>')
    .replace('<script src="js/app.js" defer></script>','<script src="js/app.js" defer></script>\n  <script src="central-schedule.js" defer></script>')
    .replace('<link rel="stylesheet" href="css/style.css">','<link rel="stylesheet" href="css/style.css">\n  <link rel="stylesheet" href="central-schedule.css">')
    .replace('<span class="version">v0.7</span>','<span class="version">v0.8 測試</span>')
    .replace('<strong>您的班表，留在您的裝置</strong><p>班表資料將於您的裝置上處理，不會上傳至伺服器。</p>',
      '<strong>單位班表與自行上傳，來源清楚區分</strong><p>單位班表登入後由私人服務取得；自行上傳的檔案只在裝置上解析。換班搜尋在您的裝置上進行，不會修改單位班表。</p>');
  if(!html.includes('id="central-login"')||!html.includes('central-schedule.js'))throw new Error('SSF integration insertion failed.');
  await save('index.html',html);
  for(const relative of ['css/style.css',...javascript.map(name=>`js/${name}.js`),...await vendorFiles()])await save(relative,await publicBytes(path.join(root,relative)));
  for(const name of ['central-schedule.js','central-schedule.css','admin.html','admin-login.html','admin-auth.js','admin.js','admin.css'])await save(name,await publicBytes(path.join(directory,'integration',name)));
  const routes=['/','/admin','/admin/','/admin/login',...inventory.map(name=>'/'+name)].sort();
  const worker=await readFile(path.join(directory,'worker.mjs'),'utf8');
  await writeFile(path.join(output,'worker.mjs'),await publicationRuntimeSource()+`const SSF_PATHS=new Set(${JSON.stringify(routes)});\nconst INDEX_HTML=''; const APP_JS='';\n`+worker);
  await writeFile(path.join(output,'wrangler.jsonc'),JSON.stringify({name:'nss-ssf-v08-test',main:'worker.mjs',
    compatibility_date:'2026-10-20',workers_dev:true,keep_vars:true,
    assets:{directory:'./public',binding:'ASSETS',run_worker_first:true,html_handling:'none'},
    vars:{SYNTHETIC_ONLY:'true'},
    secrets:{required:['ACCESS_CODE','ADMIN_ACCESS_CODE']},
    ratelimits:[{name:'LOGIN_LIMITER',namespace_id:'8808',simple:{limit:50,period:60}},{name:'ADMIN_LOGIN_LIMITER',namespace_id:'8809',simple:{limit:5,period:60}}],
    kv_namespaces:[{binding:'SCHEDULE_KV',id:'745fd00938e14081823e0b5a9239ffcd'}]},null,2));
  await writeFile(path.join(output,'asset-inventory.json'),JSON.stringify(inventory.sort(),null,2));
  return {output,assets,inventory};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await buildIntegrated();console.log(`Local SSF + ASSETS package: ${result.output}\n${result.inventory.length} public resources. Not deployed. Verify the existing test KV namespace ID before deployment.`);
}
