import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { Address, AuditEvent, Basket, Challenge, Execution, Job, KeeperAuthorization, ListIntents, Session, Store, StoredIntent } from './types.js';

type Row=Record<string,any>;
const ms=(v:unknown)=>v===null||v===undefined?null:new Date(v as string).getTime();
const date=(v:number)=>new Date(v);
const basket=(r:Row):Basket=>({id:r.id,account:r.account,owner:r.owner,chainId:Number(r.chain_id),name:r.name,createdAt:ms(r.created_at)!});
const intent=(r:Row):StoredIntent=>({id:r.id,account:r.account,owner:r.owner,chainId:Number(r.chain_id),executor:r.executor,body:r.body,signature:r.signature,status:r.status,createdAt:ms(r.created_at)!,updatedAt:ms(r.updated_at)!});
const authorization=(r:Row):KeeperAuthorization=>({id:r.id,owner:r.owner,keeper:r.keeper,accounts:r.accounts,chainId:Number(r.chain_id),validUntil:String(r.valid_until),nonce:String(r.nonce),signature:r.signature,revokedAt:ms(r.revoked_at),createdAt:ms(r.created_at)!});
const execution=(r:Row):Execution=>({id:r.id,intentId:r.intent_id,chainId:Number(r.chain_id),txHash:r.tx_hash,status:r.status,blockNumber:r.block_number===null?null:String(r.block_number),blockHash:r.block_hash,receipt:r.receipt,createdAt:ms(r.created_at)!,updatedAt:ms(r.updated_at)!});

