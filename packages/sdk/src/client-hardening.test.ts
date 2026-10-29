import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256 } from 'viem';
import { SpreadLockClient, selectExecutionPrice } from './client.js';
import { accountAbi, factoryAbi, routerAbi, tokenAbi } from './abi.js';
import { canonicalPositionsHash, hashIntent, type DeploymentManifest, type Intent } from '../../domain/src/index.js';

const a = '0x0000000000000000000000000000000000000001' as const;
const b = '0x0000000000000000000000000000000000000002' as const;
const c = '0x0000000000000000000000000000000000000003' as const;
const code = '0x6000' as const;
const manifest = (): DeploymentManifest => ({ version: 1, chainId: 50383, router: a, factory: b, marketRegistry: c,
  marginBank: a, collateral: b, permissionsRegistry: c, protocolFactory: a, deploymentBlock: '0', confirmations: 12,
  markets: [a, b], rpcHttpUrl: 'https://rpc.invalid' });
const intent = (): Intent => ({ account: c, executor: b, nonce: 1n, epoch: 0n, expectedRevision: 0n,
  expectedPositionsHash: canonicalPositionsHash([]), validAfter: 100n, validUntil: 200n, operation: 0,
  legs: [{ pool: a, delta: 2n, limitPrice: 10n, maxTakerFeeBpsTimes1k: 100 },
    { pool: b, delta: -2n, limitPrice: 8n, maxTakerFeeBpsTimes1k: 100 }],
  minNetQuote: -100n, triggerKind: 0, triggerValue: 0n, minPostEquity: 0n, minPostHealthBps: 0 });
function fixture() {
  const client = new SpreadLockClient(manifest());
  const rpc = {
    getChainId: vi.fn(async () => 50383), getCode: vi.fn(async () => code as `0x${string}` | undefined),
    getBlockNumber: vi.fn(async () => 100n), getBlock: vi.fn(async () => ({ timestamp: 150n })),
    getStorageAt: vi.fn(async () => `0x${'0'.repeat(64)}`),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      switch (functionName) {
        case 'accountFactory': return b;
        case 'marketRegistry': return c;
        case 'isAccount': return true;
        case 'owner': return a;
        case 'epoch': return 1n;
        case 'revision': return 2n;
        case 'getActivePerpPools': return [a, b];
        case 'getAccountHealth': return [100n, 10n, 5n, 1n];
        case 'getPosition': return { size: args?.[1] === a ? 2n : -2n, entryNotional: 10n, lastFundingIndex: 0n };
        case 'positionsHash': return canonicalPositionsHash([]);
        case 'marketMetadata': return [1n, 1n, 1n, 1n, 0n];
        case 'getBookLevels': return [{ price: 9n, quantity: 10n }];
        case 'tryGetMarkPrice': return [true, 9n];
        default: throw new Error(`Unexpected read ${functionName}`);
      }
    }),
    verifyTypedData: vi.fn(async () => true), simulateContract: vi.fn(async () => ({})), estimateContractGas: vi.fn(async () => 1_000_000n),
  };
  Object.defineProperty(client, 'publicClient', { value: rpc });
  return { client, rpc };
}

