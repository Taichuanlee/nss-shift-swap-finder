// Dedicated SQLite Durable Object. Never reads or writes schedule KV.
export class SearchStatsCounter {
  constructor(ctx) {
    this.ctx=ctx;this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS auth_state (id TEXT PRIMARY KEY, value TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS login_budget (period INTEGER PRIMARY KEY, started INTEGER, attempts INTEGER)');
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
    if(b.action==='signing-key') {
      // Private binding only. Never sign directly with a six-digit PIN: a cookie
      // would otherwise provide an offline PIN verifier.
      let row=[...this.sql.exec('SELECT value FROM auth_state WHERE id=?','signing-key')][0];
      if(!row){const key=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');this.sql.exec('INSERT INTO auth_state(id,value) VALUES(?,?)','signing-key',key);row={value:key};}
      return Response.json({key:row.value});
    }
    if(b.action==='login-attempt') {
      // One persistent, globally serialized budget across IPs/colos. Windows
      // start with the first attempt; denied attempts never extend a lockout.
      const now=Date.now();
      const retry=this.ctx.storage.transactionSync(()=>{
        const rows=[...this.sql.exec('SELECT * FROM login_budget')];let retry=0;
        for(const [period,max] of [[60000,5],[86400000,100]]) {
          const row=rows.find(r=>r.period===period);
          if(row&&now<row.started+period&&row.attempts>=max)retry=Math.max(retry,Math.ceil((row.started+period-now)/1000));
        }
        if(retry)return retry;
        for(const period of [60000,86400000]) {
          const row=rows.find(r=>r.period===period),active=row&&now<row.started+period;
          this.sql.exec('INSERT OR REPLACE INTO login_budget(period,started,attempts) VALUES(?,?,?)',period,active?row.started:now,active?row.attempts+1:1);
        }
        return 0;
      });
      return Response.json({allowed:!retry},{status:retry?429:200,headers:retry?{'Retry-After':String(retry)}:{}});
    }
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
