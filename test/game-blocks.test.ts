import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCheck,validateCheck,trialRoll,checkSource,checkLabel} from '../src/game-blocks/checks.js';
const base={version:1,kind:'skill',skill:'perception',dc:15};
test('checks match canonical skill/ability/save IDs and default to private 1d20',()=>{
  assert.deepEqual(validateCheck(base),{...base,formula:'1d20',mode:'normal',visibility:'private'});
  for(const kind of ['ability','save'])for(const dc of [1,40])assert.equal(validateCheck({version:1,kind,ability:'dex',dc}).dc,dc);
  assert.match(checkLabel(validateCheck(base)),/Внимательность/);
});
test('invalid checks remain source, never executable expressions or guessed labels',()=>{
  for(const value of [{...base,dc:0},{...base,dc:41},{...base,dc:1.5},{...base,formula:'1d20+5'},{...base,skill:'Внимательность'},{...base,ability:'dex'},{...base,html:'<script>'},{...base,visibility:'master'},{...base,mode:'bad'}])assert.throws(()=>validateCheck(value));
  for(const source of ['x: [', 'version: 1\nversion: 1','a: &x [*x]','!!js/function function(){}','x'.repeat(4097)])assert.throws(()=>parseCheck(source));
});
test('JSON/YAML authoring roundtrips strict plain data',()=>{const check=validateCheck({...base,mode:'advantage',visibility:'public'});assert.deepEqual(parseCheck(JSON.stringify(check)),check);assert.equal(parseCheck('version: 1\nkind: ability\nability: str\ndc: 12').ability,'str');assert.ok(checkSource(check).startsWith('```dndplace-check\n'));});
test('trial rolls are local, bounded and never impose natural-1/20 check success',()=>{
  let values=[0,.999],roll=trialRoll(validateCheck({...base,mode:'advantage'}),()=>values.shift()!);assert.deepEqual(roll.dice,[1,20]);assert.equal(roll.die,20);assert.equal(roll.local,true);assert.equal('success'in roll,false);
  values=[0,.999];assert.equal(trialRoll(validateCheck({...base,mode:'disadvantage'}),()=>values.shift()!).die,1);
  assert.throws(()=>trialRoll(validateCheck(base),()=>1));assert.throws(()=>trialRoll(validateCheck(base),()=>NaN));
});
