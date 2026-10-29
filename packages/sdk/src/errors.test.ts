import {describe,expect,it} from 'vitest';
import {decodeErrorResult,encodeErrorResult} from 'viem';
import {isFillOrKillNotFillable} from './errors.js';
import {routerAbi} from './abi.js';
describe('explicit FOK revert classification',()=>{
 it('decodes the official external zero-argument FOK error ABI',()=>{
  const data=encodeErrorResult({abi:routerAbi,errorName:'FillOrKillNotFillable'});
  expect(data).toBe('0xc04ad919');expect(decodeErrorResult({abi:routerAbi,data}).errorName).toBe('FillOrKillNotFillable');
 });
 it.each(['0xc04ad919',{errorName:'FillOrKillNotFillable'},{cause:{data:'0xC04AD919'}},{data:{errorName:'FillOrKillNotFillable'}}])('recognizes structured revert %j',error=>{
  expect(isFillOrKillNotFillable(error)).toBe(true);
 });
 it.each([null,undefined,17,{},'FillOrKillNotFillable',new Error('FillOrKillNotFillable 0xc04ad919'),{data:'0xc04ad91900'},{errorName:'QuoteTooLow'}])('does not infer retry from unrelated evidence %j',error=>{
  expect(isFillOrKillNotFillable(error)).toBe(false);
 });
 it('terminates on cyclic and excessively nested error objects',()=>{
  const cycle:Record<string,unknown>={};cycle.cause=cycle;expect(isFillOrKillNotFillable(cycle)).toBe(false);
  let deep:unknown={data:'0xc04ad919'};for(let n=0;n<40;n++)deep={cause:deep};expect(isFillOrKillNotFillable(deep)).toBe(false);
 });
});
