import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import type { Session } from '../../../packages/db/src/types.js';
import type { AppContext } from './types.js';
export class ApiError extends Error { constructor(public readonly statusCode:number,public readonly code:string,message:string){super(message);} }
export const normalize=(address:string)=>address.toLowerCase() as Address;
export const hashToken=(token:string)=>createHash('sha256').update(token).digest('hex');
export function ok<T>(data:T){return{success:true,data};}
export function page<T extends {id:string}>(rows:T[],limit:number){return ok({items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1]!.id:null});}
export function pageQuery(query:{limit?:number;cursor?:string}){return{limit:Math.min(query.limit??50,100),after:query.cursor};}
export async function authenticate(request:FastifyRequest,context:AppContext,role?:'owner'|'keeper'):Promise<Session>{
 const authorization=request.headers.authorization;
 if(!authorization?.startsWith('Bearer '))throw new ApiError(401,'UNAUTHORIZED','A bearer session is required');
 const token=authorization.slice(7);
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(401,'UNAUTHORIZED','Session is invalid');
 const session=await context.store.getSession(hashToken(token));
 if(!session||session.expiresAt<=context.now()||session.chainId!==context.config.chainId)throw new ApiError(401,'UNAUTHORIZED','Session expired or invalid');
 if(role&&session.role!==role)throw new ApiError(403,'FORBIDDEN','Session does not permit this operation');
 if(session.role==='keeper'){
  const cert=session.authorizationId?await context.store.getAuthorization(session.authorizationId):null;
  if(!cert||cert.revokedAt!==null||BigInt(cert.validUntil)<=BigInt(Math.floor(context.now()/1000)))throw new ApiError(401,'KEEPER_REVOKED','Keeper authorization expired or revoked');
 }
 return session;
}
export async function ownAccount(account:Address,owner:Address,context:AppContext){const snapshot=await context.chain.account(account);if(normalize(snapshot.owner)!==normalize(owner))throw new ApiError(404,'NOT_FOUND','Basket was not found');return snapshot;}
export function jsonify(value:unknown):unknown{return JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));}

export async function ownAccountControl(account:Address,owner:Address,context:AppContext){const actual=context.chain.ownerOf?await context.chain.ownerOf(account):(await context.chain.account(account)).owner;if(normalize(actual)!==normalize(owner))throw new ApiError(404,'NOT_FOUND','Basket was not found');return actual;}
