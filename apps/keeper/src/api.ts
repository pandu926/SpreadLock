import type { Hex } from 'viem';
import {parseSiweMessage} from 'viem/siwe';
import type { KeeperRuntimeConfig } from './config.js';
import type { IntentFeed, KeeperSigner, SignedIntent } from './types.js';

interface Envelope<T> { success: boolean; data: T; error?: unknown }
export class ApiIntentFeed implements IntentFeed {
  private token: string | undefined;
  private expiresAt = 0;
  private cursor: string | undefined;
  constructor(private readonly config: KeeperRuntimeConfig, private readonly signer: KeeperSigner) {}
  private async request<T>(path: string, method: 'GET' | 'POST', body?: unknown, authenticated = true): Promise<T> {
    if (authenticated && (!this.token || Date.now() + 10000 >= this.expiresAt)) await this.authenticate();
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (response.status === 401) { this.token = undefined; this.expiresAt = 0; }
    if (!response.ok) throw new Error(`Keeper API request failed (${response.status})`);
    if (!response.body) throw new Error('Empty keeper response');
    const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let length=0;
    for (;;) { const part=await reader.read(); if(part.done)break; length+=part.value.length;
      if(length>2_000_000){await reader.cancel();throw new Error('Keeper API response exceeds limit');}chunks.push(part.value); }
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const text=new TextDecoder().decode(bytes);
    const envelope = JSON.parse(text) as Envelope<T>;
    if (envelope.success !== true || !envelope.data) throw new Error('Invalid keeper API envelope');
    return envelope.data;
  }
  async authenticate(): Promise<void> {
    const challenge = await this.request<{ challengeId: string; message: string }>(
      '/v1/keeper/session/challenge', 'POST', { authorization: this.config.authorization }, false);
    if (typeof challenge.message !== 'string' || challenge.message.length > 4096 || typeof challenge.challengeId !== 'string') throw new Error('Invalid keeper authentication challenge');
    const message = parseSiweMessage(challenge.message);
    const api = new URL(this.config.apiBaseUrl);
    if (message.domain !== api.host || !message.uri || new URL(message.uri).origin !== api.origin ||
        message.chainId !== this.config.manifest.chainId || message.address?.toLowerCase() !== this.signer.address.toLowerCase() ||
        !message.statement?.startsWith('Sign in as a SpreadLock keeper for authorization ') ||
        !message.expirationTime || message.expirationTime.getTime() <= Date.now() || message.expirationTime.getTime() > Date.now()+310000) {
      throw new Error('Keeper authentication challenge violates local domain or purpose policy');
    }
    const signature = await this.signer.signMessage(challenge.message);
    const session = await this.request<{ token: string; expiresAt: number | string }>(
      '/v1/keeper/session', 'POST', { challengeId: challenge.challengeId, signature }, false);
    if (typeof session.token !== 'string' || session.token.length > 4096) throw new Error('Invalid keeper session');
    const expiry = typeof session.expiresAt === 'number' ? session.expiresAt : Date.parse(session.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Expired keeper session');
    this.token = session.token;
    this.expiresAt = expiry;
  }
  async fetch(): Promise<SignedIntent[]> {
    // One bounded page per tick keeps execution responsive while eventually
    // visiting every assignment, even if the first page stays active forever.
    const query = new URLSearchParams({ limit: '100' });
    if (this.cursor) query.set('cursor', this.cursor);
    const data = await this.request<{ items: SignedIntent[]; nextCursor?: unknown }>(`/v1/keeper/intents?${query}`, 'GET');
    if (!Array.isArray(data.items) || data.items.length > 100) throw new Error('Invalid keeper feed');
    const next = data.nextCursor;
    if (next !== null && next !== undefined && (typeof next !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(next)
        || !data.items.length || next.toLowerCase() !== data.items.at(-1)?.hash?.toLowerCase()
        || (this.cursor !== undefined && next.toLowerCase() <= this.cursor.toLowerCase()))) {
      throw new Error('Invalid keeper feed cursor');
    }
    // Advance only after accepting a page; a failed request retries the same
    // position. A completed scan starts again to find newly inserted hashes.
    this.cursor = typeof next === 'string' ? next : undefined;
    return data.items;
  }
  async report(hash: Hex, txHash: Hex): Promise<void> {
    await this.request('/v1/keeper/executions', 'POST', { hash, txHash });
  }
  async heartbeat(): Promise<void> { await this.request('/v1/keeper/heartbeat', 'POST', {}); }
}
