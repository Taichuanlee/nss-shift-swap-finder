// Dedicated SQLite Durable Object. Never reads or writes schedule KV.
export class SearchStatsCounter {
  constructor(ctx) {
    this.ctx=ctx;this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS revoked_sessions (token TEXT PRIMARY KEY, expires INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS cycles (cycle TEXT PRIMARY KEY, start TEXT, end TEXT, expires INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS search_events (event TEXT PRIMARY KEY, cycle TEXT, employee TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS search_counts (cycle TEXT, employee TEXT, name TEXT, count INTEGER, PRIMARY KEY(cycle,employee))');
  }
  async cleanup() {
    const now=Date.now();
    this.ctx.storage.transactionSync(()=>{
      this.sql.exec('DELETE FROM search_events WHERE cycle IN (SELECT cycle FROM cycles WHERE expires<=?)',now);
      this.sql.exec('DELETE FROM search_counts WHERE cycle IN (SELECT cycle FROM cycles WHERE expires<=?)',now);
      this.sql.exec('DELETE FROM cycles WHERE expires<=?',now);
      this.sql.exec('DELETE FROM revoked_sessions WHERE expires<=?',now);
    });
    const next=this.sql.exec('SELECT MIN(expires) AS expiry FROM (SELECT expires FROM cycles UNION ALL SELECT expires FROM revoked_sessions)').one().expiry;
    if(next!==null)await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {return this.ctx.blockConcurrencyWhile(()=>this.cleanup());}
  async fetch(request) {return this.ctx.blockConcurrencyWhile(()=>this.handle(request));}
  async handle(request) {
    if(request.method!=='POST')return new Response(null,{status:405});
    const b=await request.json();await this.cleanup();
    if(b.action==='count') {
      if(!Number.isSafeInteger(b.expires)||b.expires<=Date.now())return Response.json({error:'expired_cycle'},{status:410});
      const recorded=this.ctx.storage.transactionSync(()=>{
        this.sql.exec('INSERT OR IGNORE INTO cycles(cycle,start,end,expires) VALUES(?,?,?,?)',b.cycle,b.start,b.end,b.expires);
        this.sql.exec('INSERT OR IGNORE INTO search_events(event,cycle,employee) VALUES(?,?,?)',b.eventId.toLowerCase(),b.cycle,b.employeeId);
        if(this.sql.exec('SELECT changes() AS n').one().n!==1)return false;
        this.sql.exec('INSERT INTO search_counts(cycle,employee,name,count) VALUES(?,?,?,1) ON CONFLICT(cycle,employee) DO UPDATE SET count=count+1,name=excluded.name',b.cycle,b.employeeId,b.name);
        return true;
      });
      await this.cleanup();return Response.json({recorded});
    }
    if(b.action==='revoke') {
      this.sql.exec('INSERT OR IGNORE INTO revoked_sessions(token,expires) VALUES(?,?)',b.token,b.expires);
      await this.cleanup();return Response.json({revoked:true});
    }
    if(b.action==='summary') {
      if(b.token&&this.sql.exec('SELECT COUNT(*) AS n FROM revoked_sessions WHERE token=?',b.token).one().n)return Response.json({error:'unauthorized'},{status:401});
      const cycles=[];
      for(const c of this.sql.exec('SELECT * FROM cycles ORDER BY start DESC')) {
        const people=[...this.sql.exec('SELECT employee AS id,name,count AS searches FROM search_counts WHERE cycle=? ORDER BY count DESC,employee',c.cycle)];
        cycles.push({cycleStartDate:c.start,cycleEndDate:c.end,expiresAt:new Date(c.expires).toISOString(),totalSearches:people.reduce((n,p)=>n+p.searches,0),selectedIdentities:people.length,people});
      }
      return Response.json({cycles});
    }
    return new Response(null,{status:404});
  }
}
