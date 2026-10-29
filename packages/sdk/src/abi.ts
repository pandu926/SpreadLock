import { parseAbi } from 'viem';
const leg = '(address pool,int128 delta,uint256 limitPrice,uint32 maxTakerFeeBpsTimes1k)';
const intent = `(address account,address executor,uint256 nonce,uint256 epoch,uint256 expectedRevision,bytes32 expectedPositionsHash,uint64 validAfter,uint64 validUntil,uint8 operation,${leg}[] legs,int256 minNetQuote,uint8 triggerKind,int256 triggerValue,uint256 minPostEquity,uint32 minPostHealthBps)`;
export const routerAbi = parseAbi([
  'error FillOrKillNotFillable()',
  `function execute(${intent} intent,uint256[] executablePrices,bytes signature)`,
  `function hashIntent(${intent} intent) view returns(bytes32)`,
  `function positionsHash(address account,${leg}[] legs) view returns(bytes32)`,
  'function nonceUsed(address account,uint256 epoch,uint256 nonce) view returns(bool)',
  'function invalidateNonces(address account,uint256 word,uint256 mask)',
  'function accountFactory() view returns(address)', 'function marketRegistry() view returns(address)',
  'event IntentExecuted(bytes32 indexed intentHash,address indexed account,address indexed executor,uint256 nonce,uint256 epoch,uint256 revision,int256 guaranteedNetQuote)',
  'event LegExecuted(bytes32 indexed intentHash,address indexed pool,int128 delta,uint256 limitPrice)',
  'event NoncesInvalidated(address indexed account,uint256 indexed epoch,uint256 indexed word,uint256 mask)',
]);
export const accountAbi = parseAbi([
  'function owner() view returns(address)', 'function epoch() view returns(uint256)', 'function revision() view returns(uint256)',
  'function depositMargin(uint256 amount)', 'function withdrawMargin(uint256 amount)',
  'function setRouterApproval(address router,address[] pools,bool approved)', 'function invalidateIntents()',
  'function emergencyClose(address pool,uint256 quantity,uint256 limitPrice,uint64 expiryNs,bool immediateOrCancel)',
  'function withdrawToken(address token,uint256 amount)', 'function withdrawNative(uint256 amount)',
  'function routerAuthorized(address router) view returns(bool)',
  'event EpochAdvanced(uint256 epoch,uint256 revision)', 'event RevisionAdvanced(uint256 revision)',
]);
export const factoryAbi = parseAbi([
  'function createAccount(bytes32 salt) returns(address)', 'function predictAccount(address owner,bytes32 salt) view returns(address)',
  'function isAccount(address account) view returns(bool)',
  'event AccountCreated(address indexed owner,address indexed account,bytes32 indexed salt)',
]);
export const bankAbi = parseAbi([
  'function getActivePerpPools(address account) view returns(address[])',
  'function getPosition(address account,address pool) view returns((int128 size,uint128 avgEntryPrice,int256 entryFundingIndex,uint64 lastUpdatedTimestampNs))',
  'function getAccountHealth(address account) view returns(int256 equity,uint256 imReq,uint256 mmReq,uint256 cmReq)',
  'function getAccountState(address account) view returns((int256 unlockedCollateralBalance,uint256 lockedCollateral,address[] activePerpPools))',
]);
export const registryAbi = parseAbi([
  'function marketMetadata(address pool) view returns(uint256 oneBase,uint256 tickSize,uint256 minQuantity,uint256 lotSize,uint256 takerFeeBpsTimes1k)',
  'function verifiedPools() view returns(address[])', 'function entryEnabled(address pool) view returns(bool)',
  'function entryPaused() view returns(bool)',
]);
export const poolAbi = parseAbi([
  'function getBookLevels(bool isBid,uint64 numLevels) view returns((uint256 price,uint256 quantity)[])',
  'function tryGetMarkPrice() view returns(bool ok,uint256 price)',
]);
export const tokenAbi = parseAbi(['function transfer(address to,uint256 amount) returns(bool)','function balanceOf(address account) view returns(uint256)']);
