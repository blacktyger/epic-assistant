/**
 * Reader for the workspace `.secrets` file.
 *
 * One parser, used by config.mjs to resolve the node endpoint and by bedrock.mjs to resolve the
 * Bedrock credential. It existed twice before, inline in bedrock.mjs and about to be written again for
 * the tool layer, and two parsers for one file format is how a quoted value starts working in one
 * place and not the other.
 *
 * Format is `KEY=value`, one per line, no quoting and no interpolation, matching how the file is
 * already written and read by the PowerShell snippets in the steering notes. Surrounding quotes are
 * stripped if present, because a value pasted from another tool often carries them and the resulting
 * failure, a 401 with a quote in the password, is unpleasant to diagnose.
 *
 * Nothing here logs a value, and nothing here returns the file's contents wholesale to a caller that
 * only asked for one key.
 */
import { readFileSync } from 'node:fs';

/** Parses the file into a plain object. Returns `{}` when the file is absent or unreadable. */
export function parseSecrets(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Fills gaps in `env` from the secrets file, never overwriting a value already present.
 *
 * The precedence direction is the important part. A systemd unit, a container environment or a test
 * harness sets a variable deliberately, and a file on disk should not be able to override that. It
 * only supplies what nobody has stated.
 *
 * @param {Record<string, string|undefined>} env  usually process.env
 * @param {string|URL} defaultPath  used when EPIC_AI_SECRETS is not set
 * @returns {string[]} the key names that were filled in, for logging without values
 */
export function readSecretsInto(env, defaultPath) {
  const path = env.EPIC_AI_SECRETS
    ? env.EPIC_AI_SECRETS
    : defaultPath instanceof URL
      ? fileUrlToPath(defaultPath)
      : defaultPath;

  const parsed = parseSecrets(path);
  const filled = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      filled.push(key);
    }
  }
  return filled;
}

/**
 * `fileURLToPath` from node:url, inlined for one call.
 *
 * Not laziness: on Windows a file URL is `file:///c:/...`, and naively taking `url.pathname` yields
 * `/c:/...`, a path that fails to open with a message that blames the file rather than the caller.
 * This is the documented conversion and is why the URL is not passed through as a string.
 */
function fileUrlToPath(url) {
  let p = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}
