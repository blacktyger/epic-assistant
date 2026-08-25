/**
 * Keyword retrieval over the section corpus.
 *
 * Deliberately not embeddings. Two reasons, and only the second is about cost.
 *
 * The queries this corpus attracts are identifier-shaped: `only_randomx`, `--min_conf`,
 * `minimum_confirmations`, `init_send_tx`, `enable_stratum_server`, `3416`. Exact-token matching is
 * strongest exactly where dense vectors are weakest, and a docs corpus about a Rust project is mostly
 * exact tokens. Second, the whole corpus is 81,161 tokens, so there is no scale argument for an ANN
 * index; a keyword pass over 413 sections is sub-millisecond in process.
 *
 * The known failure mode is a conceptual question phrased with none of the corpus vocabulary. Three
 * mitigations, in order of value: the always-present page index in the core block means the assistant
 * can still point somewhere; a synonym map maps reader words onto corpus words; and top-k is generous
 * because a section costs about 134 tokens, so over-retrieving is cheap insurance.
 */
import MiniSearch from 'minisearch';

/**
 * Reader vocabulary mapped onto corpus vocabulary. This is the deterministic, free version of query
 * expansion. Published comparisons find HyDE and multi-query expansion work largely because the
 * generated text contains the keywords a real answer would contain, which for a fixed domain
 * vocabulary a hand-written map achieves at zero latency and zero token cost.
 */
export const SYNONYMS = {
  stuck: ['unconfirmed', 'locked', 'cancel', 'pending'],
  pending: ['unconfirmed', 'locked'],
  fee: ['fees', 'kernel', 'freeman'],
  fees: ['fee'],
  send: ['send', 'transfer', 'init_send_tx', 'slate'],
  receive: ['receive', 'foreign', 'slate'],
  password: ['password', 'open_wallet'],
  seed: ['mnemonic', 'seed', 'recovery'],
  mnemonic: ['seed', 'recovery'],
  backup: ['mnemonic', 'seed', 'restore'],
  restore: ['recover', 'scan', 'mnemonic'],
  balance: ['retrieve_summary_info', 'spendable', 'outputs'],
  mining: ['stratum', 'randomx', 'progpow', 'miner'],
  mine: ['stratum', 'randomx', 'miner'],
  miner: ['stratum', 'randomx', 'progpow'],
  gpu: ['progpow'],
  cpu: ['randomx'],
  reward: ['emission', 'coinbase', 'foundation'],
  emission: ['reward', 'coinbase'],
  address: ['epicbox', 'addresses', 'slatepack'],
  port: ['ports', 'listen'],
  auth: ['authentication', 'api_secret', 'basic'],
  login: ['authentication', 'open_wallet'],
  testnet: ['floonet', 'usernet'],
  local: ['usernet'],
  confirmations: ['minimum_confirmations', 'min_conf', 'maturity'],
  install: ['build', 'downloads', 'binaries'],
  compile: ['build', 'cargo', 'rust'],
  exchange: ['exchange-integration', 'integration'],
  proof: ['payment_proof', 'proofs'],
  privacy: ['mimblewimble', 'blinding', 'commitment'],
};

/**
 * Dropped from queries only, never from the index. The tokenizer splits on underscores so that a
 * reader can find `only_randomx` by typing either the whole key or `randomx`. The side effect is that
 * `only` enters the query as a term of its own and matches every heading containing the word, which
 * is how "Read only" on the Owner API page outranked the section documenting `only_randomx`.
 */
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'do', 'does', 'did', 'how', 'what', 'why', 'when',
  'where', 'which', 'who', 'i', 'me', 'my', 'you', 'your', 'it', 'its', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'but', 'with', 'from', 'at', 'by', 'as', 'if', 'so', 'that', 'this', 'these',
  'can', 'could', 'should', 'would', 'will', 'get', 'got', 'use', 'using', 'only', 'not', 'no',
  'there', 'here', 'about', 'into', 'out', 'up', 'down', 'any', 'all', 'some', 'need', 'want',
]);

