/**
 * Cache of complete answers, keyed on the normalised question, model, answer locale and page path.
 *
 * The cheapest saving available. The head of a documentation question distribution is steep: "how do
 * I run a node", "what is epicbox", "why is my transaction stuck". A hit costs nothing, returns
 * instantly, and blunts the lazy abuse case where a script replays a fixed set of prompts.
 *
 * Keyed on the corpus version as well as the question, so a docs rebuild invalidates everything
 * rather than serving an answer about a version that no longer ships.
 */
import { createHash } from 'node:crypto';
import { answerCache as cfg } from '../config.mjs';

export function normaliseQuestion(q) {
  return q
    .toLowerCase()
    .replace(/[`"'*_~]/g, '')
    .replace(/[?!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class AnswerCache {
  #map = new Map(); // key -> {text, citations, at}
  #version;

  constructor(corpusVersion) {
    this.#version = corpusVersion;
  }

  #key(question, modelId, locale = 'en', pagePath = '/') {
    return createHash('sha256')
      .update(`${this.#version}\u0000${modelId}\u0000${locale}\u0000${pagePath}\u0000${normaliseQuestion(question)}`)
      .digest('base64url');
  }

  get(question, modelId, locale = 'en', pagePath = '/') {
    if (!cfg.enabled) return null;
    const key = this.#key(question, modelId, locale, pagePath);
    const hit = this.#map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > cfg.ttlSeconds * 1000) {
      this.#map.delete(key);
      return null;
    }
    // Refresh recency so the popular questions are the ones that survive eviction.
    this.#map.delete(key);
    this.#map.set(key, hit);
    return hit;
  }

  set(question, modelId, locale, pagePath, value) {
    // Backward-compatible three-argument form used by older callers and focused cache checks.
    if (pagePath === undefined) {
      value = locale;
      locale = 'en';
      pagePath = '/';
    } else if (value === undefined) {
      value = pagePath;
      pagePath = '/';
    }
    if (!cfg.enabled) return;
    // Never cache a refusal or an error. A refusal is often a retrieval miss that a later corpus
    // build fixes, and caching it would make the gap permanent for a day.
    if (!value.text || value.refused) return;

    const key = this.#key(question, modelId, locale, pagePath);
    this.#map.set(key, { ...value, at: Date.now() });

    // Map iteration order is insertion order, so the first key is the least recently used.
    while (this.#map.size > cfg.maxEntries) {
      this.#map.delete(this.#map.keys().next().value);
    }
  }

  get stats() {
    return { entries: this.#map.size, version: this.#version };
  }
}
