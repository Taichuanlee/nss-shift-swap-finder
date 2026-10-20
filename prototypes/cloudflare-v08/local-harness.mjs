// Node HTTPS + in-memory KV adapter. NOT workerd and NOT real Cloudflare KV.
import {readFile, mkdtemp} from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {build, directory} from './build.mjs';

export class MemoryKV {
  constructor() {this.values=new Map();this.reads=[];this.writes=[];this.fail=false;this.staleSchedule=null;}
  async get(key,options) {
    this.reads.push({key,options});if(this.fail)throw new Error('simulated KV outage');
    if(key==='schedule:active'&&this.staleSchedule!==null)return this.staleSchedule;
    // Keep expired entries deliberately: Worker must enforce expiry itself.
    return this.values.get(key)?.value??null;
  }
  async put(key,value,options) {
    if(this.fail)throw new Error('simulated KV outage');
    this.writes.push({key,options});this.values.set(key,{value,options});
  }
  async delete(key) {if(this.fail)throw new Error('simulated KV outage');this.values.delete(key);}
}
export async function prepare() {
  await build();
  const worker=(await import(pathToFileURL(path.join(directory,'dist/worker.mjs')).href)).default;
  const a=await readFile(path.join(directory,'dist/synthetic-a.json'),'utf8');
  const b=await readFile(path.join(directory,'dist/synthetic-b.json'),'utf8');
  return {worker,a,b};
}
export async function startLocal(env,worker) {
  // Short-lived local self-signed certificate; never alters system trust settings.
  const tlsDirectory=await mkdtemp(path.join(os.tmpdir(),'nss-v08-tls-'));
  const key=path.join(tlsDirectory,'key.pem'),cert=path.join(tlsDirectory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
    '-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  const server=https.createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
    try {
      const buffers=[];let length=0;
      for await(const chunk of req) {length+=chunk.length;if(length>2048){res.writeHead(413).end();return;}buffers.push(chunk);}
      const request=new Request(`https://localhost:${server.address().port}${req.url}`,{method:req.method,
        headers:req.headers,...(buffers.length?{body:Buffer.concat(buffers)}:{})});
      const response=await worker.fetch(request,env);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(503).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {origin:`https://localhost:${server.address().port}`,close:()=>new Promise(resolve=>{
    server.close(resolve);server.closeAllConnections();
  })};
}
