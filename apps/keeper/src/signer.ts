import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { readPrivateFile } from './config.js';
import type { KeeperSigner, SignableExecution } from './types.js';

export async function loadKeeperSigner(keystorePath: string, passwordFile: string, expectedAddress: Address): Promise<KeeperSigner> {
  const password = readPrivateFile(passwordFile).replace(/\r?\n$/, '');
  const wallet = await Wallet.fromEncryptedJson(readPrivateFile(keystorePath), password);
  const account = privateKeyToAccount(wallet.privateKey as Hex);
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('Keeper keystore does not match authorized executor');
  return { address: account.address,
    signMessage: message => account.signMessage({ message }),
    signTransaction: async (tx: SignableExecution) => account.signTransaction({
      chainId: tx.chainId, to: tx.to, data: tx.data, value: 0n, nonce: tx.nonce,
      gas: tx.gas, maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas, type: 'eip1559',
    }),
  };
}