export class PgStore implements Store {
  readonly pool:pg.Pool;
  readonly db;
  constructor(connectionString:string,options:{max?:number}={}){
    if(!connectionString)throw new Error('DATABASE_URL is required');
    this.pool=new pg.Pool({connectionString,max:options.max??8,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,statement_timeout:15000,application_name:'spreadlock'});
    this.db=drizzle(this.pool,{schema});
  }
  async ready(){await this.pool.query('SELECT 1');}
  async close(){await this.pool.end();}
  async createChallenge(c:Challenge){await this.pool.query('INSERT INTO app_challenges(id,owner,signer,chain_id,message,role,authorization_id,expires_at,consumed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[c.id,c.owner,c.signer,c.chainId,c.message,c.role,c.authorizationId,date(c.expiresAt),c.consumedAt===null?null:date(c.consumedAt)]);}
  async getChallenge(id:string):Promise<Challenge|null>{const{rows}=await this.pool.query('SELECT * FROM app_challenges WHERE id=$1',[id]);const r=rows[0];return r?{id:r.id,owner:r.owner,signer:r.signer,chainId:Number(r.chain_id),message:r.message,role:r.role,authorizationId:r.authorization_id,expiresAt:ms(r.expires_at)!,consumedAt:ms(r.consumed_at)}:null;}
  async consumeChallenge(id:string,now:number){const r=await this.pool.query('UPDATE app_challenges SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL AND expires_at>$2',[id,date(now)]);return r.rowCount===1;}
  async createSession(s:Session){await this.pool.query('INSERT INTO app_sessions(token_hash,owner,signer,chain_id,role,authorization_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.tokenHash,s.owner,s.signer,s.chainId,s.role,s.authorizationId,date(s.expiresAt)]);}
  async getSession(tokenHash:string):Promise<Session|null>{const{rows}=await this.pool.query('SELECT * FROM app_sessions WHERE token_hash=$1',[tokenHash]);const r=rows[0];return r?{tokenHash:r.token_hash,owner:r.owner,signer:r.signer,chainId:Number(r.chain_id),role:r.role,authorizationId:r.authorization_id,expiresAt:ms(r.expires_at)!}:null;}
  async deleteSession(tokenHash:string){await this.pool.query('DELETE FROM app_sessions WHERE token_hash=$1',[tokenHash]);}
  async putBasket(b:Basket){const{rows}=await this.pool.query('INSERT INTO app_baskets(id,account,owner,chain_id,name,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chain_id,account) DO UPDATE SET name=CASE WHEN app_baskets.owner=EXCLUDED.owner THEN EXCLUDED.name ELSE app_baskets.name END RETURNING *',[b.id,b.account,b.owner,b.chainId,b.name,date(b.createdAt)]);const result=basket(rows[0]);if(result.owner!==b.owner)throw new Error('BASKET_OWNER_CONFLICT');return result;}
  async getBasket(chainId:number,account:Address){const{rows}=await this.pool.query('SELECT * FROM app_baskets WHERE chain_id=$1 AND account=$2',[chainId,account]);return rows[0]?basket(rows[0]):null;}
  async listBaskets(owner:Address,chainId:number,after:string|undefined,limit:number){const{rows}=await this.pool.query('SELECT * FROM app_baskets WHERE owner=$1 AND chain_id=$2 AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4',[owner,chainId,after??null,limit]);return rows.map(basket);}
  async putIntent(i:StoredIntent){const{rows}=await this.pool.query('INSERT INTO app_intents(id,owner,account,chain_id,executor,body,signature,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING *',[i.id,i.owner,i.account,i.chainId,i.executor,i.body,i.signature,i.status,date(i.createdAt),date(i.updatedAt)]);if(rows[0])return{value:intent(rows[0]),created:true};const old=await this.getIntent(i.id);if(!old||old.owner!==i.owner)throw new Error('INTENT_OWNER_CONFLICT');return{value:old,created:false};}
  async getIntent(id:string){const{rows}=await this.pool.query('SELECT * FROM app_intents WHERE id=$1',[id]);return rows[0]?intent(rows[0]):null;}
  async listIntents(q:ListIntents){const{rows}=await this.pool.query(`SELECT * FROM app_intents WHERE owner=$1 AND chain_id=$2
    AND ($3::text[] IS NULL OR account=ANY($3::text[])) AND ($4::text IS NULL OR executor=$4)
    AND ($5::boolean=false OR status IN ('WAITING','ELIGIBLE')) AND ($6::text IS NULL OR id>$6) ORDER BY id LIMIT $7`,[q.owner,q.chainId,q.accounts??null,q.executor??null,q.activeOnly??false,q.after??null,q.limit]);return rows.map(intent);}
  async requestCancellation(id:string,owner:Address,now:number){const{rows}=await this.pool.query("UPDATE app_intents SET status='CANCEL_REQUESTED',updated_at=$3 WHERE id=$1 AND owner=$2 AND status NOT IN ('MINED','CONFIRMED','CANCELLED','EXPIRED','INVALIDATED') RETURNING *",[id,owner,date(now)]);return rows[0]?intent(rows[0]):null;}
  async putAuthorization(a:KeeperAuthorization){try{const{rows}=await this.pool.query('INSERT INTO app_keeper_authorizations(id,owner,keeper,chain_id,accounts,valid_until,nonce,signature,revoked_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING *',[a.id,a.owner,a.keeper,a.chainId,a.accounts,a.validUntil,a.nonce,a.signature,a.revokedAt===null?null:date(a.revokedAt),date(a.createdAt)]);if(rows[0])return authorization(rows[0]);const old=await this.getAuthorization(a.id);if(!old||old.revokedAt!==null)throw new Error('AUTHORIZATION_NONCE_USED');return old;}catch(error){if((error as {code?:string}).code==='23505')throw new Error('AUTHORIZATION_NONCE_USED');throw error;}}
  async getAuthorization(id:string){const{rows}=await this.pool.query('SELECT * FROM app_keeper_authorizations WHERE id=$1',[id]);return rows[0]?authorization(rows[0]):null;}
  async listAuthorizations(owner:Address,chainId:number){const{rows}=await this.pool.query('SELECT * FROM app_keeper_authorizations WHERE owner=$1 AND chain_id=$2 ORDER BY created_at',[owner,chainId]);return rows.map(authorization);}
  async revokeAuthorization(id:string,owner:Address,now:number){const r=await this.pool.query('UPDATE app_keeper_authorizations SET revoked_at=$3 WHERE id=$1 AND owner=$2 AND revoked_at IS NULL',[id,owner,date(now)]);return r.rowCount===1;}
  async heartbeat(id:string,now:number){await this.pool.query('UPDATE app_keeper_authorizations SET last_heartbeat_at=$2 WHERE id=$1 AND revoked_at IS NULL',[id,date(now)]);}
  async putExecution(e:Execution){const{rows}=await this.pool.query('INSERT INTO app_executions(id,intent_id,chain_id,tx_hash,status,block_number,block_hash,receipt,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(chain_id,tx_hash,intent_id) DO NOTHING RETURNING *',[e.id,e.intentId,e.chainId,e.txHash,e.status,e.blockNumber,e.blockHash,e.receipt,date(e.createdAt),date(e.updatedAt)]);if(rows[0])return execution(rows[0]);const old=await this.pool.query('SELECT * FROM app_executions WHERE chain_id=$1 AND tx_hash=$2 AND intent_id=$3',[e.chainId,e.txHash,e.intentId]);return execution(old.rows[0]);}
  async listExecutions(owner:Address,chainId:number,account:Address|undefined,after:string|undefined,limit:number){const{rows}=await this.pool.query('SELECT e.* FROM app_executions e JOIN app_intents i ON i.id=e.intent_id WHERE i.owner=$1 AND i.chain_id=$2 AND ($3::text IS NULL OR i.account=$3) AND ($4::uuid IS NULL OR e.id>$4) ORDER BY e.id LIMIT $5',[owner,chainId,account??null,after??null,limit]);return rows.map(execution);}
  async appendAudit(a:AuditEvent){await this.pool.query('INSERT INTO app_audit(owner,action,entity_id,metadata,created_at) VALUES($1,$2,$3,$4,$5)',[a.owner,a.action,a.entityId,a.metadata,date(a.createdAt)]);}
  async enqueueJob(kind:string,key:string,payload:Record<string,unknown>,runAt:number){await this.pool.query('INSERT INTO app_jobs(id,kind,dedupe_key,payload,run_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),kind,key,payload,date(runAt)]);}
  async claimJobs(worker:string,now:number,limit:number):Promise<Job[]>{const{rows}=await this.pool.query(`WITH selected AS (SELECT id FROM app_jobs WHERE run_at<=$2 AND attempts<25
    AND (status='queued' OR (status='leased' AND locked_until<$2)) ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT $3)
    UPDATE app_jobs j SET status='leased',locked_by=$1,locked_until=$2+interval '60 seconds',attempts=j.attempts+1,updated_at=$2
    FROM selected WHERE j.id=selected.id RETURNING j.id,j.kind,j.payload,j.run_at,j.attempts`,[worker,date(now),limit]);return rows.map(r=>({id:r.id,kind:r.kind,payload:r.payload,runAt:ms(r.run_at)!,attempts:r.attempts}));}
  async finishJob(id:string,worker:string){await this.pool.query("UPDATE app_jobs SET status='done',locked_by=NULL,locked_until=NULL,updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='leased' AND locked_until>clock_timestamp()",[id,worker]);}
  async retryJob(id:string,worker:string,error:string,runAt:number){await this.pool.query("UPDATE app_jobs SET status=CASE WHEN attempts>=25 THEN 'failed' ELSE 'queued' END,run_at=$3,locked_by=NULL,locked_until=NULL,last_error=$4,updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='leased' AND locked_until>clock_timestamp()",[id,worker,date(runAt),error.slice(0,500)]);}
}
