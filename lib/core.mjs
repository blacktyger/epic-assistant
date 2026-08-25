/**
 * The core block: the part of the prompt that is always present and always cached.
 *
 * Three jobs.
 *
 * 1. Carry the facts that must never be wrong regardless of what retrieval returns. Versions, ports
 *    and consensus constants come from `site/src/data/versions.js`, which the docs already treat as
 *    the single place those values are edited, so the assistant cannot drift from the pages.
 * 2. Carry the escalation targets. The extractor reads the <article> element, so the site footer's
 *    community links never reach a retrievable section. During the proof run the model produced a
 *    correct Telegram link that was absent from its context, meaning it came from pretraining. Right
 *    that time, and not something to rely on.
 * 3. Carry a one-line index of every page, so the assistant can always point somewhere useful even
 *    when the keyword prefilter misses the section that held the answer. This is the safety net for
 *    the single risk the retrieval design introduces.
 */

/** Read the version table without importing JSX-adjacent module graph. */
export async function readVersions(versionsPath) {
  const mod = await import(`file://${versionsPath.replaceAll('\\', '/')}`);
  return { versions: mod.versions, repos: mod.repos, releases: mod.releases };
}

export function buildCore({ versions, repos, pages, community }) {
  const v = versions;
  const lines = [];

  lines.push('<core>');
  lines.push('These facts are authoritative and override anything in <documents> that disagrees.');
  lines.push('');
  lines.push('<software>');
  lines.push(`epic node: ${v.node}`);
  lines.push(`epic-wallet: ${v.wallet}`);
  lines.push(`epicbox protocol: ${v.epicboxProtocol}`);
  lines.push(`slate versions in use: ${v.slateVersions}`);
  lines.push(`owner API method count: ${v.ownerApiMethods}`);
  lines.push(`facts last verified against source: ${v.verifiedAgainst}`);
  lines.push('</software>');
  lines.push('');
  lines.push('<ports>');
  for (const [k, port] of Object.entries(v.ports)) lines.push(`${k}: ${port}`);
  lines.push('</ports>');
  lines.push('');
  lines.push('<consensus>');
  lines.push(`block time: ${v.blockTimeSeconds} seconds`);
  lines.push(`coinbase maturity, mainnet: ${v.coinbaseMaturity} blocks`);
  lines.push(`smallest unit: ${v.smallestUnit}, and 1 EPIC is ${v.epicBase} of them`);
  lines.push(`max block weight: ${v.maxBlockWeight}`);
  lines.push(`difficulty window: ${v.difficultyWindow}`);
  lines.push(`proof-of-work verification threshold: ${v.powVerificationThreshold}`);
  lines.push(`checkpoint count: ${v.checkpointCount}`);
  lines.push('</consensus>');
  lines.push('');
  lines.push('<epicbox>');
  lines.push(`relay domain: ${v.epicboxDomain}`);
  lines.push(`slate expiry: ${v.epicboxSlateExpiryDays} days`);
  lines.push(`handshake challenge window: ${v.epicboxChallengeSeconds} seconds`);
  lines.push('</epicbox>');
  lines.push('');
  lines.push('<repositories>');
  for (const [name, r] of Object.entries(repos)) lines.push(`${name}: ${r.url} at ${r.ref}`);
  lines.push('</repositories>');
  lines.push('');
  lines.push('<community>');
  lines.push('The only links you may offer when the documents do not cover a question:');
  for (const c of community) lines.push(`${c.label}: ${c.href}`);
  lines.push('</community>');
  lines.push('');
  lines.push('<page-index>');
  lines.push('Every page in the documentation. Use this to point a reader at the right page even when');
  lines.push('no section below covers their question.');
  for (const p of pages) lines.push(`${p.url} - ${p.title}${p.description ? `: ${p.description}` : ''}`);
  lines.push('</page-index>');
  lines.push('</core>');

  return lines.join('\n');
}

/**
 * Terms whose meaning a reader is likely to ask about and which a keyword prefilter would otherwise
 * have to find in a section. Kept short: this is a disambiguation aid, not a substitute for the docs.
 */
export const GLOSSARY = [
  ['slate', 'The partially built transaction passed between sender and receiver. A transfer needs two rounds, so both wallets must be reachable.'],
  ['epicbox', 'The relay that carries slates between wallets that are not directly reachable.'],
  ['freeman', 'The smallest unit of EPIC. Amounts in JSON are integer freemans serialised as strings.'],
  ['usernet', 'A single-node local test chain. Coinbase maturity is 3 blocks.'],
  ['floonet', 'The public test network. Coinbase maturity is 30 blocks.'],
  ['coinbase maturity', 'How many blocks must bury a mined reward before it can be spent. Separate from the wallet minimum_confirmations setting.'],
  ['minimum_confirmations', 'A wallet-side spend threshold, default 10, set per command with --min_conf. Not the same as coinbase maturity.'],
  ['RandomX', 'One of the proof-of-work algorithms. CPU-mineable, and the only one a single local miner can practically use.'],
  ['ProgPow', 'One of the proof-of-work algorithms, GPU-oriented.'],
  ['Cuckoo', 'A proof-of-work algorithm in the policy set. run_test_miner only mines Cuckoo, which is why it does not work on this chain.'],
  ['owner API', 'The wallet control surface on /v3/owner. Encrypted after an ECDH handshake. Can spend.'],
  ['foreign API', 'The wallet surface other parties talk to, on /v2/foreign. Receives slates.'],
];

export function buildGlossary() {
  const lines = ['<glossary>'];
  for (const [term, def] of GLOSSARY) lines.push(`${term}: ${def}`);
  lines.push('</glossary>');
  return lines.join('\n');
}
