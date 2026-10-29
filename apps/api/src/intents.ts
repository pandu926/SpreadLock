import { Type } from '@sinclair/typebox';
import type { Address,Hex } from 'viem';
import { getIntentTypedData,hashIntent,parseIntent,serializeIntent,DomainError,type WireIntent } from '../../../packages/domain/src/index.js';
import { ApiError,authenticate,jsonify,normalize,ok,ownAccount,ownAccountControl,page,pageQuery } from './http.js';
import { AddressSchema,HashSchema,IntentSchema,LegSchema,PaginationSchema,SignatureSchema,UintSchema,IntSchema,closed } from './schemas.js';
import type { AppContext } from './types.js';

const prepareSchema=closed({account:AddressSchema,executor:AddressSchema,nonce:UintSchema,operation:Type.Integer({minimum:0,maximum:2}),legs:Type.Array(LegSchema,{minItems:1,maxItems:8}),
 epoch:Type.Optional(UintSchema),expectedRevision:Type.Optional(UintSchema),expectedPositionsHash:Type.Optional(HashSchema),validAfter:Type.Optional(UintSchema),validUntil:Type.Optional(UintSchema),minNetQuote:Type.Optional(IntSchema),triggerKind:Type.Optional(Type.Integer({minimum:0,maximum:2})),triggerValue:Type.Optional(IntSchema),minPostEquity:Type.Optional(UintSchema),minPostHealthBps:Type.Optional(Type.Integer({minimum:0,maximum:4294967295}))});
