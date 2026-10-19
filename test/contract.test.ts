import test from 'node:test';
import assert from 'node:assert/strict';
import valid from '../contracts/v1/valid.json';
import invalid from '../contracts/v1/invalid.json';
import {validateDTO} from '../src/protocol/validate.js';

test('shared portable protocol fixtures are accepted/rejected identically',()=>{
  for(const fixture of valid)assert.deepEqual(validateDTO(fixture.kind,fixture.value),fixture.value,fixture.name);
  for(const fixture of invalid)assert.throws(()=>validateDTO(fixture.kind,fixture.value),fixture.name);
});
