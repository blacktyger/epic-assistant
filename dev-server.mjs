#!/usr/bin/env node
/**
 * Development launcher.
 *
 * config.mjs reads process.env at import time, so environment variables have to be set before it is
 * loaded. Doing that in the shell means either exporting across separate tool calls, which do not
 * share a process, or chaining statements, which is fragile on Windows PowerShell. Setting them here
 * and then dynamically importing the server is deterministic and works the same on every platform.
 *
 * Also: never stop this by killing every node process. On a machine where the agent runtime is also
 * node, `Stop-Process -Name node` takes down the session too. Use the printed PID.
 */
// 7771, assistant-dev in ports.json at the workspace root. Nothing else may claim it.
const port = process.env.EPIC_AI_PORT ?? '7771';

process.env.EPIC_AI_PORT = port;
// Fixed rather than random so a test run and a manual curl can share it. Development only; the
// deployed service takes this from its unit file.
process.env.EPIC_AI_ADMIN_TOKEN = process.env.EPIC_AI_ADMIN_TOKEN ?? 'dev-admin-token-not-for-production';

/*
 * Serves the last production build, which is what lets keyword search work under `docusaurus start`.
 *
 * The search theme only writes `search-index.json` in its `postBuild` hook, so the file exists in
 * build/ and nowhere else, and the Docusaurus dev server has no route to it. The dev proxy plugin in
 * site/plugins/assistant-dev-proxy.js forwards `/search-index.json` here, and this static root is
 * what answers it. Nobody browses this port directly, so serving the rest of the build alongside it
 * costs nothing.
 *
 * Consequence worth knowing while developing: the index is only as fresh as the last
 * `npm run build`, so a page added since then will not appear in keyword results even though the
 * page itself hot-reloads. The modal says so.
 */
process.env.EPIC_AI_STATIC_DIR = process.env.EPIC_AI_STATIC_DIR ?? '../epic-devhub/site/build';

console.log(`dev launcher: pid ${process.pid}, port ${port}`);
console.log(`stop with: Stop-Process -Id ${process.pid}`);

await import('./server.mjs');