async function entryGate(context:AppContext,operation:number){if(operation!==2&&context.entryReady){const result=await context.entryReady();if(!result.ready)throw new ApiError(503,'ENTRY_SUSPENDED',result.reasons.join('; ')||'Indexer or compatibility checks are not ready');}}
export function registerIntentRoutes(context:AppContext){
 const{app}=context;
 app.post<{Body:{intent:WireIntent}}>('/v1/quotes',{schema:{tags:['quotes'],body:closed({intent:IntentSchema})}},async req=>{
  const s=await authenticate(req,context,'owner'),i=parseIntent(req.body.intent);await ownAccount(i.account,s.owner,context);await entryGate(context,i.operation);return ok(await context.chain.quote(i.account,i.legs));
 });
 app.post<{Body:Partial<WireIntent> & Pick<WireIntent,'account'|'executor'|'nonce'|'operation'|'legs'>}>('/v1/intents/prepare',{schema:{tags:['intents'],body:prepareSchema}},async req=>{
  const s=await authenticate(req,context,'owner'),body=req.body,snapshot=await ownAccount(body.account,s.owner,context);await entryGate(context,body.operation);
  const now=Math.floor(context.now()/1000);let i=parseIntent({...body,epoch:body.epoch??snapshot.epoch.toString(),expectedRevision:body.expectedRevision??snapshot.revision.toString(),expectedPositionsHash:body.expectedPositionsHash??`0x${'00'.repeat(32)}`,validAfter:body.validAfter??String(now),validUntil:body.validUntil??String(now+86400),minNetQuote:body.minNetQuote??'0',triggerKind:body.triggerKind??0,triggerValue:body.triggerValue??'0',minPostEquity:body.minPostEquity??'0',minPostHealthBps:body.minPostHealthBps??20000});
  const quote=await context.chain.quote(i.account,i.legs);i={...i,expectedPositionsHash:body.expectedPositionsHash??await context.chain.positionsHash(i.account,i.legs),minNetQuote:body.minNetQuote===undefined?BigInt(quote.conservativeNetQuote):i.minNetQuote};
  return ok({intent:serializeIntent(i),hash:hashIntent(i,s.chainId,context.config.router),typedData:jsonify(getIntentTypedData(i,s.chainId,context.config.router)),quote});
 });
 app.post<{Body:{intent:WireIntent;signature:Hex}}>('/v1/intents',{schema:{tags:['intents'],body:closed({intent:IntentSchema,signature:SignatureSchema})}},async(req,reply)=>{
  const s=await authenticate(req,context,'owner'),i=parseIntent(req.body.intent),snapshot=await ownAccount(i.account,s.owner,context);await entryGate(context,i.operation);
  const now=BigInt(Math.floor(context.now()/1000));if(i.validUntil<=now)throw new ApiError(400,'INTENT_EXPIRED','Intent has expired');
  if(i.epoch!==snapshot.epoch||i.expectedRevision<snapshot.revision)throw new ApiError(409,'INTENT_STALE','Intent epoch or revision is stale');
  if(!await context.chain.verifyTypedData(i.account,getIntentTypedData(i,s.chainId,context.config.router),req.body.signature))throw new ApiError(401,'SIGNATURE_INVALID','Trading signature is invalid for the basket account');
  if(await context.chain.nonceUsed(i.account,i.epoch,i.nonce))throw new ApiError(409,'NONCE_USED','Intent nonce is invalidated or executed');
  const hash=hashIntent(i,s.chainId,context.config.router);const old=await context.store.getIntent(hash);
  if(old){if(old.owner!==s.owner)throw new ApiError(404,'NOT_FOUND','Intent was not found');return ok({hash:old.id,status:old.status,simulation:{status:'previously_accepted'}});}
  let status:'WAITING'|'ELIGIBLE'='WAITING',simulation:Record<string,unknown>={status:'deferred',reason:'future_revision_or_time'};
  if(i.expectedRevision===snapshot.revision){
   if((await context.chain.positionsHash(i.account,i.legs)).toLowerCase()!==i.expectedPositionsHash.toLowerCase())throw new ApiError(409,'POSITIONS_CHANGED','Position state no longer matches the signed intent');
   if(i.validAfter<=now){try{const quote=await context.chain.quote(i.account,i.legs);const result=await context.chain.simulate(i,req.body.signature,quote.executablePrices.map(BigInt));status='ELIGIBLE';simulation={status:'passed',...result,blockNumber:quote.blockNumber};}catch(error){if(error instanceof DomainError&&['LOT_SIZE','UNSUPPORTED_MARKET','INVALID_LEG','INVALID_QUOTE'].includes(error.code))throw error;simulation={status:'deferred',reason:error instanceof ApiError||error instanceof DomainError?error.code:'SIMULATION_REVERTED'};}}
  }
  const stored=await context.store.putIntent({id:hash,owner:s.owner,account:normalize(i.account),chainId:s.chainId,executor:normalize(i.executor),body:serializeIntent(i) as unknown as Record<string,unknown>,signature:req.body.signature,status,createdAt:context.now(),updatedAt:context.now()});
  await context.store.enqueueJob('intent.revalidate',hash,{hash},context.now());await context.store.appendAudit({owner:s.owner,action:'intent.submitted',entityId:hash,metadata:{status},createdAt:context.now()});
  return reply.code(stored.created?201:200).send(ok({hash,status:stored.value.status,simulation}));
 });
 app.get<{Querystring:{limit?:number;cursor?:string}}>('/v1/intents',{schema:{tags:['intents'],querystring:PaginationSchema}},async req=>{const s=await authenticate(req,context,'owner'),q=pageQuery(req.query);return page(await context.store.listIntents({owner:s.owner,chainId:s.chainId,after:q.after,limit:q.limit+1}),q.limit);});
 app.get<{Params:{hash:Hex}}>('/v1/intents/:hash',{schema:{tags:['intents'],params:closed({hash:HashSchema})}},async req=>{const s=await authenticate(req,context,'owner'),i=await context.store.getIntent(req.params.hash.toLowerCase());if(!i||i.owner!==s.owner||i.chainId!==s.chainId)throw new ApiError(404,'NOT_FOUND','Intent was not found');return ok(i);});
 app.post<{Params:{hash:Hex}}>('/v1/intents/:hash/cancel/prepare',{schema:{tags:['intents'],params:closed({hash:HashSchema}),body:closed({})}},async req=>{
  const s=await authenticate(req,context,'owner'),i=await context.store.getIntent(req.params.hash.toLowerCase());if(!i||i.owner!==s.owner||i.chainId!==s.chainId)throw new ApiError(404,'NOT_FOUND','Intent was not found');await ownAccountControl(i.account,s.owner,context);
  const transaction=await context.chain.prepareCancel(parseIntent(i.body));const updated=await context.store.requestCancellation(i.id,s.owner,context.now());if(!updated)throw new ApiError(409,'INTENT_TERMINAL','Intent is already terminal');
  return ok({hash:i.id,status:updated.status,transaction,warning:'Cancellation is effective only when the invalidation transaction is canonical. A competing execution may win.'});
 });
}
