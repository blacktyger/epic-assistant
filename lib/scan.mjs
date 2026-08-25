/**
 * Corpus injection scan. Runs in CI and fails the build.
 *
 * The docs are contributed by public pull request, so retrieved corpus text is a partly untrusted
 * channel. The system prompt tells the model that text inside the document tags is data, never
 * instruction, but that is advice: it is model-mediated and can be argued with. This is the gate.
 *
 * Deliberately fails rather than sanitising. A sanitiser hides the interesting question, which is why
 * a phrase like "ignore previous instructions" is in a documentation page at all. A human should look.
 */

/** Tag names the prompt uses for structure. A document containing one of these can break delimiting. */
export const STRUCTURAL_TAGS = [
  'documents', 'document', 'document_content', 'source', 'instructions',
  'role', 'core', 'scope', 'grounding', 'followup', 'format',
];

const PATTERNS = [
  {
    id: 'instruction-override',
    severity: 'fail',
    re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding)\s+(instruction|prompt|direction|rule|message)/i,
    why: 'classic prompt-injection override phrasing',
  },
  {
    id: 'role-redefinition',
    severity: 'fail',
    re: /\byou\s+are\s+now\s+(a|an|the)\b|\bfrom\s+now\s+on\s+you\s+(will|must|shall)\b|\bact\s+as\s+(if\s+you\s+are\s+)?(a|an|the)\s+\w+\s+(assistant|model|ai)\b/i,
    why: 'attempts to redefine the assistant role',
  },
  {
    id: 'prompt-exfiltration',
    severity: 'fail',
    re: /\b(reveal|print|output|repeat|show|disclose)\s+(your|the)\s+(system\s+prompt|instructions|initial\s+prompt|prompt)\b/i,
    why: 'attempts to extract the system prompt',
  },
  {
    id: 'new-instructions',
    severity: 'fail',
    re: /\b(new|updated|revised|additional)\s+instructions?\s*:/i,
    why: 'injects a fresh instruction block',
  },
  {
    id: 'zero-width',
    severity: 'fail',
    re: /[\u200b\u200c\u200d\u2060\ufeff]/,
    why: 'zero-width characters can hide text from a reviewer but not from the model',
  },
  {
    id: 'bidi-override',
    severity: 'fail',
    re: /[\u202a-\u202e\u2066-\u2069]/,
    why: 'bidirectional overrides can make rendered text differ from source order',
  },
  {
    id: 'model-directed-imperative',
    severity: 'warn',
    re: /\b(assistant|model|chatbot|ai)\s*[,:]\s*(please\s+)?(do|say|tell|answer|respond|reply|write)\b/i,
    why: 'text addressed at a model rather than a reader',
  },
];

/**
 * @param {{id: string, text: string, breadcrumb: string}[]} sections
 * @returns {{findings: object[], failed: boolean}}
 */
export function scanSections(sections) {
  const findings = [];

  for (const s of sections) {
    for (const p of PATTERNS) {
      const m = s.text.match(p.re);
      if (m) {
        findings.push({
          rule: p.id,
          severity: p.severity,
          why: p.why,
          section: s.id,
          breadcrumb: s.breadcrumb,
          excerpt: excerpt(s.text, m.index ?? 0),
        });
      }
    }
    // Structural tag confusion is the one vector that reliably defeats delimiting, so it is
    // checked as a literal rather than folded into the regex list above.
    for (const tag of STRUCTURAL_TAGS) {
      const re = new RegExp(`</?${tag}\\b[^>]*>`, 'i');
      const m = s.text.match(re);
      if (m) {
        findings.push({
          rule: 'structural-tag',
          severity: 'fail',
          why: `contains <${tag}>, which is a tag the prompt uses for structure`,
          section: s.id,
          breadcrumb: s.breadcrumb,
          excerpt: excerpt(s.text, m.index ?? 0),
        });
      }
    }
  }

  return { findings, failed: findings.some((f) => f.severity === 'fail') };
}

function excerpt(text, at) {
  const from = Math.max(0, at - 60);
  return (from > 0 ? '...' : '') + text.slice(from, at + 120).replace(/\s+/g, ' ') + '...';
}
