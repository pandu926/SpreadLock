import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeEventTopics,encodeAbiParameters,parseAbiItem} from 'viem';
import {collateralDelta} from './transfers.mjs';
const tokenAddress='0x1111111111111111111111111111111111111111',owner='0x2222222222222222222222222222222222222222',account='0x3333333333333333333333333333333333333333',accounts=new Set([account]);
const event=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const log=(from,to,value)=>({address:tokenAddress,topics:encodeEventTopics({abi:[event],eventName:'Transfer',args:{from,to}}),data:encodeAbiParameters([{type:'uint256'}],[value])});
test('collateral commitment counts outbound and owner refunds exactly',()=>{assert.equal(collateralDelta(log(owner,account,20n),tokenAddress,owner,accounts),20n);assert.equal(collateralDelta(log(account,owner,19n),tokenAddress,owner,accounts),-19n);});
test('Approval in a deposit receipt must not invalidate transfer reconciliation',()=>{const approval=parseAbiItem('event Approval(address indexed owner,address indexed spender,uint256 value)');const l={address:tokenAddress,topics:encodeEventTopics({abi:[approval],eventName:'Approval',args:{owner,spender:account}}),data:encodeAbiParameters([{type:'uint256'}],[20n])};assert.equal(collateralDelta(l,tokenAddress,owner,accounts),0n);assert.equal(collateralDelta({...log(owner,account,20n),address:account},tokenAddress,owner,accounts),0n);});