describe('chain SDK pinned deployment and account controls', () => {
  it('requires a pinned RPC and verifies both router dependency bindings', async () => {
    expect(() => new SpreadLockClient({ ...manifest(), rpcHttpUrl: undefined })).toThrow('RPC');
    const { client, rpc } = fixture(); await client.verifyDeployment(); expect(rpc.getCode).toHaveBeenCalledTimes(5);
    rpc.getChainId.mockResolvedValueOnce(1); await expect(client.verifyDeployment()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });
    rpc.getCode.mockResolvedValueOnce(undefined); await expect(client.verifyDeployment()).rejects.toMatchObject({ code: 'MISSING_CONTRACT' });
    rpc.getCode.mockResolvedValueOnce('0x'); await expect(client.verifyDeployment()).rejects.toMatchObject({ code: 'MISSING_CONTRACT' });
    rpc.readContract.mockImplementationOnce(async () => a); await expect(client.verifyDeployment()).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
    rpc.readContract.mockImplementationOnce(async () => b).mockImplementationOnce(async () => b);
    await expect(client.verifyDeployment()).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
  });
  it('rejects fingerprint drift and accepts a matching nonproxy pin', async () => {
    const { client } = fixture(); client.manifest.fingerprints = { [a]: { codeHash: keccak256(code) } };
    await client.verifyDeployment();
    client.manifest.fingerprints = { [a]: { codeHash: keccak256('0x1234') } };
    await expect(client.verifyDeployment()).rejects.toMatchObject({ code: 'IMPLEMENTATION_CHANGED' });
  });
  it('reads owner without health oracle and pins all account-state reads to one block', async () => {
    const { client, rpc } = fixture(); expect(await client.accountOwner(c)).toBe(a);
    expect(rpc.readContract.mock.calls.map(([request]) => request.functionName)).toEqual(['isAccount', 'owner']);
    rpc.readContract.mockClear();
    const state = await client.accountState(c); expect(state).toMatchObject({ blockNumber: 100n, owner: a, epoch: 1n, revision: 2n,
      health: { equity: 100n, imReq: 10n, mmReq: 5n, cmReq: 1n } });
    expect(state.positions.map(position => position.size)).toEqual([2n, -2n]);
    expect(rpc.readContract.mock.calls.every(([request]) => (request as { blockNumber?: bigint }).blockNumber === 100n)).toBe(true);
    expect(await client.positionsHash(intent())).toBe(canonicalPositionsHash([]));
  });
  it.each(['accountOwner', 'accountState'] as const)('rejects foreign accounts for %s', async method => {
    const { client, rpc } = fixture(); rpc.readContract.mockResolvedValueOnce(false);
    await expect(client[method](c)).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
  });
  it('encodes account funding, delegation, deposit and exact nonce bitmap cancellation calls', () => {
    const { client } = fixture(), salt = `0x${'1'.repeat(64)}` as const;
    const create = client.createAccountCall(salt); expect(create.to).toBe(b);
    expect(decodeFunctionData({ abi: factoryAbi, data: create.data })).toMatchObject({ functionName: 'createAccount', args: [salt] });
    const fund = client.fundAccountCall(c, 20n); expect(fund.to).toBe(b);
    expect(decodeFunctionData({ abi: tokenAbi, data: fund.data })).toMatchObject({ functionName: 'transfer', args: [c, 20n] });
    expect(decodeFunctionData({ abi: accountAbi, data: client.depositCall(c, 20n).data })).toMatchObject({ functionName: 'depositMargin', args: [20n] });
    expect(decodeFunctionData({ abi: accountAbi, data: client.grantCall(c, [a, b], false).data })).toMatchObject({ functionName: 'setRouterApproval', args: [a, [a, b], false] });
    expect(decodeFunctionData({ abi: routerAbi, data: client.cancelCall(c, 513n).data })).toMatchObject({ functionName: 'invalidateNonces', args: [c, 2n, 2n] });
  });
});

