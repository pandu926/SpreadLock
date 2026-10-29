import type { AuditEvent, Basket, Challenge, Execution, Job, KeeperAuthorization, ListIntents, Session, Store, StoredIntent } from '../../../packages/db/src/types.js';

/** Test fixture only. Production exclusively constructs PgStore. */
export class MemoryStore implements Store {
  readonly challenges = new Map<string, Challenge>();
  readonly sessions = new Map<string, Session>();
  readonly baskets = new Map<string, Basket>();
  readonly intents = new Map<string, StoredIntent>();
  readonly authorizations = new Map<string, KeeperAuthorization>();
  readonly executions = new Map<string, Execution>();
  readonly audits: AuditEvent[] = [];
  readonly jobs = new Map<string, Job>();
  async ready() {}
  async close() {}
  async createChallenge(c: Challenge) { this.challenges.set(c.id, { ...c }); }
  async getChallenge(id: string) { return this.challenges.get(id) ?? null; }
  async consumeChallenge(id: string, now: number) {
    const c = this.challenges.get(id);
    if (!c || c.consumedAt !== null || c.expiresAt <= now) return false;
    this.challenges.set(id, { ...c, consumedAt: now }); return true;
  }
  async createSession(s: Session) { this.sessions.set(s.tokenHash, { ...s }); }
  async getSession(h: string) { return this.sessions.get(h) ?? null; }
  async deleteSession(h: string) { this.sessions.delete(h); }
  async putBasket(b: Basket) { const key = `${b.chainId}:${b.account}`; const old = this.baskets.get(key); if (old) return old; this.baskets.set(key, b); return b; }
  async getBasket(chainId: number, account: `0x${string}`) { return this.baskets.get(`${chainId}:${account}`) ?? null; }
  async listBaskets(owner: `0x${string}`, chainId: number, after: string | undefined, limit: number) {
    return [...this.baskets.values()].filter(b => b.owner === owner && b.chainId === chainId && (!after || b.id > after)).sort((a,b) => a.id.localeCompare(b.id)).slice(0,limit);
  }
  async putIntent(i: StoredIntent) { const old = this.intents.get(i.id); if (old) return {value:old,created:false}; this.intents.set(i.id, i); return {value:i,created:true}; }
  async getIntent(id: string) { return this.intents.get(id) ?? null; }
  async listIntents(q: ListIntents) {
    return [...this.intents.values()].filter(i => i.owner === q.owner && i.chainId === q.chainId && (!q.accounts || q.accounts.includes(i.account)) && (!q.executor || i.executor === q.executor) && (!q.activeOnly || ['WAITING','ELIGIBLE'].includes(i.status)) && (!q.after || i.id > q.after)).sort((a,b) => a.id.localeCompare(b.id)).slice(0,q.limit);
  }
  async requestCancellation(id: string, owner: `0x${string}`, now: number) {
    const old = this.intents.get(id); if (!old || old.owner !== owner || ['MINED','CONFIRMED','CANCELLED','EXPIRED','INVALIDATED'].includes(old.status)) return null;
    const updated = {...old,status:'CANCEL_REQUESTED' as const,updatedAt:now}; this.intents.set(id,updated); return updated;
  }
  async putAuthorization(a: KeeperAuthorization) {
    const same = [...this.authorizations.values()].find(v=>v.owner===a.owner && v.chainId===a.chainId && v.nonce===a.nonce);
    if (same && (same.id !== a.id || same.revokedAt !== null)) throw new Error('AUTHORIZATION_NONCE_USED');
    this.authorizations.set(a.id, same ?? a); return same ?? a;
  }
  async getAuthorization(id: string) { return this.authorizations.get(id) ?? null; }
  async listAuthorizations(owner: `0x${string}`, chainId: number) { return [...this.authorizations.values()].filter(a=>a.owner===owner && a.chainId===chainId); }
  async revokeAuthorization(id: string, owner: `0x${string}`, now: number) { const a=this.authorizations.get(id); if(!a||a.owner!==owner) return false;this.authorizations.set(id,{...a,revokedAt:now});return true; }
  async heartbeat(_authorizationId: string, _now: number) {}
  async putExecution(e: Execution) { const old=[...this.executions.values()].find(x=>x.chainId===e.chainId&&x.txHash===e.txHash&&x.intentId===e.intentId); if(old)return old;this.executions.set(e.id,e);return e; }
  async listExecutions(owner: `0x${string}`, chainId: number, account: `0x${string}` | undefined, after: string | undefined, limit: number) {
    return [...this.executions.values()].filter(e=>{const i=this.intents.get(e.intentId);return i?.owner===owner&&i.chainId===chainId&&(!account||i.account===account)&&(!after||e.id>after);}).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit);
  }
  async appendAudit(a: AuditEvent) { this.audits.push(a); }
  async enqueueJob(kind: string, key: string, payload: Record<string,unknown>, runAt: number) {this.jobs.set(key,{id:key,kind,payload,runAt,attempts:0});}
  async claimJobs(_worker:string,now:number,limit:number){return [...this.jobs.values()].filter(j=>j.runAt<=now).slice(0,limit);}
  async finishJob(id:string,_worker:string){this.jobs.delete(id);}
  async retryJob(id:string,_worker:string,_error:string,runAt:number){const j=this.jobs.get(id);if(j)this.jobs.set(id,{...j,runAt,attempts:j.attempts+1});}
}
