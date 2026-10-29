export type Address = `0x${string}`;
export type IntentStatus = 'WAITING' | 'ELIGIBLE' | 'SUBMITTED' | 'MINED' | 'CONFIRMED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'EXPIRED' | 'INVALIDATED' | 'SUSPENDED';
export type Json = Record<string, unknown>;
export interface Challenge {
  id: string; owner: Address; signer: Address; chainId: number; message: string;
  role: 'owner' | 'keeper'; authorizationId: string | null; expiresAt: number; consumedAt: number | null;
}
export interface Session {
  tokenHash: string; owner: Address; signer: Address; chainId: number;
  role: 'owner' | 'keeper'; authorizationId: string | null; expiresAt: number;
}
export interface Basket {
  id: string; account: Address; owner: Address; chainId: number; name: string; createdAt: number;
}
export interface StoredIntent {
  id: string; owner: Address; account: Address; chainId: number; executor: Address;
  body: Json; signature: `0x${string}`; status: IntentStatus; createdAt: number; updatedAt: number;
}
export interface KeeperAuthorization {
  id: string; owner: Address; keeper: Address; accounts: Address[]; chainId: number;
  validUntil: string; nonce: string; signature: `0x${string}`; revokedAt: number | null; createdAt: number;
}
export interface Execution {
  id: string; intentId: string; chainId: number; txHash: `0x${string}`; status: string;
  blockNumber: string | null; blockHash: string | null; receipt: Json | null; createdAt: number; updatedAt: number;
}
export interface ListIntents {
  owner: Address; chainId: number; accounts?: Address[]; executor?: Address;
  activeOnly?: boolean; after?: string; limit: number;
}
export interface AuditEvent {
  owner: Address | null; action: string; entityId: string; metadata: Json; createdAt: number;
}
export interface Job {
  id: string; kind: string; payload: Json; runAt: number; attempts: number;
}
export interface Store {
  ready(): Promise<void>;
  close(): Promise<void>;
  createChallenge(value: Challenge): Promise<void>;
  getChallenge(id: string): Promise<Challenge | null>;
  consumeChallenge(id: string, now: number): Promise<boolean>;
  createSession(value: Session): Promise<void>;
  getSession(tokenHash: string): Promise<Session | null>;
  deleteSession(tokenHash: string): Promise<void>;
  putBasket(value: Basket): Promise<Basket>;
  getBasket(chainId: number, account: Address): Promise<Basket | null>;
  listBaskets(owner: Address, chainId: number, after: string | undefined, limit: number): Promise<Basket[]>;
  putIntent(value: StoredIntent): Promise<{ value: StoredIntent; created: boolean }>;
  getIntent(id: string): Promise<StoredIntent | null>;
  listIntents(query: ListIntents): Promise<StoredIntent[]>;
  requestCancellation(id: string, owner: Address, now: number): Promise<StoredIntent | null>;
  putAuthorization(value: KeeperAuthorization): Promise<KeeperAuthorization>;
  getAuthorization(id: string): Promise<KeeperAuthorization | null>;
  listAuthorizations(owner: Address, chainId: number): Promise<KeeperAuthorization[]>;
  revokeAuthorization(id: string, owner: Address, now: number): Promise<boolean>;
  heartbeat(authorizationId: string, now: number): Promise<void>;
  putExecution(value: Execution): Promise<Execution>;
  listExecutions(owner: Address, chainId: number, account: Address | undefined, after: string | undefined, limit: number): Promise<Execution[]>;
  appendAudit(value: AuditEvent): Promise<void>;
  enqueueJob(kind: string, key: string, payload: Json, runAt: number): Promise<void>;
  claimJobs(worker: string, now: number, limit: number): Promise<Job[]>;
  finishJob(id: string, worker: string): Promise<void>;
  retryJob(id: string, worker: string, error: string, runAt: number): Promise<void>;
}
