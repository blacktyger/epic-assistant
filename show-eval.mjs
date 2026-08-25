#!/usr/bin/env node
/** Prints the answers for named cases from the most recent eval run. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, 'var/eval');
const latest = readdirSync(dir).sort().at(-1);
const data = JSON.parse(readFileSync(join(dir, latest), 'utf8'));
console.log(`run ${latest}\n`);

const wanted = process.argv.slice(2);
for (const [arm, rs] of Object.entries(data.results)) {
  for (const r of rs) {
    if (wanted.length && !wanted.includes(r.id)) continue;
    if (!wanted.length && r.pass) continue;
    console.log('='.repeat(78));
    console.log(`${arm}  ${r.id}  ${r.pass ? 'PASS' : 'FAIL'}  refusedDetected=${r.refused}`);
    console.log(`Q: ${r.q}`);
    if (r.reasons?.length) r.reasons.forEach((x) => console.log(`   ! ${x}`));
    console.log('-'.repeat(78));
    console.log(r.answer);
    console.log();
  }
}
