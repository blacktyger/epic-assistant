#!/usr/bin/env node
/**
 * One-command local preview: the built documentation site and the assistant API on a single origin.
 *
 * This is the shape production has, and it is the reason the panel appeared to work while the agent
 * was unreachable. The panel calls a relative `/api/chat`, and the site's CSP is `connect-src 'self'`,
 * so a call to the API on another port is refused by the browser before it leaves the page. No CORS
 * header fixes that; the two have to share an origin. In production nginx does it. Locally, this does.
 *
 *   cd epic-devhub/site && npm run build
 *   cd ../../epic-assistant && node preview.mjs
 *   open http://127.0.0.1:7772
 *
 * Environment is set before importing config.mjs, which reads process.env at import time.
 */
// 7772, assistant-preview in ports.json at the workspace root. It was 8790, which the visual
// channel also defaulted to, so both ran and every URL quoted as 8790 opened whichever started first.
process.env.EPIC_AI_PORT = process.env.EPIC_AI_PORT ?? '7772';
process.env.EPIC_AI_STATIC_DIR = process.env.EPIC_AI_STATIC_DIR ?? '../epic-devhub/site/build';
process.env.EPIC_AI_ALLOWED_ORIGINS =
  process.env.EPIC_AI_ALLOWED_ORIGINS ??
  `https://devdocs.epiccash.com,http://127.0.0.1:${process.env.EPIC_AI_PORT},http://localhost:${process.env.EPIC_AI_PORT}`;

console.log(`preview: pid ${process.pid}`);
console.log(`stop with: Stop-Process -Id ${process.pid}`);

await import('./server.mjs');
