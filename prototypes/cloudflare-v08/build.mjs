// Local-only packaging: no network, credentials, git operations, or deployment.
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
export const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory,'../..');
export async function publicationRuntimeSource() {
  const scripts = await Promise.all(['schedule-model','schedule-validator','import-confirmation','schedule-publication']
    .map(name => readFile(path.join(root,'js',`${name}.js`),'utf8')));
  return `const publicationRuntime = (() => { const window = {};\n${scripts.join('\n')}\nreturn window.NSSShiftSwapFinder; })();\n`;
}
export async function build() {
  const runtime = await publicationRuntimeSource();
  const html = await readFile(path.join(directory,'public/index.html'),'utf8');
  const app = await readFile(path.join(directory,'public/app.js'),'utf8');
  const worker = await readFile(path.join(directory,'worker.mjs'),'utf8');
  await mkdir(path.join(directory,'dist'),{recursive:true});
  await writeFile(path.join(directory,'dist/worker.mjs'),runtime+`const SSF_PATHS=new Set();\nconst INDEX_HTML=${JSON.stringify(html)};\nconst APP_JS=${JSON.stringify(app)};\n`+worker);
  // The only on-disk schedule fixtures are explicitly fictional.
  const dates=Array.from({length:40},(_,i)=>new Date(Date.UTC(2026,10,4+i)).toISOString().slice(0,10));
  const base={format:'nss-shift-swap-finder.schedule',schemaVersion:1,publishedAt:'2026-10-20T00:00:00.000Z',
    cycle:{startDate:dates[5],endDate:dates[32]},dates,
    employees:[{id:'SYNTHETIC001',name:'合成測試員甲',shifts:Object.fromEntries(dates.map((d,i)=>[d,i%4===0?'A':'OF']))},
      {id:'SYNTHETIC002',name:'合成測試員乙',shifts:Object.fromEntries(dates.map((d,i)=>[d,i%4===1?'A':'O']))}]};
  const manifest={kvKey:'schedule:active',fixtures:[]};
  for(const version of ['a','b']) {
    const payload=structuredClone(base);
    if(version==='b') {payload.publishedAt='2026-10-20T00:01:00.000Z';payload.employees[1].shifts[dates[0]]='E';}
    const text=JSON.stringify(payload,null,2);
    const filename=`synthetic-${version}.json`;
    await writeFile(path.join(directory,'dist',filename),text);
    manifest.fixtures.push({filename,sha256:createHash('sha256').update(text).digest('hex')});
  }
  await writeFile(path.join(directory,'dist/synthetic-manifest.json'),JSON.stringify(manifest,null,2));
}
export async function setupLocalSecrets() {
  const code=randomBytes(24).toString('base64url');
  const secrets={accessCode:code,ACCESS_CODE_SHA256:createHash('sha256').update(code).digest('hex')};
  // Never overwrite existing device credentials or print them in logs.
  try {await writeFile(path.join(directory,'dist/local-secrets.json'),JSON.stringify(secrets,null,2),{flag:'wx',mode:0o600});}
  catch(error) {if(error.code!=='EEXIST')throw error;}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await build();
  if(process.argv.includes('--setup-local'))await setupLocalSecrets();
  console.log('Built isolated prototype and synthetic fixtures in prototypes/cloudflare-v08/dist/ (Git ignored). No deployment.');
}
