/* Pure, local two-date simulation. Never changes the imported schedule. */
(() => {
  'use strict';
  const ns=window.NSSShiftSwapFinder;
  const addDays=(date,n)=>ns.ImportConfirmation.addDays(date,n);
  const kind=code=>ns.Model.classify(code);
  function validEmployee(model,id) {
    const employee=ns.PersonalSchedule.uniqueEmployee(model,id);
    return employee && !model.errors.some(e=>e.scope==='global'||e.employeeId===id) && model.scheduleDates.every(d=>['work','leave'].includes(kind(employee.shifts[d]))) ? employee : null;
  }
  function cycleDates(model) {
    if(!ns.PersonalSchedule.available(model) || addDays(model.cycleStartDate,27)!==model.cycleEndDate) throw new Error('請先完成匯入、正式四週期及身分確認。');
    const dates=Array.from({length:28},(_,i)=>addDays(model.cycleStartDate,i));
    if(!dates.every(d=>model.scheduleDates.includes(d))) throw new Error('正式四週期日期不完整，不能搜尋。');
    return dates;
  }
  function options(model,id) {
    const dates=cycleDates(model), employee=validEmployee(model,id);
    if(!employee) throw new Error('您的班表資料無效，請重新確認匯入資料。');
    return {workDates:dates.filter(d=>kind(employee.shifts[d])==='work'),leaveDates:dates.filter(d=>kind(employee.shifts[d])==='leave')};
  }
  function runs(dates,shifts) {
    const result=[]; let current=null;
    for(const date of dates) {
      if(kind(shifts[date])!=='work') {current=null;continue;}
      if(!current || addDays(current.end,1)!==date) {current={start:date,end:date,length:0};result.push(current);}
      current.end=date;current.length++;
    }
    return result;
  }
  function fragmentation(dates,shifts) {
    const windows=[];
    for(let i=0;i+3<dates.length;i++) {
      const days=dates.slice(i,i+4),types=days.map(d=>kind(shifts[d]));
      if(days.every((d,j)=>d===addDays(days[0],j)) && types.every((t,j)=>['work','leave'].includes(t) && (!j||t!==types[j-1]))) {
        windows.push({start:days[0],end:days[3]});
      }
    }
    return windows;
  }
  function fragmentationImpact(dates,before,after,changed) {
    const oldWindows=fragmentation(dates,before),newWindows=fragmentation(dates,after);
    // Only four-day windows containing a changed date can change their score.
    // Compare separate neighborhoods independently so an improvement near D2
    // cannot cancel newly fragmented days near D1. Merge overlapping or adjacent
    // ranges of window start dates.
    const starts=[...new Set(changed.flatMap(d=>[0,-1,-2,-3].map(n=>addDays(d,n))))].sort();
    const regions=[];
    for(const start of starts) {
      let region=regions.at(-1);
      if(!region||addDays(region.end,1)!==start) {region={start,end:start,before:0,after:0};regions.push(region);}
      region.end=start;
    }
    for(const region of regions) {
      region.before=oldWindows.filter(w=>region.start<=w.start&&w.start<=region.end).length;
      region.after=newWindows.filter(w=>region.start<=w.start&&w.start<=region.end).length;
    }
    return {beforeCount:oldWindows.length,afterCount:newWindows.length,regions,worsened:regions.some(r=>r.after>r.before)};
  }
  function sortResults(results) {
    const category=r=>!r.sameShift?3:r.risks.consecutive?2:r.risks.fragmented?1:0;
    return results.map((result,index)=>({result,index})).sort((a,b)=>category(a.result)-category(b.result)||a.result.warnings.length-b.result.warnings.length||a.index-b.index).map(item=>item.result);
  }
  function impact(model,employee,overrides) {
    const dates=[...model.scheduleDates].sort(), simulated={...employee.shifts,...overrides};
    const before=runs(dates,employee.shifts), after=runs(dates,simulated), changed=Object.keys(overrides);
    // Inspect complete runs touching a changed day or its neighbors, not just D1/D2.
    const nearby=new Set(changed.flatMap(d=>[addDays(d,-1),d,addDays(d,1)]));
    const affected=list=>list.filter(r=>[...nearby].some(d=>r.start<=d&&d<=r.end));
    const beforeAffected=affected(before),afterAffected=affected(after);
    // Unrelated pre-existing long runs cannot justify a newly created long run.
    const worsenedRuns=afterAffected.filter(r=>r.length>5 && r.length>Math.max(5,...before.filter(b=>b.start<=r.end&&r.start<=b.end).map(b=>b.length)));
    const worsened=worsenedRuns.length>0;
    const edge=afterAffected.some(r=>r.start===dates[0]||r.end===dates.at(-1));
    const transitions=[];
    for(const date of dates) {
      const next=addDays(date,1);
      if((changed.includes(date)||changed.includes(next)) && kind(simulated[date])==='work' && kind(simulated[next])==='work' && simulated[date]!==simulated[next]) {
        transitions.push({date,next,from:simulated[date],to:simulated[next]});
      }
    }
    return {before:beforeAffected,after:afterAffected,beforeMax:Math.max(0,...beforeAffected.map(r=>r.length)),afterMax:Math.max(0,...afterAffected.map(r=>r.length)),worsened,worsenedRuns,edge,transitions,fragmentation:fragmentationImpact(dates,employee.shifts,simulated,changed)};
  }
  function search(model,id,wantedDate,exchangeDates,{emergency=false}={}) {
    const allowed=options(model,id), self=validEmployee(model,id);
    if(!allowed.workDates.includes(wantedDate)) throw new Error('想休日期必須是正式四週期內的 A／E／N 工作日。');
    if(!Array.isArray(exchangeDates)||!exchangeDates.length||exchangeDates.some(d=>!allowed.leaveDates.includes(d))) throw new Error('請選擇正式四週期內至少一個自己的休假日作為交換日期。');
    return [...new Set(exchangeDates)].sort().map(exchangeDate=>{
      const group={exchangeDate,results:[],excluded:{invalid:0,direction:0,shift:0,consecutive:0}};
      for(const candidate of model.employees) {
        if(candidate.id===id) continue;
        const other=validEmployee(model,candidate.id);
        if(!other) {group.excluded.invalid++;continue;}
        const d1=self.shifts[wantedDate],d2=other.shifts[exchangeDate];
        if(kind(other.shifts[wantedDate])!=='leave'||kind(d2)!=='work') {group.excluded.direction++;continue;}
        const sameShift=d1===d2;
        if(!sameShift&&!emergency) {group.excluded.shift++;continue;}
        const selfChanges={[wantedDate]:other.shifts[wantedDate],[exchangeDate]:d2};
        const otherChanges={[wantedDate]:d1,[exchangeDate]:self.shifts[exchangeDate]};
        const selfImpact=impact(model,self,selfChanges),otherImpact=impact(model,other,otherChanges);
        if(otherImpact.worsened) {group.excluded.consecutive++;continue;}
        const risks={consecutive:selfImpact.worsened,fragmented:selfImpact.fragmentation.worsened||otherImpact.fragmentation.worsened};
        const warnings=[];
        if(risks.consecutive) {
          const days=Math.max(...selfImpact.worsenedRuns.map(r=>r.length));
          warnings.push(`⚠️ 連續上班 ${days} 天：您的連續工作區段因交換增加。`);
        }
        if(risks.fragmented) {
          const roles=[selfImpact.fragmentation.worsened?'您':null,otherImpact.fragmentation.worsened?'對方':null].filter(Boolean).join('與');
          warnings.push(`⚠️ 破碎班：${roles}交換後新增或加劇上班、休假交錯的情況。`);
        }
        group.results.push({employeeId:other.id,name:other.name,wantedDate,exchangeDate,sameShift,self:{before:{[wantedDate]:d1,[exchangeDate]:self.shifts[exchangeDate]},after:selfChanges,impact:selfImpact},other:{before:{[wantedDate]:other.shifts[wantedDate],[exchangeDate]:d2},after:otherChanges,impact:otherImpact},risks,warnings});
      }
      group.results=sortResults(group.results);
      return group;
    });
  }
  ns.SwapEngine=Object.freeze({options,search,runs,impact,fragmentation,fragmentationImpact,sortResults});
})();
