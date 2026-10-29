import { decodeEventLog, parseAbi, type Address, type Abi } from 'viem';
import type { ChainLog, DecodedLog, Role, WatchedAddress } from './types.js';

const eventAbis: Record<Role, Abi> = {
  factory: parseAbi(['event AccountCreated(address indexed owner,address indexed account,bytes32 indexed salt)']),
  account: parseAbi([
    'event AuthorizationChanged(address indexed router,bool approved,uint256 epoch,uint256 revision)',
    'event EpochAdvanced(uint256 epoch,uint256 revision)',
    'event RevisionAdvanced(uint256 revision)',
    'event MarginDeposited(uint256 amount)', 'event MarginWithdrawn(uint256 amount)',
    'event EmergencyClosed(address indexed pool,int128 delta,uint256 quantity,uint256 price)',
  ]),
  router: parseAbi([
    'event IntentExecuted(bytes32 indexed intentHash,address indexed account,address indexed executor,uint256 nonce,uint256 epoch,uint256 revision,int256 guaranteedNetQuote)',
    'event LegExecuted(bytes32 indexed intentHash,address indexed pool,int128 delta,uint256 limitPrice)',
    'event NoncesInvalidated(address indexed account,uint256 indexed epoch,uint256 indexed word,uint256 mask)',
  ]),
  registry: parseAbi(['event PoolConfigured(address indexed pool,bool entryEnabled)', 'event EntryPauseChanged(bool paused)', 'event GuardianChanged(address indexed guardian)']),
  bank: parseAbi([
    'event PositionUpdated(address indexed account,address indexed perpPool,int128 newSize,uint128 avgEntryPrice,int256 realizedPnl,int256 entryFundingIndex)',
    'event FundingSettled(address indexed account,address indexed perpPool,int256 payment)',
    'event Deposited(address indexed account,uint256 amount)', 'event Withdrawn(address indexed account,uint256 amount)',
  ]),
  pool: parseAbi([
    'event OrderFilled(uint128 indexed takerOrderId,uint128 indexed makerOrderId,uint256 quantityFilled,uint256 takerRemainingQuantity,uint256 makerRemainingQuantity,uint256 fillPrice)',
  ]),
  liquidation: parseAbi([
    'event AccountLiquidated(address indexed account,uint256 positionsProcessed,uint8 stageReached,uint8 marginStatusBefore,uint8 marginStatusAfter)',
  ]),
};

export function decodeLog(log: ChainLog, watched: WatchedAddress[]): DecodedLog {
  const roles = watched.filter(w => w.address.toLowerCase() === log.address.toLowerCase()).map(w => w.role);
  for (const role of roles) {
    try {
      const decoded = decodeEventLog({ abi: eventAbis[role], topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]], data: log.data, strict: true });
      return { ...log, eventName: decoded.eventName ?? null, args: decoded.args as unknown as Record<string, unknown> };
    } catch { /* Keep trying known roles, then persist the undecoded raw event. */ }
  }
  return { ...log, eventName: null, args: null };
}

export function discoveredAddresses(logs: DecodedLog[]): WatchedAddress[] {
  return logs.flatMap<WatchedAddress>(log => {
    if (log.eventName === 'AccountCreated') return [{ address: log.args!.account as Address, role: 'account' as const }];
    if (log.eventName === 'PoolConfigured') return [{ address: log.args!.pool as Address, role: 'pool' as const }];
    return [];
  });
}

export function uniqueWatched(addresses: WatchedAddress[]): WatchedAddress[] {
  return [...new Map(addresses.map(w => [`${w.role}:${w.address.toLowerCase()}`, w])).values()];
}
