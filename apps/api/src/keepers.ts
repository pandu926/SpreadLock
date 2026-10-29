import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { Hex,Address } from 'viem';
import { ApiError,authenticate,normalize,ok,page,pageQuery } from './http.js';
import { HashSchema,PaginationSchema,AddressSchema,LimitSchema,closed } from './schemas.js';
import type { AppContext } from './types.js';

export function registerKeeperRoutes(context:AppContext){
 const{app}=context;
 app.get<{Querystring:{limit?:number;cursor?:string}}>('/v1/keeper/intents',{schema:{tags:['keeper'],querystring:PaginationSchema}},async req=>{
  const s=await authenticate(req,context,'keeper'),q=pageQuery(req.query),cert=await context.store.getAuthorization(s.authorizationId!);if(!cert)throw new ApiError(401,'KEEPER_REVOKED','Keeper authorization unavailable');
  const rows=await context.store.listIntents({owner:s.owner,chainId:s.chainId,accounts:cert.accounts,executor:s.signer,activeOnly:true,after:q.after,limit:q.limit+1});
  return ok({items:rows.slice(0,q.limit).map(r=>({hash:r.id,intent:r.body,signature:r.signature})),nextCursor:rows.length>q.limit?rows[q.limit-1]!.id:null});
 });
 app.post('/v1/keeper/heartbeat',{schema:{tags:['keeper'],body:closed({})}},async req=>{const s=await authenticate(req,context,'keeper');await context.store.heartbeat(s.authorizationId!,context.now());return ok({accepted:true,serverTime:new Date(context.now()).toISOString()});});
 app.post<{Body:{hash:Hex;txHash:Hex}}>('/v1/keeper/executions',{schema:{tags:['keeper'],body:closed({hash:HashSchema,txHash:HashSchema})}},async(req,reply)=>{
  const s=await authenticate(req,context,'keeper'),i=await context.store.getIntent(req.body.hash.toLowerCase()),cert=await context.store.getAuthorization(s.authorizationId!);
  if(!i||!cert||i.owner!==s.owner||i.chainId!==s.chainId||i.executor!==s.signer||!cert.accounts.includes(i.account))throw new ApiError(404,'NOT_FOUND','Assigned intent was not found');
  const proof=await context.chain.execution(req.body.txHash,req.body.hash,s.signer);
  const record=await context.store.putExecution({id:randomUUID(),intentId:i.id,chainId:s.chainId,txHash:req.body.txHash.toLowerCase() as Hex,status:proof.status,blockNumber:proof.blockNumber,blockHash:proof.blockHash,receipt:proof.receipt,createdAt:context.now(),updatedAt:context.now()});
  await context.store.enqueueJob('execution.reconcile',`${s.chainId}:${record.txHash}`,{hash:i.id,txHash:record.txHash},context.now());return reply.code(202).send(ok(record));
 });
 app.get<{Querystring:{account?:Address;cursor?:string;limit?:number}}>('/v1/executions',{schema:{tags:['executions'],querystring:closed({account:Type.Optional(AddressSchema),cursor:Type.Optional(Type.String({format:'uuid'})),limit:Type.Optional(LimitSchema)})}},async req=>{
  const s=await authenticate(req,context,'owner'),q=pageQuery(req.query);return page(await context.store.listExecutions(s.owner,s.chainId,req.query.account?normalize(req.query.account):undefined,q.after,q.limit+1),q.limit);
 });
}
