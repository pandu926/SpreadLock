import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import rateLimit from '@fastify/rate-limit';
import { DomainError } from '../../../packages/domain/src/index.js';
import type { Store } from '../../../packages/db/src/types.js';
import { registerAuthRoutes } from './auth.js';
import { registerBasketRoutes } from './baskets.js';
import { registerIntentRoutes } from './intents.js';
import { registerKeeperRoutes } from './keepers.js';
import { ApiError,ok } from './http.js';
import type {ReadinessResult} from '../../indexer/src/readiness.js';
import type { ApiConfig,ChainGateway } from './types.js';
export async function buildApp(options:{store:Store;chain:ChainGateway;config:ApiConfig;now?:()=>number;entryReady?:()=>Promise<ReadinessResult>}){
 const{store,chain,config}=options;if(config.chainId!==chain.chainId)throw new Error('Chain configuration mismatch');
 const app=Fastify({bodyLimit:65536,ajv:{customOptions:{coerceTypes:false}},logger:config.logger?{level:'info',redact:['req.headers.authorization','req.body.signature','req.body.authorization.signature']}:false,trustProxy:config.development===true?false:(process.env.TRUST_PROXY_CIDRS?.split(',')??'127.0.0.1')});
 const context={app,store,chain,config,now:options.now??Date.now,entryReady:options.entryReady};
 await app.register(rateLimit,{max:config.rateLimitMax??120,timeWindow:60000});
 await app.register(swagger,{openapi:{info:{title:'SpreadLock API',version:'1.0.0',description:'Owner-authorized atomic perps baskets. The API never signs transactions.'},servers:[{url:config.baseUrl}],components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'}}}}});
 app.setErrorHandler((error,request,reply)=>{
  if(error instanceof ApiError)return reply.code(error.statusCode).send({success:false,error:{code:error.code,message:error.message}});
  if(error instanceof DomainError)return reply.code(400).send({success:false,error:{code:error.code,message:error.message}});
  if(error && typeof error === "object" && "validation" in error)return reply.code(400).send({success:false,error:{code:'VALIDATION_FAILED',message:'Request did not match the API schema'}});
  if(error && typeof error === "object" && "statusCode" in error && error.statusCode===429)return reply.code(429).send({success:false,error:{code:'RATE_LIMITED',message:'Request quota exceeded'}});
  if(error && typeof error === 'object' && 'statusCode' in error && [400,413,415].includes(Number(error.statusCode))){const status=Number(error.statusCode);return reply.code(status).send({success:false,error:{code:status===413?'PAYLOAD_TOO_LARGE':'INVALID_REQUEST',message:status===413?'Request body exceeds the allowed size':'Request body could not be parsed'}});}
  request.log.error({err:error},'Request failed');return reply.code(500).send({success:false,error:{code:'INTERNAL_ERROR',message:'The request could not be completed'}});
 });
 registerAuthRoutes(context);
 registerBasketRoutes(context);registerIntentRoutes(context);registerKeeperRoutes(context);
 let requests=0,errors=0;app.addHook('onResponse',async(_req,reply)=>{requests++;if(reply.statusCode>=500)errors++;});
 app.get('/health/live',async()=>ok({status:'live'}));
 app.get('/health/ready',async(_req,reply)=>{
  await Promise.all([store.ready(),chain.ready()]);
  const readiness:ReadinessResult=context.entryReady?await context.entryReady():{ready:true,reasons:[]};
  const data={status:readiness.ready?'ready':'not_ready',chainId:config.chainId,...(readiness.metrics?{metrics:readiness.metrics}:{})};
  if(!readiness.ready)return reply.code(503).send({success:false,error:{code:'NOT_READY',message:readiness.reasons.join('; ')},data});
  return ok(data);
 });
 app.get('/metrics',async(_req,reply)=>{
  const readiness:ReadinessResult=context.entryReady?await context.entryReady().catch(()=>({ready:false,reasons:['READINESS_UNAVAILABLE']})):{ready:true,reasons:[]};
  const gauge=(name:string,value:string|number)=>`# TYPE ${name} gauge\n${name} ${value}\n`;
  const metrics=readiness.metrics;
  return reply.type('text/plain; version=0.0.4').send(`# TYPE spreadlock_api_requests_total counter\nspreadlock_api_requests_total ${requests}\n# TYPE spreadlock_api_errors_total counter\nspreadlock_api_errors_total ${errors}\n`+
   gauge('spreadlock_entry_ready',readiness.ready?1:0)+(metrics?gauge('spreadlock_indexer_lag_blocks',metrics.lagBlocks)+gauge('spreadlock_indexer_lag_seconds',metrics.lagSeconds)+gauge('spreadlock_indexer_heartbeat_age_seconds',metrics.heartbeatAgeSeconds):''));
 });
 app.get('/v1/info',async()=>ok({version:'1.0.0',chainId:config.chainId,router:config.router,factory:config.factory,custody:'user-controlled',gasPayer:'user-keeper'}));
 app.get('/openapi.json',async()=>app.swagger());return app;
}
