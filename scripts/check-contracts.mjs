import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

if(!process.argv[2])throw new Error('Usage: npm run check:contracts -- <site-checkout>');
const site=resolve(process.argv[2]);
for(const [local,remote] of [['protocol.schema.json','docs/integrations/obsidian/v1/protocol.schema.json'],['valid.json','test/fixtures/obsidian/v1/valid.json'],['invalid.json','test/fixtures/obsidian/v1/invalid.json']]){
  const [a,b]=await Promise.all([readFile(new URL('../contracts/v1/'+local,import.meta.url)),readFile(join(site,remote))]);
  if(!a.equals(b))throw new Error('Contract differs: '+local);
}
console.log('Protocol schema and fixtures match the site byte-for-byte');
