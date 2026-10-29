import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {keccak256,type Address,type Hex} from 'viem';
import {createChainClient} from '../src/rpc.js';

const address='0x0000000000000000000000000000000000000011' as Address;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const rawLog=()=>({address,blockNumber:'0x1',blockHash:hash(1),transactionHash:hash(2),transactionIndex:'0x0',logIndex:'0x0',removed:false,topics:[hash(3)],data:'0x1234'});
const rawBlock=()=>({number:'0x1',hash:hash(1),parentHash:hash(0),timestamp:'0x3e8',gasLimit:'0x5f5e100',gasUsed:'0x0',miner:address,extraData:'0x',transactions:[],baseFeePerGas:'0x1',difficulty:'0x0',totalDifficulty:'0x0',nonce:'0x0000000000000000',size:'0x1',logsBloom:`0x${'0'.repeat(512)}`,sha3Uncles:hash(4),receiptsRoot:hash(5),stateRoot:hash(6),transactionsRoot:hash(7),uncles:[]});
describe('JSON-RPC indexer adapter over real HTTP transport',()=>{
  let server:Server,url:string;
  let calls:{method:string;params:unknown[]}[]=[];
  let requestWidths:number[]=[];
  let respond:(method:string,params:unknown[])=>unknown;
  beforeAll(async()=>{
    server=createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      type Request={id:number;method:string;params?:unknown[]};
      const payload=JSON.parse(body) as Request|Request[];
      const requests=Array.isArray(payload)?payload:[payload];requestWidths.push(requests.length);
      res.setHeader('content-type','application/json');
      const responses=requests.map(request=>{
        calls.push({method:request.method,params:request.params??[]});
        try{return{jsonrpc:'2.0',id:request.id,result:respond(request.method,request.params??[])};}
        catch{return{jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'method deliberately unavailable'}};}
      });
      // JSON-RPC permits unordered batch responses: clients must correlate IDs.
      res.end(JSON.stringify(Array.isArray(payload)?responses.reverse():responses[0]));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');const bound=server.address();
    if(!bound||typeof bound==='string')throw new Error('Expected TCP listener');url=`http://127.0.0.1:${bound.port}`;
  });
  beforeEach(()=>{
    calls=[];requestWidths=[];respond=method=>{
      switch(method){case'eth_chainId':return'0xc4cf';case'eth_blockNumber':return'0x1';case'eth_getBlockByNumber':return rawBlock();case'eth_getLogs':return[rawLog()];case'eth_getCode':return'0x60006000';case'eth_getTransactionReceipt':return{transactionHash:hash(2),blockHash:hash(1),blockNumber:'0x1',from:address,to:address,contractAddress:null,transactionIndex:'0x0',gasUsed:'0x5208',cumulativeGasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[],logsBloom:`0x${'0'.repeat(512)}`,status:'0x1',type:'0x2'};default:throw new Error('unexpected method');}
    };
  });
  afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  it('reads chain identity and uncached head on every call',async()=>{
    const rpc=createChainClient(url);expect(await rpc.chainId()).toBe(50383);
    let head=1;respond=()=>`0x${(head++).toString(16)}`;
    expect(await rpc.head()).toBe(1n);expect(await rpc.head()).toBe(2n);
    expect(calls.map(c=>c.method)).toEqual(['eth_chainId','eth_blockNumber','eth_blockNumber']);
  });
  it('pins block requests to the requested height and preserves header identity',async()=>{
    expect(await createChainClient(url).block(1n)).toEqual({number:1n,hash:hash(1),parentHash:hash(0),timestamp:1000n});
    expect(calls).toEqual([{method:'eth_getBlockByNumber',params:['0x1',false]}]);
  });
  it('batches concurrent pinned headers into at most16 requests and matches unordered responses',async()=>{
    respond=(method,params)=>{
      if(method!=='eth_getBlockByNumber')throw new Error('Expected pinned block request');
      const number=Number(BigInt(params[0] as string));
      return{...rawBlock(),number:params[0],hash:hash(number),parentHash:hash(number-1),timestamp:`0x${(1000+number).toString(16)}`};
    };
    const rpc=createChainClient(url);const headers=await Promise.all(Array.from({length:33},(_,i)=>rpc.block(BigInt(i+1))));
    expect([...requestWidths].sort((a,b)=>a-b)).toEqual([1,16,16]);expect(calls).toHaveLength(33);
    expect(headers.map(h=>[h.number,h.hash,h.timestamp])).toEqual(Array.from({length:33},(_,i)=>[BigInt(i+1),hash(i+1),BigInt(1001+i)]));
  });
  it('does not issue an unbounded log request for an empty address set',async()=>{
    expect(await createChainClient(url).logs(1n,2n,[])).toEqual([]);expect(calls).toEqual([]);
  });
  it('pins log range and addresses while preserving financial event fields',async()=>{
    expect(await createChainClient(url).logs(1n,2n,[address])).toEqual([{address,blockNumber:1n,blockHash:hash(1),transactionHash:hash(2),logIndex:0,topics:[hash(3)],data:'0x1234'}]);
    expect(calls[0]).toEqual({method:'eth_getLogs',params:[{address:[address],fromBlock:'0x1',toBlock:'0x2',topics:[]}]});
  });
  it('excludes removed, pending and partially identified logs',async()=>{
    respond=()=>[{...rawLog(),removed:true},{...rawLog(),blockNumber:null},{...rawLog(),blockHash:null},{...rawLog(),transactionHash:null},{...rawLog(),logIndex:null},rawLog()];
    expect(await createChainClient(url).logs(1n,2n,[address])).toHaveLength(1);
  });
  it('returns receipt evidence with normalized status and pinned transaction hash',async()=>{
    expect(await createChainClient(url).receipt(hash(2))).toMatchObject({transactionHash:hash(2),blockHash:hash(1),status:'success',blockNumber:1n,gasUsed:21000n});
    expect(calls[0]).toEqual({method:'eth_getTransactionReceipt',params:[hash(2)]});
  });
  it('hashes deployed bytecode with Ethereum keccak',async()=>{
    expect(await createChainClient(url).codeHash!(address)).toBe(keccak256('0x60006000'));
    expect(calls[0]).toEqual({method:'eth_getCode',params:[address,'latest']});
  });
  it('rejects addresses without deployed bytecode',async()=>{
    respond=()=> '0x';await expect(createChainClient(url).codeHash!(address)).rejects.toThrow('Missing contract');
  });
  it('propagates RPC failures without fabricating a head or successful receipt',async()=>{
    respond=()=>{throw new Error('offline');};
    await expect(createChainClient(url).head()).rejects.toThrow();
    expect(calls.every(c=>c.method==='eth_blockNumber')).toBe(true);
  });
});
