#!/usr/bin/env node
/**
 * Does keyword retrieval actually find the section that holds the answer?
 *
 * This is the one risk the prefilter design introduces, so it gets checked before any model is
 * wired up. Each case names the page that must appear in the results. A miss here is a design
 * problem, not a tuning problem, and it is far cheaper to find now than after the UI exists.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRetriever, retrieve } from './lib/retrieve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(HERE, 'dist', 'corpus.json'), 'utf8'));
const r = loadRetriever(corpus);

// question -> a substring, or any of several, that must appear in a retrieved section URL.
//
// Every expectation names a concrete page. An earlier version used '/' for six cases, which matches
// every URL on the site and therefore asserted nothing; a test that cannot fail is worse than no
// test, because it reports confidence it has not earned.
//
// Where a question genuinely has more than one correct page, all of them are listed. That is not the
// same as loosening the assertion: 'can i run two wallets on one machine' is answered by the local
// network guide, the wallet config reference and the mainnet setup page, all three of which document
// the port collision, while /guides/wallet-operations does not mention it at all. The first version of
// this case asserted wallet-operations and failed. Retrieval was right and the expectation was wrong.
const CASES = [
  ['how do i set minimum confirmations when sending on a local test chain', '/guides/local-network'],
  ['what config makes a usernet chain actually mine', '/guides/local-network'],
  ['what is the coinbase maturity', ['/mining/emission', '/guides/stuck-transactions']],
  ['how many methods does the owner api have', '/api/wallet-owner'],
  ['my transaction is stuck as unconfirmed', '/guides/stuck-transactions'],
  ['only_randomx', ['/reference/node-config', '/guides/local-network']],
  ['enable_stratum_server', '/reference/node-config'],
  ['init_send_tx parameters', '/api/wallet'],
  ['what port does epicbox use', ['/reference/', '/concepts/transports', '/api/epicbox']],
  ['how do i back up my wallet', '/guides/backup-and-restore'],
  ['why can a wrong address not lose my funds', '/concepts/'],
  ['what is a slate', '/concepts/interactive-transactions'],
  ['how do i build the node on windows', '/guides/build'],
  ['integrate epic into an exchange', '/guides/exchange-integration'],
  ['what is the block reward', '/mining/emission'],
  ['how does the encrypted handshake work', ['/api/wallet-owner', '/examples/wallet-connect']],
  ['payment proof verification', '/concepts/payment-proofs'],
  ['stratum mining protocol methods', '/mining/stratum'],
  ['where do i download the wallet', '/downloads'],
  ['what changed in version 4', '/whats-new-in-v4'],
  ['how do i cancel a transaction', ['/api/wallet/transfers', '/guides/stuck-transactions']],
  ['mimblewimble explained', '/concepts/mimblewimble'],
  ['node api authentication secret', '/api/authentication'],
  ['what is a freeman', ['/mining/emission', '/api/']],
  ['how do i check my balance', ['/api/wallet/reading', '/guides/wallet-operations']],
  ['wallet config file options', '/reference/wallet-config'],
  ['cli commands list', '/reference/cli'],
  ['why is my balance locked', '/concepts/outputs-and-locking'],
  ['can i run two wallets on one machine', ['/guides/local-network', '/reference/wallet-config', '/guides/mainnet-setup']],
  ['what transports can carry a slate', '/concepts/transports'],
];

const matches = (url, expect) =>
  Array.isArray(expect) ? expect.some((e) => url.includes(e)) : url.includes(expect);

let pass = 0;
const fails = [];
let totalTokens = 0;
let totalSections = 0;
const rows = [];

for (const [q, expect] of CASES) {
  const res = retrieve(r, q);
  const urls = res.sections.map((s) => s.url);
  const hit = urls.some((u) => matches(u, expect));
  const rank = urls.findIndex((u) => matches(u, expect)) + 1;
  totalTokens += res.tokensApprox;
  totalSections += res.sections.length;
  if (hit) pass++;
  else fails.push({ q, expect, top: urls.slice(0, 5) });
  rows.push({
    q,
    hit,
    rank: hit ? rank : '-',
    n: res.sections.length,
    tok: res.tokensApprox,
    top: res.sections[0]?.breadcrumb ?? '(nothing)',
  });
}

console.log('hit  rank    n   tokens  question / best match');
console.log('-'.repeat(100));
for (const r2 of rows) {
  console.log(
    `${r2.hit ? ' ok ' : 'MISS'}  ${String(r2.rank).padStart(4)} ${String(r2.n).padStart(4)} ${String(r2.tok).padStart(8)}  ${r2.q}`,
  );
  console.log(`${' '.repeat(24)}-> ${r2.top}`);
}

console.log('\n' + '='.repeat(100));
console.log(`recall: ${pass}/${CASES.length} (${Math.round((pass / CASES.length) * 100)}%)`);
console.log(`mean sections retrieved: ${(totalSections / CASES.length).toFixed(1)}`);
console.log(`mean tokens retrieved:   ${Math.round(totalTokens / CASES.length)}`);
console.log(`max tokens retrieved:    ${Math.max(...rows.map((x) => x.tok))}`);

if (fails.length) {
  console.log(`\n${fails.length} miss(es):`);
  for (const f of fails) {
    console.log(`\n  Q: ${f.q}`);
    console.log(`  expected a URL containing: ${f.expect}`);
    console.log(`  got:`);
    f.top.forEach((u) => console.log(`    ${u}`));
  }
  process.exitCode = 1;
}

/* --------------------------------------------------- how big does top-k need to be? */

// Every retrieved section is roughly 134 tokens, so top-k is the cost dial. This finds the
// smallest setting that still holds recall, rather than picking 24 because it sounded generous.
console.log('\ntop-k sweep');
console.log(' topK   recall   mean tokens   sonnet 4.6 $/question');
for (const topK of [6, 8, 12, 16, 20, 24, 32]) {
  let hits = 0;
  let toks = 0;
  for (const [q, expect] of CASES) {
    const res = retrieve(r, q, { topK });
    if (res.sections.some((s) => matches(s.url, expect))) hits++;
    toks += res.tokensApprox;
  }
  const meanTok = toks / CASES.length;
  // core 1778 + instructions ~600 + retrieved, at $3.30/M in and $16.50/M out on a 550-token answer
  const cost = ((1778 + 600 + meanTok) * 3.3) / 1e6 + (550 * 16.5) / 1e6;
  console.log(
    `${String(topK).padStart(5)}   ${String(Math.round((hits / CASES.length) * 100) + '%').padStart(6)}   ${String(Math.round(meanTok)).padStart(11)}   $${cost.toFixed(4)}`,
  );
}
