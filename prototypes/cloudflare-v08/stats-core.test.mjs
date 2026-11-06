import test from 'node:test';
import assert from 'node:assert/strict';
import {cycleKey,selectedEmployee,validEventId,summarizeCounts} from './stats-core.mjs';
const schedule={cycleStartDate:'2026-12-07',cycleEndDate:'2027-01-03',employees:[
{id:'a',name:'李代川',employeeNumber:'001'},
{id:'b',name:'王小明',employeeNumber:null},
{id:'c',name:'王小明',employeeNumber:null},
{id:'d',name:'',employeeNumber:'004'}]};
test('28-day cycle key validates exact range',()=>{
 assert.equal(cycleKey(schedule),'2026-12-07_2027-01-03');
 assert.throws(()=>cycleKey({...schedule,cycleEndDate:'2027-01-04'}));
 assert.throws(()=>cycleKey({...schedule,cycleStartDate:'bad'}));
});
test('employee record is selected by unique ID, never name',()=>{
 assert.equal(selectedEmployee(schedule,'b').id,'b');
 assert.equal(selectedEmployee(schedule,'c').id,'c');
 assert.throws(()=>selectedEmployee(schedule,'王小明'));
 assert.throws(()=>selectedEmployee({...schedule,employees:[schedule.employees[0],schedule.employees[0]]},'a'));
});
test('only UUIDv4 event identifiers accepted',()=>{
 assert.equal(validEventId('a3a1c64a-56de-4e98-8f10-8aa92b00a6cd'),true);
 assert.equal(validEventId('not-an-id'),false);
});
test('per-person counts aggregate without merging names or missing numbers',()=>{
 const result=summarizeCounts(schedule,{a:12,b:5,c:2,d:1});
 assert.equal(result.totalSearches,20);
 assert.equal(result.selectedIdentities,4);
 assert.equal(result.people[1].id,'b');
 assert.equal(result.people[2].id,'c');
 assert.equal(result.people[3].employeeNumber,'004');
});
test('reject unknown identities, negative and fractional counts',()=>{
 assert.throws(()=>summarizeCounts(schedule,{unknown:1}));
 assert.throws(()=>summarizeCounts(schedule,{a:-1}));
 assert.throws(()=>summarizeCounts(schedule,{a:1.5}));
});