export function loadRetriever(corpus) {
  const index = MiniSearch.loadJSON(JSON.stringify(corpus.index), {
    idField: 'i',
    fields: ['breadcrumb', 'heading', 'title', 'text'],
    storeFields: ['id'],
    tokenize: (str) => str.split(/[\s\-_./:()[\]{}<>,;"'`=|]+/u).filter(Boolean),
    processTerm: (term) => (term.length > 1 ? term.toLowerCase() : null),
  });
  const byId = new Map(corpus.sections.map((s) => [s.id, s]));
  const byIdx = corpus.sections;
  return { index, byId, byIdx, corpus };
}

export function expandQuery(question) {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const extra = new Set();
  for (const w of words) {
    for (const syn of SYNONYMS[w] ?? []) extra.add(syn);
  }
  return extra.size ? `${question} ${[...extra].join(' ')}` : question;
}

/**
 * @returns {{sections: object[], tokensApprox: number, expanded: string}}
 *
 * topK defaults to 16 rather than a rounder, more generous number because the sweep in
 * test-retrieval.mjs shows recall over 30 questions saturating at 100% by topK 6. Sections average
 * 134 tokens, so 16 buys roughly 4,000 tokens of context, about $0.030 a question on Sonnet 4.6, and
 * leaves headroom for questions whose answer spans several sections (a usernet mining setup needs
 * four separate config sections) without paying for the long tail of weak matches. tokenBudget is the
 * backstop for the case where retrieval happens to select several oversized code-example sections.
 */
export function retrieve(retriever, question, { topK = 16, tokenBudget = 14000 } = {}) {
  const expanded = expandQuery(question);
  const hits = retriever.index.search(expanded, {
    boost: { breadcrumb: 3, heading: 3, title: 2 },
    combineWith: 'OR',
    // Per-term rather than blanket. Blanket prefix+fuzzy made short common words behave like
    // wildcards: the query `only_randomx` tokenises to `only` + `randomx`, and `only` fuzzy-matched
    // the heading "Read only" on the Owner API page, which then outranked the section that actually
    // documents `only_randomx`. Long terms still get both, so `authentcation` and `stratm` recover.
    prefix: (term) => term.length >= 5,
    fuzzy: (term) => (term.length >= 6 ? 0.15 : false),
    // Query-side only. Dropping a stopword from the query cannot lose a document, because every
    // content term still matches; it only stops the noise word from carrying rank.
    processTerm: (term) => {
      const t = term.toLowerCase();
      if (t.length < 2 || QUERY_STOPWORDS.has(t)) return null;
      return t;
    },
  });

  const picked = [];
  let chars = 0;
  const limit = tokenBudget * 3.3;
  const seenPages = new Map();

  for (const hit of hits) {
    if (picked.length >= topK || chars >= limit) break;
    const section = retriever.byIdx[hit.i] ?? retriever.byId.get(hit.id);
    if (!section) continue;
    // Cap how much one page can dominate, so a long API page cannot crowd out the concept page
    // that actually explains the reader's question.
    const n = seenPages.get(section.pageUrl) ?? 0;
    if (n >= 8) continue;
    seenPages.set(section.pageUrl, n + 1);
    picked.push({ ...section, score: hit.score });
    chars += section.text.length;
  }

  return {
    sections: picked,
    tokensApprox: Math.round(chars / 3.3),
    expanded,
    totalHits: hits.length,
  };
}

/** Renders retrieved sections as the tagged, delimited document block the prompt expects. */
export function renderDocuments(sections) {
  const parts = ['<documents>'];
  sections.forEach((s, i) => {
    parts.push(`<document index="${i + 1}">`);
    parts.push(`<source>${s.url}</source>`);
    parts.push(`<breadcrumb>${s.breadcrumb}</breadcrumb>`);
    parts.push('<document_content>');
    parts.push(s.text);
    parts.push('</document_content>');
    parts.push('</document>');
  });
  parts.push('</documents>');
  return parts.join('\n');
}
