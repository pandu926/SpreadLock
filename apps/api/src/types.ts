import type {ReadinessResult} from '../../indexer/src/readiness.js';
import type { FastifyInstance } from 'fastify';
import type { Address, Hex, TypedDataDefinition } from 'viem';
import type { Intent, Leg, MarketMetadata, Position } from '../../../packages/domain/src/index.js';
import type { Json, Store } from '../../../packages/db/src/types.js';
export interface ApiConfig { chainId:number; baseUrl:string; router:Address; factory:Address; logger?:boolean; rateLimitMax?:number; development?:boolean; }
export interface AccountSnapshot { owner:Address; epoch:bigint; revision:bigint; positions:Position[]; equity:bigint; initialMargin:bigint; maintenanceMargin:bigint; }
export interface QuoteResult { blockNumber:string; blockTimestamp:string; expiresAt:string; executablePrices:string[]; conservativeNetQuote:string; markNetQuote:string; markets:Json[]; simulationStatus:'not_signed'; }
export interface VerifiedExecution { txHash:Hex; status:'SUBMITTED'|'MINED'|'REVERTED'; blockNumber:string|null; blockHash:Hex|null; receipt:Json|null; }
export interface ChainGateway {
 readonly chainId:number;
 ready():Promise<void>;
 verifyMessage(address:Address,message:string,signature:Hex):Promise<boolean>;
 verifyTypedData(address:Address,typedData:TypedDataDefinition,signature:Hex):Promise<boolean>;
 account(account:Address):Promise<AccountSnapshot>;
 ownerOf?(account:Address):Promise<Address>;
 markets():Promise<Array<MarketMetadata & {entryEnabled:boolean}>>;
 positionsHash(account:Address,legs:Leg[]):Promise<Hex>;
 nonceUsed(account:Address,epoch:bigint,nonce:bigint):Promise<boolean>;
 quote(account:Address,legs:Leg[]):Promise<QuoteResult>;
 simulate(intent:Intent,signature:Hex,prices:bigint[]):Promise<{gas:string}>;
 prepareCreate(owner:Address,salt:Hex):Promise<Json>;
 prepareAccountAction(account:Address,action:Json):Promise<Json>;
 prepareCancel(intent:Intent):Promise<Json>;
 execution(hash:Hex,intentHash:Hex,executor:Address):Promise<VerifiedExecution>;
}
export interface AppContext { app:FastifyInstance; store:Store; chain:ChainGateway; config:ApiConfig; now:()=>number; entryReady?:()=>Promise<ReadinessResult>; }
