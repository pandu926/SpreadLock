import { keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';

export interface Fingerprint { codeHash: Hex; implementation?: Address; implementationCodeHash?: Hex; beacon?: Address }
const implementationSlot = toHex(BigInt(keccak256(toHex('eip1967.proxy.implementation'))) - 1n, { size: 32 });
const beaconSlot = toHex(BigInt(keccak256(toHex('eip1967.proxy.beacon'))) - 1n, { size: 32 });
const nonzeroAddress = (value: Hex | undefined): Address | undefined => {
  if (!value || /^0x0*$/i.test(value)) return undefined;
  return `0x${value.slice(-40)}` as Address;
};

export async function fingerprint(client: PublicClient, address: Address): Promise<Fingerprint> {
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw new Error(`Contract missing at ${address}`);
  const blockNumber = await client.getBlockNumber();
  const [implementationWord, beaconWord] = await Promise.all([
    client.getStorageAt({ address, slot: implementationSlot, blockNumber }),
    client.getStorageAt({ address, slot: beaconSlot, blockNumber }),
  ]);
  const beacon = nonzeroAddress(beaconWord);
  const implementation = beacon
    ? await client.readContract({ address: beacon, abi: parseAbi(['function implementation() view returns(address)']), functionName: 'implementation', blockNumber })
    : nonzeroAddress(implementationWord);
  const result: Fingerprint = { codeHash: keccak256(code) };
  if (beacon) result.beacon = beacon;
  if (implementation) {
    const implementationCode = await client.getCode({ address: implementation, blockNumber });
    if (!implementationCode || implementationCode === '0x') throw new Error('Proxy implementation has no code');
    result.implementation = implementation; result.implementationCodeHash = keccak256(implementationCode);
  }
  return result;
}

export function fingerprintMatches(expected: Fingerprint, actual: Fingerprint): boolean {
  const keys = ['codeHash', 'implementation', 'implementationCodeHash', 'beacon'] as const;
  return keys.every(key => expected[key]?.toLowerCase() === actual[key]?.toLowerCase());
}
