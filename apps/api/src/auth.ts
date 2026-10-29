import { randomBytes,randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { createSiweMessage } from 'viem/siwe';
import { getAddress,type Address,type Hex } from 'viem';
import type { Challenge,KeeperAuthorization } from '../../../packages/db/src/types.js';
import { ApiError,authenticate,hashToken,normalize,ok,ownAccountControl } from './http.js';
import { AddressSchema,AuthorizationSchema,SignatureSchema,closed } from './schemas.js';
import { keeperAuthorizationId,keeperTypedData,type KeeperCertificate } from './keeper-auth.js';
import type { AppContext } from './types.js';
export async function issueChallenge(context:AppContext,params:{owner:Address;signer:Address;role:'owner'|'keeper';authorizationId:string|null}){
 const now=context.now(),expiresAt=now+300000,base=new URL(context.config.baseUrl);
 const challenge:Challenge={id:randomUUID(),owner:normalize(params.owner),signer:normalize(params.signer),chainId:context.config.chainId,role:params.role,authorizationId:params.authorizationId,expiresAt,consumedAt:null,
 message:createSiweMessage({domain:base.host,address:getAddress(params.signer),statement:params.role==='owner'?'Sign in to SpreadLock. This does not authorize trading.':`Sign in as a SpreadLock keeper for authorization ${params.authorizationId}. This does not create a trading intent.`,uri:base.href,version:'1',chainId:context.config.chainId,nonce:randomBytes(16).toString('hex'),issuedAt:new Date(now),expirationTime:new Date(expiresAt)})};
 await context.store.createChallenge(challenge);return{challengeId:challenge.id,message:challenge.message,expiresAt:new Date(expiresAt).toISOString()};
}
async function verifyChallenge(context:AppContext,body:{challengeId:string;signature:Hex},role:'owner'|'keeper'){
 const challenge=await context.store.getChallenge(body.challengeId);
 if(!challenge||challenge.role!==role||challenge.consumedAt!==null||challenge.expiresAt<=context.now())throw new ApiError(401,'CHALLENGE_INVALID','Challenge expired, consumed, or invalid');
 if(role==='keeper'){
  const cert=challenge.authorizationId?await context.store.getAuthorization(challenge.authorizationId):null;
  if(!cert||cert.revokedAt!==null||BigInt(cert.validUntil)<=BigInt(Math.floor(context.now()/1000)))throw new ApiError(401,'KEEPER_REVOKED','Keeper authorization is no longer active');
 }
 if(!await context.chain.verifyMessage(challenge.signer,challenge.message,body.signature))throw new ApiError(401,'SIGNATURE_INVALID','Signature is invalid');
 if(!await context.store.consumeChallenge(challenge.id,context.now()))throw new ApiError(401,'CHALLENGE_INVALID','Challenge already consumed');
 const token=randomBytes(32).toString('base64url');let expiresAt=context.now()+1800000;
 if(challenge.authorizationId){const cert=await context.store.getAuthorization(challenge.authorizationId);expiresAt=Math.min(expiresAt,Number(BigInt(cert!.validUntil)*1000n));}
 await context.store.createSession({tokenHash:hashToken(token),owner:challenge.owner,signer:challenge.signer,chainId:challenge.chainId,role,authorizationId:challenge.authorizationId,expiresAt});
 await context.store.appendAudit({owner:challenge.owner,action:`auth.${role}.login`,entityId:challenge.id,metadata:{},createdAt:context.now()});return{token,expiresAt:new Date(expiresAt).toISOString(),owner:challenge.owner,role};
}
export async function registerAuthorization(context:AppContext,cert:KeeperCertificate,expectedOwner?:Address):Promise<KeeperAuthorization>{
 const now=BigInt(Math.floor(context.now()/1000));
 if(cert.chainId!==context.config.chainId||BigInt(cert.validUntil)<=now||BigInt(cert.validUntil)>now+2592000n||BigInt(cert.validUntil)>=2n**64n||BigInt(cert.nonce)>=2n**256n)throw new ApiError(400,'AUTHORIZATION_INVALID','Authorization chain, expiry, or nonce is invalid');
 if(expectedOwner&&normalize(cert.owner)!==normalize(expectedOwner))throw new ApiError(403,'FORBIDDEN','Cannot authorize another owner');
 const accounts=cert.accounts.map(normalize);if(new Set(accounts).size!==accounts.length)throw new ApiError(400,'AUTHORIZATION_INVALID','Accounts must be unique');
 for(const account of accounts)await ownAccountControl(account,normalize(cert.owner),context);
 if(!await context.chain.verifyTypedData(cert.owner,keeperTypedData(cert,context.config.router),cert.signature))throw new ApiError(401,'SIGNATURE_INVALID','Keeper authorization signature is invalid');
 try{return await context.store.putAuthorization({id:keeperAuthorizationId(cert,context.config.router),owner:normalize(cert.owner),keeper:normalize(cert.keeper),accounts,chainId:cert.chainId,validUntil:cert.validUntil,nonce:cert.nonce,signature:cert.signature,revokedAt:null,createdAt:context.now()});}catch(error){if((error as Error).message==='AUTHORIZATION_NONCE_USED')throw new ApiError(409,'AUTHORIZATION_NONCE_USED','Authorization nonce is used or revoked');throw error;}
}
export function registerAuthRoutes(context:AppContext){
 const{app}=context;const verifySchema=closed({challengeId:Type.String({format:'uuid'}),signature:SignatureSchema});
 app.post<{Body:{address:Address;chainId:number}}>('/v1/auth/challenge',{schema:{tags:['auth'],body:closed({address:AddressSchema,chainId:Type.Integer({minimum:1})})}},async(req,reply)=>{
  if(req.body.chainId!==context.config.chainId)throw new ApiError(400,'CHAIN_UNSUPPORTED','Unsupported chain');return reply.code(201).send(ok(await issueChallenge(context,{owner:req.body.address,signer:req.body.address,role:'owner',authorizationId:null})));
 });
 app.post<{Body:{challengeId:string;signature:Hex}}>('/v1/auth/verify',{schema:{tags:['auth'],body:verifySchema}},async req=>ok(await verifyChallenge(context,req.body,'owner')));
 app.delete('/v1/auth/session',async req=>{await authenticate(req,context);await context.store.deleteSession(hashToken(req.headers.authorization!.slice(7)));return ok({revoked:true});});
 app.post<{Body:{authorization:KeeperCertificate}}>('/v1/keeper/session/challenge',{schema:{tags:['keeper'],body:closed({authorization:AuthorizationSchema})}},async(req,reply)=>{const cert=await registerAuthorization(context,req.body.authorization);return reply.code(201).send(ok(await issueChallenge(context,{owner:cert.owner,signer:cert.keeper,role:'keeper',authorizationId:cert.id})));});
 app.post<{Body:{challengeId:string;signature:Hex}}>('/v1/keeper/session',{schema:{tags:['keeper'],body:verifySchema}},async req=>ok(await verifyChallenge(context,req.body,'keeper')));
 app.post<{Body:KeeperCertificate}>('/v1/keepers/authorizations',{schema:{tags:['keeper'],body:AuthorizationSchema}},async(req,reply)=>{const session=await authenticate(req,context,'owner');return reply.code(201).send(ok(await registerAuthorization(context,req.body,session.owner)));});
 app.get('/v1/keepers/authorizations',async req=>{const s=await authenticate(req,context,'owner');return ok({items:await context.store.listAuthorizations(s.owner,s.chainId)});});
 app.delete<{Params:{id:string}}>('/v1/keepers/authorizations/:id',{schema:{params:closed({id:Type.String({pattern:'^0x[0-9a-fA-F]{64}$'})})}},async req=>{const s=await authenticate(req,context,'owner');if(!await context.store.revokeAuthorization(req.params.id.toLowerCase(),s.owner,context.now()))throw new ApiError(404,'NOT_FOUND','Authorization was not found');return ok({revoked:true,onChainCancellationRequired:true});});
}
