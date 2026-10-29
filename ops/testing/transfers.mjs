import {decodeEventLog,parseAbiItem,toEventSelector} from 'viem';
const transfer=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const topic=toEventSelector(transfer);
/** Net USDso leaving owner for known basket accounts, ignoring unrelated token events. */
export function collateralDelta(log,collateral,owner,accounts){
 if(log.address.toLowerCase()!==collateral.toLowerCase()||log.topics[0]!==topic)return 0n;
 const {args}=decodeEventLog({abi:[transfer],data:log.data,topics:log.topics});
 const from=args.from.toLowerCase(),to=args.to.toLowerCase(),normalized=owner.toLowerCase();
 if(from===normalized&&accounts.has(to))return args.value;
 if(to===normalized&&accounts.has(from))return -args.value;
 return 0n;
}
