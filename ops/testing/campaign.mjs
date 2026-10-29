const DAY=86400000, PERIOD=60000;
const finite=(v)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const result=(checks,incomplete=false)=>({status:checks.every(c=>c.passed)?(incomplete?'NOT_RUN':'PASS'):'FAIL',checks});
export function assessLoad(m){
 const measured=['durationMs','burstDurationMs','targetRps','burstRps','concurrency','owners','keepers','baskets','intents','total','serverErrors','unexpectedResponses','dropped','readP95Ms','writeP95Ms','quoteP95Ms','queueRecoveryMs','peakMemoryBytes','oomEvents','assertionFailures','completedWrites'];
 const checks=[{id:'complete_measurements',passed:measured.every(k=>finite(m[k]))}];
 if(!checks[0].passed)return result(checks);
 checks.push({id:'no_integrity_errors',passed:m.assertionFailures===0&&m.unexpectedResponses===0&&m.dropped===0&&m.oomEvents===0},
 {id:'latency',passed:m.readP95Ms<=200&&m.writeP95Ms<=500&&m.quoteP95Ms<=2000},
 {id:'server_errors',passed:m.total>0&&m.serverErrors/m.total<0.001},
 {id:'queue_recovery',passed:m.queueRecoveryMs<=300000},
 {id:'resource_measurements',passed:m.peakMemoryBytes>0});
 if(m.profile==='full')checks.push({id:'production_profile',passed:m.durationMs>=3600000&&m.burstDurationMs>=300000&&m.targetRps>=100&&m.burstRps>=300&&m.concurrency>=100&&m.owners>=100&&m.keepers>=10&&m.baskets>=1000&&m.intents>=10000&&m.activeOwners>=100&&m.activeKeepers>=10&&m.sourceUnchanged===true},
 {id:'observed_throughput',passed:m.total>=0.99*(m.durationMs*m.targetRps+m.burstDurationMs*m.burstRps)/1000&&m.completedWrites>=m.total*0.045});
 return result(checks,m.profile!=='full');
}
export function initialSoak(sourceSha256,startedAt=Date.now()){
 if(!/^[a-f0-9]{64}$/.test(sourceSha256)||!finite(startedAt))throw new Error('Invalid soak source/time');
 return {schemaVersion:1,sourceSha256,startedAt,lastAt:startedAt,probes:0,readyProbes:0,unreadyProbes:0,missingProbes:0,gasSpentWei:'0',maxCollateralCommittedWei:'0',canonicalCycles:0,days:{},failures:[]};
}
export function recordSoak(state,probe){
 if(!finite(probe.at)||probe.at<state.lastAt||(state.probes>0&&probe.at-state.lastAt<PERIOD)||typeof probe.ready!=='boolean')throw new Error('Invalid/nonmonotonic probe');
 for(const key of ['gasSpentWei','collateralCommittedWei'])if(!/^(0|[1-9][0-9]*)$/.test(probe[key]??''))throw new Error('Invalid budget counters');
 if(BigInt(probe.gasSpentWei)<BigInt(state.gasSpentWei))throw new Error('Gas counter regressed');
 const cycles=probe.canonicalCycles??state.canonicalCycles;if(!Number.isSafeInteger(cycles)||cycles<state.canonicalCycles)throw new Error('Cycle counter regressed');
 const day=Math.floor((probe.at-state.startedAt)/DAY),old=state.days[day]??{reconciliations:0,cycles:0};
 let days={...state.days,[day]:{reconciliations:old.reconciliations+(probe.reconciled?1:0),cycles:old.cycles+cycles-state.canonicalCycles}};
 if(probe.completedCycles!==undefined){
  if(!Array.isArray(probe.completedCycles)||new Set(probe.completedCycles.map(c=>c.hash)).size!==probe.completedCycles.length||probe.completedCycles.some(c=>!/^0x[a-f0-9]{64}$/.test(c.hash)||!finite(c.at)||c.at<state.startedAt||c.at>probe.at))throw new Error('Invalid canonical cycle evidence');
  days=Object.fromEntries(Object.entries(days).map(([k,v])=>[k,{...v,cycles:0}]));
  for(const cycle of probe.completedCycles){const k=Math.floor((cycle.at-state.startedAt)/DAY),d=days[k]??{reconciliations:0,cycles:0};days={...days,[k]:{...d,cycles:d.cycles+1}};}
 }
 const maxCollateral=BigInt(state.maxCollateralCommittedWei)>BigInt(probe.collateralCommittedWei)?state.maxCollateralCommittedWei:probe.collateralCommittedWei;
 return {...state,lastAt:probe.at,probes:state.probes+1,readyProbes:state.readyProbes+(probe.ready?1:0),unreadyProbes:state.unreadyProbes+(probe.ready?0:1),missingProbes:Math.max(state.missingProbes,Math.floor((probe.at-state.startedAt)/PERIOD)-(state.probes+1)),gasSpentWei:probe.gasSpentWei,maxCollateralCommittedWei:maxCollateral,canonicalCycles:cycles,days,
 failures:[...state.failures,...(probe.error?[{at:probe.at,error:String(probe.error).slice(0,300)}]:[])]};
}
export function assessSoak(s,now=Date.now()){
 const elapsed=now-s.startedAt,missedTail=Math.max(0,Math.floor((now-s.lastAt)/PERIOD)-1),expected=s.probes+s.missingProbes+missedTail;
 const availability=expected?s.readyProbes/expected:0;
 const budget=BigInt(s.gasSpentWei)<=10n*10n**18n&&BigInt(s.maxCollateralCommittedWei)<=100n*10n**18n;
 const days=Array.from({length:7},(_,i)=>s.days[i]);
 const checks=[{id:'budget',passed:budget},{id:'availability',passed:availability>=0.995},
 {id:'fresh_probe',passed:now>=s.lastAt&&now-s.lastAt<=120000},
 {id:'daily_reconciliation',passed:days.every(d=>d&&d.reconciliations>=1)},
 {id:'daily_canonical_cycles',passed:days.every(d=>d&&d.cycles>=2)},
 {id:'seven_days',passed:elapsed>=7*DAY}];
 if(!budget)return {...result(checks),availability};
 if(elapsed<7*DAY)return {status:'NOT_RUN',checks,availability,remainingMs:7*DAY-elapsed};
 return {...result(checks),availability};
}
export function assessDr(m){
 const required=['sourceHostId','restoreHostId','encrypted','offsite','walArchived','targetWasEmpty','restoreStartedAt','restoreCompletedAt','lastRecoverableAt','incidentAt','reconciled','backupSha256','restoreArtifactSha256'];
 if(required.some(k=>m[k]===undefined))return{status:'BLOCKED',checks:[{id:'required_external_infrastructure_evidence',passed:false}]};
 const times=['restoreStartedAt','restoreCompletedAt','lastRecoverableAt','incidentAt'];
 const checks=[{id:'valid_measurements',passed:times.every(k=>finite(m[k]))&&/^[a-f0-9]{64}$/.test(m.backupSha256)&&/^[a-f0-9]{64}$/.test(m.restoreArtifactSha256)},
 {id:'separate_host',passed:typeof m.sourceHostId==='string'&&m.sourceHostId.length>0&&typeof m.restoreHostId==='string'&&m.restoreHostId.length>0&&m.sourceHostId!==m.restoreHostId},
 {id:'encrypted_offsite_wal',passed:m.encrypted===true&&m.offsite===true&&m.walArchived===true},
 {id:'empty_target',passed:m.targetWasEmpty===true},{id:'reconciled',passed:m.reconciled===true},
 {id:'rpo',passed:m.incidentAt>=m.lastRecoverableAt&&m.incidentAt-m.lastRecoverableAt<=900000},
 {id:'rto',passed:m.restoreStartedAt>=m.incidentAt&&m.restoreCompletedAt>=m.restoreStartedAt&&m.restoreCompletedAt-m.incidentAt<=14400000}];
 return {...result(checks),rpoMs:m.incidentAt-m.lastRecoverableAt,rtoMs:m.restoreCompletedAt-m.incidentAt};
}
export function percentile(samples,p=0.95){if(!samples.length)return NaN;const sorted=[...samples].sort((a,b)=>a-b);return sorted[Math.ceil(sorted.length*p)-1];}
