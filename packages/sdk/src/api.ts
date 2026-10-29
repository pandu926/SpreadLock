import type {Address,Hex} from 'viem';
import type {WireIntent} from '../../domain/src/index.js';
export class ApiResponseError extends Error {
 constructor(readonly status:number,readonly code:string,message:string){super(message);this.name='ApiResponseError';}
}
/** HTTP-only API client. Signing and encrypted keys stay with the caller. */
export class SpreadLockApiClient {
 private token?:string;
 private readonly base:URL;
 constructor(baseUrl:string,private readonly fetcher:typeof fetch=fetch){
  this.base=new URL(baseUrl);
  if(this.base.username||this.base.password||!['https:','http:'].includes(this.base.protocol)||
    (this.base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(this.base.hostname)))throw new Error('API requires HTTPS or loopback HTTP');
 }
 setSession(token:string):void{if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Invalid bearer session');this.token=token;}
 async request<T>(method:'GET'|'POST'|'DELETE',path:string,body?:unknown,authenticated=true):Promise<T>{
  if(!path.startsWith('/v1/')||path.includes('..')||path.includes('://'))throw new Error('Invalid API path');
  if(authenticated&&!this.token)throw new ApiResponseError(401,'NO_SESSION','Owner or keeper session required');
  const response=await this.fetcher(new URL(path,this.base),{method,redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(authenticated?{authorization:`Bearer ${this.token}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.body)throw new Error('Empty API response');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000){await reader.cancel();throw new Error('API response too large');}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const envelope=JSON.parse(new TextDecoder().decode(bytes)) as {success:boolean;data:T;error?:{code?:string;message?:string}};
  if(!response.ok||!envelope.success){if(response.status===401)this.token=undefined;throw new ApiResponseError(response.status,envelope.error?.code??'API_ERROR',envelope.error?.message??'API request failed');}
  return envelope.data;
 }
 challenge(address:Address,chainId:number){return this.request<{challengeId:string;message:string;expiresAt:string}>('POST','/v1/auth/challenge',{address,chainId},false);}
 async verify(challengeId:string,signature:Hex){const result=await this.request<{token:string;expiresAt:string}>('POST','/v1/auth/verify',{challengeId,signature},false);this.setSession(result.token);return result;}
 async logout(){try{return await this.request('DELETE','/v1/auth/session');}finally{this.token=undefined;}}
 markets(){return this.request<{items:unknown[]}>('GET','/v1/markets',undefined,false);}
 baskets(){return this.request<{items:unknown[];nextCursor:string|null}>('GET','/v1/baskets');}
 createAccount(salt:Hex){return this.request<{to:Address;data:Hex;value:string;account:Address}>('POST','/v1/baskets/prepare',{salt});}
 registerBasket(account:Address,name:string){return this.request('POST','/v1/baskets/register',{account,name});}
 basket(account:Address){return this.request('GET',`/v1/baskets/${account}`);}
 prepareAction(account:Address,action:Record<string,unknown>){return this.request<{to:Address;data:Hex;value:string}>('POST',`/v1/baskets/${account}/actions/prepare`,action);}
 quote(intent:WireIntent){return this.request('POST','/v1/quotes',{intent});}
 prepareIntent(intent:Partial<WireIntent>&Pick<WireIntent,'account'|'executor'|'nonce'|'operation'|'legs'>){return this.request<{intent:WireIntent;hash:Hex;typedData:unknown;quote:unknown}>('POST','/v1/intents/prepare',intent);}
 submitIntent(intent:WireIntent,signature:Hex){return this.request<{hash:Hex;status:string;simulation:unknown}>('POST','/v1/intents',{intent,signature});}
 intent(hash:Hex){return this.request('GET',`/v1/intents/${hash}`);}
 cancelIntent(hash:Hex){return this.request<{status:'CANCEL_REQUESTED';transaction:{to:Address;data:Hex;value:string}}>('POST',`/v1/intents/${hash}/cancel/prepare`,{});}
 executions(){return this.request<{items:unknown[];nextCursor:string|null}>('GET','/v1/executions');}
}
