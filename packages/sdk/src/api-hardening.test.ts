import { describe, expect, it, vi } from 'vitest';
import { SpreadLockApiClient } from './api.js';
import type { WireIntent } from '../../domain/src/index.js';
const a = '0x1111111111111111111111111111111111111111' as const;
const hash = `0x${'1'.repeat(64)}` as const;
const token = 'a'.repeat(43);
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }));

describe('HTTP SDK bounded streams, session lifecycle and request routing', () => {
  it.each(['ftp://api.example', 'https://user:password@api.example', 'https://api.example:443@attacker.example'])('rejects unsafe API origin %s', url => {
    expect(() => new SpreadLockApiClient(url)).toThrow();
  });
  it.each(['http://localhost:18180', 'http://[::1]:18180', 'https://api.example'])('accepts secure or loopback origin %s', url => {
    expect(() => new SpreadLockApiClient(url)).not.toThrow();
  });
  it('verifies login then sends authenticated calls only to the pinned origin', async () => {
    const fake = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => ok({ token, expiresAt: 'future' }));
    const client = new SpreadLockApiClient('https://api.example/subpath', fake);
    expect(await client.verify('challenge', '0x12')).toEqual({ token, expiresAt: 'future' });
    const wire = { account: a, executor: a, nonce: '1', operation: 0, legs: [] } as unknown as WireIntent;
    await client.baskets(); await client.createAccount(hash); await client.registerBasket(a, 'basket'); await client.basket(a);
    await client.prepareAction(a, { action: 'invalidate' }); await client.quote(wire); await client.prepareIntent(wire);
    await client.submitIntent(wire, '0x12'); await client.intent(hash); await client.cancelIntent(hash); await client.executions();
    const paths = fake.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual(['/v1/auth/verify', '/v1/baskets', '/v1/baskets/prepare', '/v1/baskets/register', `/v1/baskets/${a}`,
      `/v1/baskets/${a}/actions/prepare`, '/v1/quotes', '/v1/intents/prepare', '/v1/intents', `/v1/intents/${hash}`,
      `/v1/intents/${hash}/cancel/prepare`, '/v1/executions']);
    for (const [url, init] of fake.mock.calls.slice(1)) {
      expect(new URL(String(url)).origin).toBe('https://api.example');
      expect(init).toMatchObject({ redirect: 'error', headers: { authorization: `Bearer ${token}` } });
    }
    expect(fake.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
    await client.logout(); await expect(client.baskets()).rejects.toMatchObject({ code: 'NO_SESSION' });
  });
  it('clears sessions after unauthorized responses and after failed logout', async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 }));
    const client = new SpreadLockApiClient('https://api.example', fake); client.setSession(token);
    await expect(client.baskets()).rejects.toMatchObject({ code: 'API_ERROR', message: 'API request failed' });
    await expect(client.baskets()).rejects.toMatchObject({ code: 'NO_SESSION' });
    client.setSession(token); fake.mockRejectedValueOnce(new Error('offline'));
    await expect(client.logout()).rejects.toThrow('offline'); await expect(client.baskets()).rejects.toMatchObject({ code: 'NO_SESSION' });
  });
  it('rejects malformed, absent and oversized response streams', async () => {
    const fake = vi.fn(async () => new Response(null));
    const client = new SpreadLockApiClient('https://api.example', fake);
    await expect(client.markets()).rejects.toThrow('Empty API response');
    fake.mockResolvedValueOnce(new Response('not-json')); await expect(client.markets()).rejects.toThrow();
    let cancelled = false;
    fake.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); },
      cancel() { cancelled = true; } })));
    await expect(client.markets()).rejects.toThrow('too large'); expect(cancelled).toBe(true);
  });
  it('reassembles split UTF8 JSON responses and propagates stream errors', async () => {
    const data = new TextEncoder().encode(JSON.stringify({ success: true, data: { name: 'basket €' } }));
    const split = data.indexOf(0xe2) + 1;
    const fake = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(data.slice(0, split)); controller.enqueue(data.slice(split)); controller.close();
    } })));
    const client = new SpreadLockApiClient('https://api.example', fake);
    expect(await client.markets()).toEqual({ name: 'basket €' });
    fake.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken stream')); } })));
    await expect(client.markets()).rejects.toThrow('broken stream');
  });
  it.each(['/v1/../admin', '//evil.example/v1/data', '/v1/https://evil.example'])('rejects escaped request path %s', async path => {
    const client = new SpreadLockApiClient('https://api.example'); await expect(client.request('GET', path)).rejects.toThrow('path');
  });
});
