/* SSF v1.0.2 statistics: pure validation and aggregation helpers.
 * This module does not write to Cloudflare KV and must not be used as a
 * concurrency-safe counter. Durable Object storage will own increments.
 */
export function cycleKey(publication) {
  const start=publication?.cycleStartDate,end=publication?.cycleEndDate;
  if(typeof start!=='string'||typeof end!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(start)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(end))throw new Error('invalid_cycle');
  const begin=Date.parse(start+'T00:00:00Z'),finish=Date.parse(end+'T00:00:00Z');
  if(!Number.isFinite(begin)||new Date(begin).toISOString().slice(0,10)!==start||new Date(finish).toISOString().slice(0,10)!==end||finish-begin!==27*86400000)throw new Error('invalid_cycle');
  return start+'_'+end;
}
export function selectedEmployee(publication,id) {
  if(typeof id!=='string'||id.length<1||id.length>128)throw new Error('invalid_employee');
  const matches=(publication?.employees||[]).filter(e=>e?.id===id);
  if(matches.length!==1)throw new Error('invalid_employee');
  return matches[0];
}
export function validEventId(id) {
  return typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
export function summarizeCounts(publication,counts) {
  const byId=new Map((publication?.employees||[]).map(e=>[e.id,e]));
  const people=[];let searches=0;
  for(const [id,value] of Object.entries(counts||{})) {
    if(!byId.has(id)||!Number.isSafeInteger(value)||value<0)throw new Error('invalid_counts');
    if(value===0)continue;
    const person=byId.get(id);
    searches+=value;
    if(!Number.isSafeInteger(searches))throw new Error('invalid_counts');
    people.push({id,name:person.name||null,employeeNumber:person.employeeNumber||null,searches:value});
  }
  people.sort((a,b)=>b.searches-a.searches||a.id.localeCompare(b.id));
  return {cycleStartDate:publication.cycleStartDate,cycleEndDate:publication.cycleEndDate,totalSearches:searches,selectedIdentities:people.length,people};
}