describe('chain SDK economic and simulation boundaries', () => {
  it('sorts either direction, ignores invalid levels and stops at owner limits', () => {
    expect(selectExecutionPrice(-3n, 7n, [{ price: 8n, quantity: 1n }, { price: 10n, quantity: 1n }, { price: 9n, quantity: 2n }])).toBe(9n);
    expect(selectExecutionPrice(2n, 10n, [{ price: 0n, quantity: 10n }, { price: 8n, quantity: 0n }, { price: 9n, quantity: 1n }, { price: 9n, quantity: 1n }])).toBe(9n);
    expect(() => selectExecutionPrice(2n, 8n, [{ price: 9n, quantity: 100n }])).toThrow('FOK');
    expect(() => selectExecutionPrice(0n, 1n, [])).toThrow('quantity');
    expect(() => selectExecutionPrice(1n, 0n, [])).toThrow('limit');
  });
  it('produces a same-block quote then verifies, simulates and estimates the exact signed execution', async () => {
    const { client, rpc } = fixture(), signed = intent();
    const result = await client.prepareExecution(signed, '0x1234');
    expect(result).toMatchObject({ to: a, value: 0n, gas: 1_000_000n, prices: [9n, 9n], hash: hashIntent(signed, 50383, a) });
    expect(result.quote.guaranteedNetQuote).toBe(0n);
    expect(rpc.readContract.mock.calls.every(([request]) => (request as { blockNumber?: bigint }).blockNumber === 100n)).toBe(true);
    expect(rpc.verifyTypedData).toHaveBeenCalledWith(expect.objectContaining({ address: c, signature: '0x1234' }));
    expect(rpc.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: b, functionName: 'execute', args: [signed, [9n, 9n], '0x1234'] }));
  });
  it('does not simulate or estimate an invalid signature', async () => {
    const { client, rpc } = fixture(); rpc.verifyTypedData.mockResolvedValueOnce(false);
    await expect(client.prepareExecution(intent(), '0x12')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(rpc.simulateContract).not.toHaveBeenCalled(); expect(rpc.estimateContractGas).not.toHaveBeenCalled();
  });
  it('retries only explicit FOK races using signed limits and reports the recomputed bound', async () => {
    const {client,rpc}=fixture(), signed=intent();
    rpc.simulateContract.mockRejectedValueOnce({cause:{data:'0xc04ad919'}});
    const result=await client.prepareExecution(signed,'0x12');
    expect(result.prices).toEqual([10n,8n]);expect(result.quote.prices).toEqual([10n,8n]);
    expect(result.quote.guaranteedNetQuote).toBe(-4n);expect(result.quote.rows.map(row=>row.price)).toEqual([10n,8n]);
    expect(decodeFunctionData({abi:routerAbi,data:result.data}).args?.[1]).toEqual([10n,8n]);
    expect(rpc.simulateContract).toHaveBeenCalledTimes(2);
    expect(rpc.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({args:[signed,[10n,8n],'0x12']}));
  });
  it('rejects a signed-limit fallback below the combined quote bound without retrying simulation',async()=>{
    const {client,rpc}=fixture();rpc.simulateContract.mockRejectedValueOnce({data:{errorName:'FillOrKillNotFillable'}});
    await expect(client.prepareExecution({...intent(),minNetQuote:0n},'0x12')).rejects.toMatchObject({code:'QUOTE_BOUND'});
    expect(rpc.simulateContract).toHaveBeenCalledOnce();expect(rpc.estimateContractGas).not.toHaveBeenCalled();
  });
  it('propagates failed signed-limit fallback simulation',async()=>{
    const {client,rpc}=fixture();rpc.simulateContract.mockRejectedValueOnce({data:'0xc04ad919'}).mockRejectedValueOnce(new Error('QuoteTooLow'));
    await expect(client.prepareExecution(intent(),'0x12')).rejects.toThrow('QuoteTooLow');expect(rpc.simulateContract).toHaveBeenCalledTimes(2);
    expect(rpc.estimateContractGas).not.toHaveBeenCalled();
  });
  it('propagates a protocol simulation rejection before estimating or returning calldata', async () => {
    const { client, rpc } = fixture(); rpc.simulateContract.mockRejectedValueOnce(new Error('health rejected'));
    await expect(client.prepareExecution(intent(), '0x12')).rejects.toThrow('health rejected'); expect(rpc.estimateContractGas).not.toHaveBeenCalled();
  });
  it('rejects unsupported markets, stale mark, fee drift, invalid grids and combined quote shortfall', async () => {
    const foreign = fixture(); await expect(foreign.client.quote({ ...intent(), legs: [{ ...intent().legs[0]!, pool: c }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_MARKET' });
    const oracle = fixture(); oracle.rpc.readContract.mockImplementationOnce(async () => [1n, 1n, 1n, 1n, 0n])
      .mockImplementationOnce(async () => [{ price: 9n, quantity: 10n }]).mockImplementationOnce(async () => [false, 0n]);
    await expect(oracle.client.quote(intent())).rejects.toMatchObject({ code: 'STALE_ORACLE' });
    for (const [metadata, error] of [[[1n, 1n, 1n, 1n, 101n], 'FEE_LIMIT'], [[1n, 1n, 3n, 1n, 0n], 'LOT_SIZE'], [[1n, 1n, 1n, 3n, 0n], 'LOT_SIZE']] as const) {
      const row = fixture(); row.rpc.readContract.mockResolvedValueOnce([...metadata]);
      await expect(row.client.quote(intent())).rejects.toMatchObject({ code: error });
    }
    await expect(fixture().client.quote({ ...intent(), minNetQuote: 1n })).rejects.toMatchObject({ code: 'QUOTE_BOUND' });
  });
});
