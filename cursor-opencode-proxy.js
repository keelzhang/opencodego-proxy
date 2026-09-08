'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STRATEGIES = ['auto', 'per-request', 'static'];
const PROBE_HEADERS = ['x-session-id', 'x-client-session-id', 'x-request-id'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function loadConfig(file, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`config: cannot read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config: invalid JSON in ${file}: ${e.message}`);
  }
  const cfg = {
    port: 8787,
    baseUrl: '',
    apiKey: '',
    session: { strategy: 'auto', header: 'x-opencode-session', staticId: '00000000-0000-4000-8000-000000000000', ttlMs: 7200000 },
    log: { headers: true, body: false },
  };
  const missing = [];
  if (typeof parsed.baseUrl === 'string' && parsed.baseUrl) cfg.baseUrl = parsed.baseUrl.replace(/\/+$/, '');
  else missing.push('baseUrl');
  if (typeof parsed.apiKey === 'string' && parsed.apiKey) cfg.apiKey = parsed.apiKey;
  else missing.push('apiKey');
  if (missing.length) throw new Error(`config: missing: ${missing.join(', ')}`);
  if (Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) cfg.port = parsed.port;
  if (typeof env.COP_PORT === 'string' && /^\d+$/.test(env.COP_PORT) && +env.COP_PORT > 0 && +env.COP_PORT < 65536) cfg.port = +env.COP_PORT;
  if (typeof env.COP_BASE_URL === 'string' && env.COP_BASE_URL) cfg.baseUrl = env.COP_BASE_URL.replace(/\/+$/, '');
  if (typeof env.COP_API_KEY === 'string' && env.COP_API_KEY) cfg.apiKey = env.COP_API_KEY;
  if (parsed.session && typeof parsed.session === 'object') {
    if (typeof parsed.session.header === 'string' && parsed.session.header) cfg.session.header = parsed.session.header;
    if (typeof parsed.session.staticId === 'string' && parsed.session.staticId) cfg.session.staticId = parsed.session.staticId;
    if (Number.isInteger(parsed.session.ttlMs) && parsed.session.ttlMs > 0) cfg.session.ttlMs = parsed.session.ttlMs;
    if (STRATEGIES.includes(parsed.session.strategy)) cfg.session.strategy = parsed.session.strategy;
    else throw new Error(`config: invalid session.strategy: ${JSON.stringify(parsed.session.strategy)} (allowed: ${STRATEGIES.join(', ')})`);
  }
  if (parsed.log && typeof parsed.log === 'object') {
    if (typeof parsed.log.headers === 'boolean') cfg.log.headers = parsed.log.headers;
    if (typeof parsed.log.body === 'boolean') cfg.log.body = parsed.log.body;
  }
  return cfg;
}

module.exports = { loadConfig };
