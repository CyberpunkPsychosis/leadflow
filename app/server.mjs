import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { createPipeline, createAdapters, ValidationError } from './pipeline.mjs';
import { configFromEnv, hasLiveLLM } from './llm.mjs';
import { SEED_LEADS } from './seed.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || join(__dirname, '..', 'data', 'state.json');
const PORT = Number(process.env.PORT || 8899);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const llmConfig = configFromEnv();

const store = new Store(DATA_FILE);
await store.init();
const adapters = createAdapters({ store });
const pipeline = createPipeline({ store, adapters, llmConfig });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('Payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function publicLead(lead) {
  return {
    id: lead.id,
    created_at: lead.created_at,
    source: lead.source,
    contact: lead.contact,
    message: lead.message,
    budget_usd: lead.budget_usd,
    budget_raw: lead.budget_raw,
    timeline: lead.timeline,
    status: lead.status,
    qualification: lead.qualification,
    routing: lead.routing,
    crm: lead.crm,
    followups: lead.followups,
    events: store.eventsFor(lead.id).slice(0, 40),
  };
}

const routes = [
  ['GET', /^\/api\/health$/, async () => ({
    ok: true,
    llm: hasLiveLLM() ? 'live' : 'rules-fallback',
    model: hasLiveLLM() ? llmConfig.model : null,
    leads: store.stats().total,
  })],

  ['GET', /^\/api\/stats$/, async () => store.stats()],

  ['GET', /^\/api\/leads$/, async (_req, _m, url) => {
    const tier = url.searchParams.get('tier');
    const source = url.searchParams.get('source');
    return store.list({ tier, source }).map(publicLead);
  }],

  ['GET', /^\/api\/leads\/([\w-]+)$/, async (_req, [id]) => {
    const lead = store.get(id);
    if (!lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
    return publicLead(lead);
  }],

  ['POST', /^\/api\/leads$/, async (req) => {
    if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
      throw Object.assign(new Error('Invalid webhook secret'), { status: 401 });
    }
    const body = await readJson(req);
    const result = await pipeline.intake(body, { idempotencyKey: req.headers['idempotency-key'] });
    return { ok: true, duplicate: result.duplicate, lead: publicLead(result.lead) };
  }],

  ['POST', /^\/api\/tick$/, async () => {
    const sent = await pipeline.tick();
    return { ok: true, sent };
  }],

  ['POST', /^\/api\/demo\/seed$/, async () => {
    const created = [];
    for (const input of SEED_LEADS) {
      const r = await pipeline.intake(input, { idempotencyKey: `seed:${input.email || input.contact?.email}` });
      created.push(r.lead.id);
    }
    return { ok: true, created: created.length };
  }],

  ['POST', /^\/api\/demo\/advance$/, async (req) => {
    // Demo-only: pretend N hours passed so scheduled follow-ups become due.
    const { hours = 0 } = await readJson(req);
    const shift = Number(hours) * 3600_000;
    if (!Number.isFinite(shift) || shift <= 0) throw Object.assign(new Error('hours must be > 0'), { status: 422 });
    let shifted = 0;
    for (const lead of Object.values(store.state.leads)) {
      for (const f of lead.followups || []) {
        if (f.status === 'scheduled' && new Date(f.due_at).getTime() > Date.now()) {
          f.due_at = new Date(new Date(f.due_at).getTime() - shift).toISOString();
          shifted += 1;
        }
      }
    }
    await store.mutate(() => {});
    return { ok: true, shifted };
  }],

  ['POST', /^\/api\/demo\/reset$/, async () => {
    await store.mutate((s) => {
      s.leads = {};
      s.events = [];
      s.dlq = [];
      s.outbox = [];
    });
    return { ok: true };
  }],
];

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(pattern);
      if (!m) continue;
      const body = await handler(req, m.slice(1), url);
      return send(res, 200, body);
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    send(res, status, { error: err.message, field: err.field });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LeadFlow listening on http://127.0.0.1:${PORT}`);
  console.log(`LLM: ${hasLiveLLM() ? `live (${llmConfig.model})` : 'rules fallback (no LLM_API_KEY)'}`);
});

// Cron-style ticker for follow-ups. 30s is plenty for a demo; production would
// use n8n's Schedule Trigger or a queue worker.
setInterval(() => {
  pipeline.tick().catch((err) => console.error('[tick]', err));
}, 30_000).unref();
