import {afterEach,describe,expect,it,vi} from 'vitest';
import {decodeFunctionData,keccak256,type Address,type Hex} from 'viem';
import {routerAbi} from './codec.js';
import {ViemKeeperGateway} from './gateway.js';
import {keeperIntentHash} from './codec.js';
import type {KeeperRuntimeConfig} from './config.js';
import type {SignedIntent} from './types.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const owner=address(1),executor=address(2),account=address(3),router=address(4),pool=address(5),pool2=address(6);
function fixture(){
 const wire:SignedIntent['intent']={account,executor,nonce:'0',epoch:'0',expectedRevision:'0',expectedPositionsHash:hash(0),validAfter:'100',validUntil:'200',operation:0,
  legs:[{pool,delta:'10',limitPrice:'100',maxTakerFeeBpsTimes1k:5},{pool:pool2,delta:'-10',limitPrice:'90',maxTakerFeeBpsTimes1k:5}],minNetQuote:'0',triggerKind:0,triggerValue:'0',minPostEquity:'0',minPostHealthBps:20000};
 const envelope:SignedIntent={hash:keeperIntentHash(wire,50383,router),intent:wire,signature:'0x1234'};
 const config={manifest:{chainId:50383,router,factory:address(7),marketRegistry:address(8),markets:[pool,pool2]},rpcHttpUrl:'http://127.0.0.1:1',routerCodeHash:keccak256('0x1234'),authorization:{owner}} as KeeperRuntimeConfig;
 const gateway=new ViemKeeperGateway(config,executor),c=gateway.client;
 vi.spyOn(c,'getChainId').mockResolvedValue(50383);vi.spyOn(c,'getCode').mockResolvedValue('0x1234');vi.spyOn(c,'getBlock').mockResolvedValue({number:10n,timestamp:150n,hash:hash(10)} as never);
 vi.spyOn(c,'readContract').mockImplementation(async request=>{
  const name=request.functionName;
  if(name==='isAccount')return true;
  if(name==='owner')return owner;
  if(name==='epoch'||name==='revision')return 0n;
  if(name==='nonceUsed')return false;
  if(name==='positionsHash')return hash(0);
  if(name==='getBookLevels')return [{price:95n,quantity:5n},{price:96n,quantity:5n}];
  if(name==='getPerpPoolParameters')return {takerFeeBpsTimes1k:5n};
  if(name==='marketMetadata')return [1n,1n,1n,1n,5n];
  throw new Error(`Unexpected contract read: ${name}`);
 });
 vi.spyOn(c,'verifyTypedData').mockResolvedValue(true);vi.spyOn(c,'simulateContract').mockResolvedValue({} as never);vi.spyOn(c,'estimateContractGas').mockResolvedValue(100n);vi.spyOn(c,'estimateFeesPerGas').mockResolvedValue({maxFeePerGas:2n,maxPriorityFeePerGas:1n});
 return {gateway,c,config,envelope};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('independent keeper chain validation',()=>{
 it('retries an explicit FOK race at signed limits and encodes exactly those prices',async()=>{
  const {gateway,c,envelope}=fixture();envelope.intent={...envelope.intent,minNetQuote:'-200'};envelope.hash=keeperIntentHash(envelope.intent,50383,router);
  vi.mocked(c.simulateContract).mockRejectedValueOnce({cause:{data:'0xc04ad919'}});
  const prepared=await gateway.prepare(envelope);expect(prepared.prices).toEqual([100n,90n]);
  expect(decodeFunctionData({abi:routerAbi,data:prepared.data}).args?.[1]).toEqual([100n,90n]);
  expect(c.simulateContract).toHaveBeenCalledTimes(2);expect(c.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({args:[expect.anything(),[100n,90n],envelope.signature]}));
 });
 it('does not retry a non-FOK simulation failure',async()=>{
  const {gateway,c,envelope}=fixture();vi.mocked(c.simulateContract).mockRejectedValueOnce(new Error('health rejected'));
  await expect(gateway.prepare(envelope)).rejects.toThrow('health rejected');expect(c.simulateContract).toHaveBeenCalledOnce();expect(c.estimateContractGas).not.toHaveBeenCalled();
 });
 it('rejects fallback prices violating the signed combined quote bound before a second simulation',async()=>{
  const {gateway,c,envelope}=fixture();vi.mocked(c.simulateContract).mockRejectedValueOnce({data:{errorName:'FillOrKillNotFillable'}});
  await expect(gateway.prepare(envelope)).rejects.toThrow('QUOTE_BOUND');expect(c.simulateContract).toHaveBeenCalledOnce();expect(c.estimateContractGas).not.toHaveBeenCalled();
 });
 it('propagates a rejected fallback simulation without estimating or broadcasting',async()=>{
  const {gateway,c,envelope}=fixture();envelope.intent={...envelope.intent,minNetQuote:'-200'};envelope.hash=keeperIntentHash(envelope.intent,50383,router);
  vi.mocked(c.simulateContract).mockRejectedValueOnce({data:'0xc04ad919'}).mockRejectedValueOnce(new Error('QuoteTooLow'));
  await expect(gateway.prepare(envelope)).rejects.toThrow('QuoteTooLow');expect(c.simulateContract).toHaveBeenCalledTimes(2);expect(c.estimateContractGas).not.toHaveBeenCalled();
 });
 it('rejects fee metadata drift discovered during a FOK fallback',async()=>{
  const {gateway,c,envelope}=fixture(),read=vi.mocked(c.readContract).getMockImplementation()!;
  vi.mocked(c.simulateContract).mockRejectedValueOnce({data:'0xc04ad919'});
  vi.mocked(c.readContract).mockImplementation(async request=>request.functionName==='marketMetadata'?[1n,1n,1n,1n,6n]:read(request));
  await expect(gateway.prepare(envelope)).rejects.toThrow('FEE_LIMIT_EXCEEDED');expect(c.simulateContract).toHaveBeenCalledOnce();
 });
 it('binds all state and orderbook reads to one block before simulating and estimating',async()=>{
  const {gateway,c,envelope}=fixture();const prepared=await gateway.prepare(envelope);
  expect(prepared.prices).toEqual([96n,96n]);expect(prepared).toMatchObject({to:router,chainId:50383,value:0n,gasEstimate:100n});
  for(const [request] of vi.mocked(c.readContract).mock.calls)expect(request.blockNumber).toBe(10n);
  expect(c.verifyTypedData).toHaveBeenCalledWith(expect.objectContaining({address:account,blockNumber:10n}));expect(c.simulateContract).toHaveBeenCalledOnce();
 });
 it.each(['wrong chain','missing code','changed code'])('stops before any account read on %s',async reason=>{
  const {gateway,c,envelope}=fixture();if(reason==='wrong chain')vi.mocked(c.getChainId).mockResolvedValue(1);else vi.mocked(c.getCode).mockResolvedValue(reason==='missing code'?'0x':'0x5678');
  await expect(gateway.prepare(envelope)).rejects.toThrow('DEPLOYMENT_MISMATCH');expect(c.readContract).not.toHaveBeenCalled();
 });
 it.each([['isAccount',false,'INVALID_ACCOUNT_OR_SIGNATURE'],['owner',executor,'INVALID_ACCOUNT_OR_SIGNATURE'],['owner',address(99),'INVALID_ACCOUNT_OR_SIGNATURE'],['nonceUsed',true,'INTENT_INVALIDATED'],['epoch',1n,'INTENT_INVALIDATED'],['revision',1n,'STALE_POSITIONS'],['positionsHash',hash(2),'STALE_POSITIONS']])('rejects unsafe %s state',async(name,value,error)=>{
  const {gateway,c,envelope}=fixture(),read=vi.mocked(c.readContract).getMockImplementation()!;vi.mocked(c.readContract).mockImplementation(async request=>request.functionName===name?value:read(request));
  await expect(gateway.prepare(envelope)).rejects.toThrow(error as string);expect(c.simulateContract).not.toHaveBeenCalled();
 });
 it('rejects invalid signatures and waits for a future revision without permanently invalidating it',async()=>{
  const {gateway,c,envelope}=fixture();vi.mocked(c.verifyTypedData).mockResolvedValue(false);await expect(gateway.prepare(envelope)).rejects.toThrow('INVALID_ACCOUNT_OR_SIGNATURE');
  vi.mocked(c.verifyTypedData).mockResolvedValue(true);envelope.intent={...envelope.intent,expectedRevision:'1'};envelope.hash=keeperIntentHash(envelope.intent,50383,router);
  await expect(gateway.prepare(envelope)).rejects.toMatchObject({code:'WAITING_DEPENDENCY',permanent:false});
 });
 it.each([99n,200n])('enforces chain time validity at %s',async timestamp=>{const {gateway,c,envelope}=fixture();vi.mocked(c.getBlock).mockResolvedValue({number:10n,timestamp} as never);await expect(gateway.prepare(envelope)).rejects.toThrow(timestamp===99n?'NOT_YET_VALID':'EXPIRED');expect(c.readContract).not.toHaveBeenCalled();});
 it.each(['unpinned','fee','depth','price'])('rejects %s execution inputs before simulation',async reason=>{
  const {gateway,c,config,envelope}=fixture();const original=vi.mocked(c.readContract).getMockImplementation()!;
  if(reason==='unpinned')config.manifest.markets=[];
  vi.mocked(c.readContract).mockImplementation(async request=>{
   if(reason==='fee'&&request.functionName==='getPerpPoolParameters')return {takerFeeBpsTimes1k:6n};
   if(request.functionName==='getBookLevels'&&reason==='depth')return [{price:95n,quantity:9n}];
   if(request.functionName==='getBookLevels'&&reason==='price')return [{price:101n,quantity:10n}];
   return original(request);
  });
  await expect(gateway.prepare(envelope)).rejects.toThrow(reason==='unpinned'?'MARKET_NOT_PINNED':reason==='fee'?'FEE_LIMIT_EXCEEDED':'INSUFFICIENT_EXECUTABLE_DEPTH');expect(c.simulateContract).not.toHaveBeenCalled();
 });
 it('distinguishes missing, orphaned and canonical receipts from transport failures',async()=>{
  const {gateway,c}=fixture();const get=vi.spyOn(c,'getTransactionReceipt');get.mockRejectedValueOnce(Object.assign(new Error('absent'),{name:'TransactionReceiptNotFoundError'}));expect(await gateway.getReceipt(hash(1))).toBeUndefined();
  get.mockRejectedValueOnce(new Error('RPC unavailable'));await expect(gateway.getReceipt(hash(1))).rejects.toThrow('RPC unavailable');
  get.mockResolvedValue({transactionHash:hash(1),blockNumber:10n,blockHash:hash(9),status:'success',gasUsed:100n,effectiveGasPrice:2n} as never);vi.spyOn(c,'getBlockNumber').mockResolvedValue(21n);expect(await gateway.getReceipt(hash(1))).toBeUndefined();
  get.mockResolvedValue({transactionHash:hash(1),blockNumber:10n,blockHash:hash(10),status:'success',gasUsed:100n,effectiveGasPrice:2n} as never);expect(await gateway.getReceipt(hash(1))).toMatchObject({confirmations:12,gasUsed:100n});
 });
 it('rejects a receipt for another transaction or a node head behind its receipt',async()=>{
  const {gateway,c}=fixture();const get=vi.spyOn(c,'getTransactionReceipt').mockResolvedValue({transactionHash:hash(2),blockNumber:10n,blockHash:hash(10),status:'success',gasUsed:100n,effectiveGasPrice:2n} as never);vi.spyOn(c,'getBlockNumber').mockResolvedValue(21n);
  await expect(gateway.getReceipt(hash(1))).rejects.toThrow(/receipt/i);
  get.mockResolvedValue({transactionHash:hash(1),blockNumber:10n,blockHash:hash(10),status:'success',gasUsed:100n,effectiveGasPrice:2n} as never);vi.mocked(c.getBlockNumber).mockResolvedValue(9n);await expect(gateway.getReceipt(hash(1))).rejects.toThrow(/head/i);
 });

 it('checks pinned dependency implementation fingerprints before execution',async()=>{
  const {gateway,c,config}=fixture();config.manifest.fingerprints={[pool]:{codeHash:keccak256('0x1234')}};
  vi.spyOn(c,'getBlockNumber').mockResolvedValue(10n);vi.spyOn(c,'getStorageAt').mockResolvedValue(hash(0));await expect(gateway.assertDeployment()).resolves.toBeUndefined();
  config.manifest.fingerprints={[pool]:{codeHash:keccak256('0x5678')}};await expect(gateway.assertDeployment()).rejects.toThrow('PROTOCOL_IMPLEMENTATION_CHANGED');
 });
 it('uses only the configured executor nonce and broadcasts the exact durable bytes',async()=>{
  const {gateway,c}=fixture();vi.spyOn(c,'getTransactionCount').mockResolvedValue(7);vi.spyOn(c,'sendRawTransaction').mockResolvedValue(hash(1));expect(await gateway.getPendingNonce(executor)).toBe(7);expect(c.getTransactionCount).toHaveBeenCalledWith({address:executor,blockTag:'pending'});
  expect(await gateway.broadcast('0x1234')).toBe(hash(1));expect(c.sendRawTransaction).toHaveBeenCalledWith({serializedTransaction:'0x1234'});
 });
 it('bounds websocket wakeups to subscriptions and ignores notifications after shutdown',()=>{
  class Socket extends EventTarget{static instances:Socket[]=[];sent:string[]=[];closed=false;constructor(readonly url:string){super();Socket.instances.push(this);}send(value:string){this.sent.push(value);}close(){this.closed=true;}}
  vi.stubGlobal('WebSocket',Socket);const {gateway,config}=fixture();gateway.watch(vi.fn())();expect(Socket.instances).toEqual([]);config.rpcWsUrl='wss://rpc.example';const wake=vi.fn(),stop=gateway.watch(wake),socket=Socket.instances[0]!;
  socket.dispatchEvent(new Event('open'));expect(JSON.parse(socket.sent[0]!)).toMatchObject({method:'eth_subscribe',params:['somnia_watch',{address:[pool,pool2],eth_calls:[]}]});
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({result:'subscription-id'})}));expect(wake).not.toHaveBeenCalled();socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'eth_subscription'})}));expect(wake).toHaveBeenCalledOnce();stop();socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'eth_subscription'})}));expect(wake).toHaveBeenCalledOnce();expect(socket.closed).toBe(true);
 });
 it.each(['malformed','RPC error','transport error'])('closes a failed websocket so HTTP polling remains the fallback: %s',kind=>{
  class Socket extends EventTarget{static instance:Socket;closed=false;constructor(){super();Socket.instance=this;}send(){}close(){this.closed=true;}}
  vi.stubGlobal('WebSocket',Socket);const {gateway,config}=fixture();config.rpcWsUrl='wss://rpc.example';const wake=vi.fn(),stop=gateway.watch(wake),socket=Socket.instance;
  socket.dispatchEvent(kind==='transport error'?new Event('error'):new MessageEvent('message',{data:kind==='malformed'?'not-json':JSON.stringify({error:{message:'not supported'}})}));expect(socket.closed).toBe(true);expect(wake).not.toHaveBeenCalled();stop();
 });

});
