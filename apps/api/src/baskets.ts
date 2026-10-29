import { Type } from '@sinclair/typebox';
import type { Address,Hex } from 'viem';
import { ApiError,authenticate,jsonify,normalize,ok,ownAccount,ownAccountControl,page,pageQuery } from './http.js';
import { AddressSchema,HashSchema,PaginationSchema,UintSchema,closed } from './schemas.js';
import type { AppContext } from './types.js';

const accountParams=closed({account:AddressSchema});
const actionSchema=closed({
 action:Type.Union(['deposit','withdraw','authorize','invalidate','emergencyClose','withdrawToken'].map(value => Type.Literal(value))),
 amount:Type.Optional(UintSchema),router:Type.Optional(AddressSchema),pools:Type.Optional(Type.Array(AddressSchema,{minItems:1,maxItems:8,uniqueItems:true})),
 approved:Type.Optional(Type.Boolean()),pool:Type.Optional(AddressSchema),quantity:Type.Optional(UintSchema),limitPrice:Type.Optional(UintSchema),
 expiryNs:Type.Optional(UintSchema),immediateOrCancel:Type.Optional(Type.Boolean()),token:Type.Optional(AddressSchema),
});
export function registerBasketRoutes(context:AppContext){
 const{app}=context;
 app.get('/v1/markets',{schema:{tags:['markets']}},async()=>ok({items:jsonify(await context.chain.markets())}));
 app.get<{Querystring:{limit?:number;cursor?:string}}>('/v1/baskets',{schema:{tags:['baskets'],querystring:PaginationSchema}},async req=>{const s=await authenticate(req,context,'owner');const q=pageQuery(req.query);return page(await context.store.listBaskets(s.owner,s.chainId,q.after,q.limit+1),q.limit);});
 app.post<{Body:{salt:Hex}}>('/v1/baskets/prepare',{schema:{tags:['baskets'],body:closed({salt:HashSchema})}},async req=>{const s=await authenticate(req,context,'owner');return ok(await context.chain.prepareCreate(s.owner,req.body.salt));});
 app.post<{Body:{account:Address;name:string}}>('/v1/baskets/register',{schema:{tags:['baskets'],body:closed({account:AddressSchema,name:Type.String({minLength:1,maxLength:80})})}},async(req,reply)=>{
  const s=await authenticate(req,context,'owner'),account=normalize(req.body.account);await ownAccountControl(account,s.owner,context);
  const value=await context.store.putBasket({id:`${s.chainId}:${account}`,owner:s.owner,account,chainId:s.chainId,name:req.body.name,createdAt:context.now()});return reply.code(201).send(ok(value));
 });
 app.get<{Params:{account:Address}}>('/v1/baskets/:account',{schema:{tags:['baskets'],params:accountParams}},async req=>{
  const s=await authenticate(req,context,'owner'),account=normalize(req.params.account);const snapshot=await ownAccount(account,s.owner,context);return ok({account,chainId:s.chainId,...await context.store.getBasket(s.chainId,account),snapshot:jsonify(snapshot)});
 });
 app.get<{Params:{account:Address}}>('/v1/baskets/:account/positions',{schema:{tags:['baskets'],params:accountParams}},async req=>{
  const s=await authenticate(req,context,'owner');const snapshot=await ownAccount(normalize(req.params.account),s.owner,context);return ok({items:jsonify(snapshot.positions),equity:snapshot.equity.toString(),initialMargin:snapshot.initialMargin.toString(),maintenanceMargin:snapshot.maintenanceMargin.toString()});
 });
 app.post<{Params:{account:Address};Body:Record<string,unknown>}>('/v1/baskets/:account/actions/prepare',{schema:{tags:['baskets'],params:accountParams,body:actionSchema}},async req=>{
  const s=await authenticate(req,context,'owner'),account=normalize(req.params.account);await ownAccountControl(account,s.owner,context);
  if(req.body.action==='authorize'&&normalize(String(req.body.router))!==normalize(context.config.router))throw new ApiError(400,'ROUTER_UNSUPPORTED','Only the configured router may be authorized through this API');
  return ok(await context.chain.prepareAccountAction(account,req.body));
 });
}
