import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SearchStatsCounter} from './stats-counter.mjs';
export function counterFixture() {
  const db=new DatabaseSync(':memory:');let alarm=null,queue=Promise.resolve();
  const storage={sql:{exec(query,...args){const stmt=db.prepare(query);const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {one(){assert.equal(rows.length,1);return rows[0];},[Symbol.iterator](){return rows[Symbol.iterator]();}};}},
    transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
    async setAlarm(time){alarm=time;},async deleteAlarm(){alarm=null;}};
  const object=new SearchStatsCounter({storage,blockConcurrencyWhile(fn){const next=queue.then(fn);queue=next.catch(()=>{});return next;}});
  const send=body=>object.fetch(new Request('https://internal/',{method:'POST',body:JSON.stringify(body)}));
  return {object,db,send,get alarm(){return alarm;}};
}
