/* Cloudflare Durable Object: atomic, idempotent per-publication counters.
 * Internal-only storage primitive. The public Worker MUST authenticate,
 * validate the current publication and employee before invoking this object.
 */
export class SearchStatsCounter {
  constructor(ctx) {
    this.ctx=ctx;
    this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), generation INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO meta(id,generation) VALUES(1,0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (generation INTEGER NOT NULL, event_id TEXT NOT NULL, employee_id TEXT NOT NULL, PRIMARY KEY(generation,event_id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (generation INTEGER NOT NULL, employee_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(generation,employee_id))');
  }
  generation() {return this.sql.exec('SELECT generation FROM meta WHERE id=1').one().generation;}
  // Called only by the authenticated Worker. Do not forward untrusted URLs.
  async fetch(request) {
    if(request.method!=='POST')return new Response('Method Not Allowed',{status:405});
    let body;try {body=await request.json();}catch{return new Response('Invalid request',{status:400});}
    if(body?.action==='count') {
      if(typeof body.employeeId!=='string'||body.employeeId.length<1||body.employeeId.length>128||
        typeof body.eventId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.eventId))
        return new Response('Invalid event',{status:400});
      const inserted=this.ctx.storage.transactionSync(()=>{
        const generation=this.generation();
        this.sql.exec('INSERT OR IGNORE INTO events(generation,event_id,employee_id) VALUES(?,?,?)',generation,body.eventId,body.employeeId);
        const changed=this.sql.exec('SELECT changes() AS n').one().n;
        if(changed===1)this.sql.exec('INSERT INTO counts(generation,employee_id,count) VALUES(?,?,1) ON CONFLICT(generation,employee_id) DO UPDATE SET count=count+1',generation,body.employeeId);
        return changed===1;
      });
      return Response.json({recorded:inserted});
    }
    if(body?.action==='summary') {
      const generation=this.generation(),counts={};
      for(const row of this.sql.exec('SELECT employee_id,count FROM counts WHERE generation=?',generation))counts[row.employee_id]=row.count;
      return Response.json({counts});
    }
    if(body?.action==='reset') {
      this.ctx.storage.transactionSync(()=>{
        this.sql.exec('UPDATE meta SET generation=generation+1 WHERE id=1');
        // Reset removes only this statistics object's counters, never schedules.
        this.sql.exec('DELETE FROM events');
        this.sql.exec('DELETE FROM counts');
      });
      return Response.json({reset:true});
    }
    return new Response('Not Found',{status:404});
  }
}
