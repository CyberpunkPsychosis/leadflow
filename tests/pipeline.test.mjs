import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import {
  normalizeLead,
  parseBudget,
  normalizePhone,
  routeLead,
  followupPlan,
  createPipeline,
  createAdapters,
  withRetry,
  ValidationError,
} from '../app/pipeline.mjs';
import { heuristicQualify, tierForScore, parseJsonObject, normalizeQualification } from '../app/llm.mjs';

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), 'leadflow-'));
  const store = new Store(join(dir, 'state.json'));
  await store.init();
  return store;
}

test('normalizeLead accepts messy field aliases', () => {
  const lead = normalizeLead({
    source: 'FB',
    full_name: 'Jane Cooper',
    email_address: '  JANE@Acme.COM ',
    company_name: 'Acme',
    comments: 'Need help with automation.',
    budget_range: '10k-20k',
    timeframe: 'next month',
  });
  assert.equal(lead.contact.name, 'Jane Cooper');
  assert.equal(lead.contact.email, 'jane@acme.com');
  assert.equal(lead.source, 'facebook_ads');
  assert.equal(lead.budget_usd, 15000);
  assert.equal(lead.timeline, 'next month');
});

test('normalizeLead rejects leads with no contact and bad emails', () => {
  assert.throws(() => normalizeLead({ name: 'No Contact' }), ValidationError);
  assert.throws(() => normalizeLead({ name: 'Bad', email: 'not-an-email' }), ValidationError);
});

test('parseBudget handles common formats', () => {
  assert.equal(parseBudget('$10,000'), 10000);
  assert.equal(parseBudget('10k'), 10000);
  assert.equal(parseBudget('5-10k'), 7500);
  assert.equal(parseBudget('USD 40,000'), 40000);
  assert.equal(parseBudget(''), null);
  assert.equal(parseBudget(8000), 8000);
});

test('normalizePhone strips separators but keeps country code', () => {
  assert.equal(normalizePhone('(415) 555-0137'), '4155550137');
  assert.equal(normalizePhone('+1 512 555 0191'), '+15125550191');
});

test('tier thresholds are stable', () => {
  assert.equal(tierForScore(70), 'hot');
  assert.equal(tierForScore(69), 'warm');
  assert.equal(tierForScore(40), 'warm');
  assert.equal(tierForScore(39), 'cold');
});

test('qualification output is clamped and self-consistent', () => {
  const q = normalizeQualification({ score: 140, tier: 'cold', reasons: ['x'] });
  assert.equal(q.score, 100);
  assert.equal(q.tier, 'hot');
  const bad = normalizeQualification({});
  assert.equal(bad.score, 0);
  assert.equal(bad.reasons.length, 1);
});

test('rules engine flags spam and free-work leads', () => {
  const spam = heuristicQualify({ message: 'We offer SEO services and buy backlinks', contact: {} });
  assert.equal(spam.tier, 'cold');
  assert.ok(spam.flags.includes('spam'));

  const student = heuristicQualify({
    message: 'I am a student, can you help for free?',
    contact: { name: 'S' },
    budget_usd: 50000,
  });
  assert.equal(student.tier, 'cold');
});

test('rules engine scores a strong lead hot and drafts a reply', () => {
  const q = heuristicQualify({
    message:
      'We are evaluating vendors for patient intake automation across 12 clinics. Budget approved, procurement deadline at end of quarter. Can you send a proposal?',
    contact: { name: 'Nisha Rao', company: 'Zenwell Health', email: 'n@z.com' },
    budget_usd: 40000,
    timeline: 'Q1',
  });
  assert.equal(q.tier, 'hot');
  assert.ok(q.score >= 70);
  assert.match(q.draft_reply, /Nisha/);
});

test('parseJsonObject tolerates code fences and prose', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Here you go: {"a":2} thanks'), { a: 2 });
});

test('routing assigns an owner and SLA per tier', () => {
  const hot = routeLead({}, { tier: 'hot' }, { owners: ['A', 'B'], cursor: 1 });
  assert.equal(hot.owner, 'B');
  assert.equal(hot.queue, 'priority');
  assert.ok(hot.sla_due);
  const cold = routeLead({}, { tier: 'cold' });
  assert.equal(cold.owner, null);
  assert.equal(cold.queue, 'archive');
});

test('follow-up plans differ by tier', () => {
  assert.equal(followupPlan('hot').length, 3);
  assert.equal(followupPlan('warm').length, 3);
  assert.equal(followupPlan('cold').length, 0);
  assert.equal(followupPlan('hot')[0].step, 'auto_reply');
});

test('withRetry retries then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('boom');
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry surfaces the final error', async () => {
  await assert.rejects(
    withRetry(async () => { throw new Error('always'); }, { attempts: 2, sleep: async () => {} }),
    /always/,
  );
});

test('pipeline end to end: qualify, route, CRM, auto-reply, persist', async () => {
  const store = await newStore();
  const sent = [];
  const adapters = createAdapters({ store });
  adapters.sendEmail = async (msg) => { sent.push(msg); return { id: 'm1' }; };
  const pipeline = createPipeline({ store, adapters, llmConfig: { apiKey: '' } });

  const { lead, duplicate } = await pipeline.intake({
    name: 'Sarah Mitchell',
    email: 'sarah@brightline.com',
    company: 'Brightline Logistics',
    source: 'website_form',
    budget: '15k-25k',
    message: 'We need to automate lead intake and routing. Can you send a proposal?',
  });
  assert.equal(duplicate, false);
  assert.equal(lead.qualification.tier, 'hot');
  assert.equal(lead.routing.queue, 'priority');
  assert.ok(lead.crm.id.startsWith('crm_'));
  assert.equal(sent.length, 1);

  // Same payload again (webhook retry) must not create a second lead.
  const again = await pipeline.intake({
    name: 'Sarah Mitchell',
    email: 'sarah@brightline.com',
    company: 'Brightline Logistics',
    source: 'website_form',
    budget: '15k-25k',
    message: 'We need to automate lead intake and routing. Can you send a proposal?',
  });
  assert.equal(again.duplicate, true);
  assert.equal(store.stats().total, 1);

  // State survives a restart.
  const reloaded = new Store(store.file);
  await reloaded.init();
  assert.equal(reloaded.stats().total, 1);
});

test('pipeline degrades gracefully when the LLM call fails', async () => {
  const store = await newStore();
  const adapters = createAdapters({ store });
  adapters.sendEmail = async () => ({ id: 'x' });
  const pipeline = createPipeline({
    store,
    adapters,
    llmConfig: { apiKey: 'test', baseUrl: 'http://127.0.0.1:1', model: 'nope', timeoutMs: 500 },
  });
  const { lead } = await pipeline.intake({
    name: 'Tom Becker',
    email: 'tom@becker.com',
    message: 'How much for a simple chatbot?',
  });
  assert.equal(lead.qualification.engine, 'rules');
  assert.equal(lead.qualification.degraded, true);
  assert.ok(lead.qualification.model === null);
});

test('CRM webhook failure lands in the dead-letter queue, lead still closes', async () => {
  const store = await newStore();
  const failingFetch = async () => ({ ok: false, status: 503 });
  const adapters = createAdapters({ store, env: { CRM_WEBHOOK_URL: 'http://crm.local/x' }, fetchImpl: failingFetch, sleep: async () => {} });
  adapters.sendEmail = async () => ({ id: 'x' });
  const pipeline = createPipeline({ store, adapters, llmConfig: { apiKey: '' } });
  const { lead } = await pipeline.intake({ name: 'Lena', email: 'lena@x.de', message: 'Interested in HubSpot integration, budget 5k' });
  assert.equal(lead.crm, undefined);
  assert.equal(store.stats().dlq, 1);
  assert.equal(store.stats().total, 1);
});

test('tick sends only due follow-ups and never to archived leads', async () => {
  const store = await newStore();
  const sent = [];
  const adapters = createAdapters({ store });
  adapters.sendEmail = async (msg) => { sent.push(msg); return { id: 'x' }; };
  const pipeline = createPipeline({ store, adapters, llmConfig: { apiKey: '' } });
  await pipeline.intake({ name: 'Hot Lead', email: 'hot@x.com', budget: '20000', message: 'Need automation ASAP, can you send a quote?' });
  sent.length = 0;
  const day = 24 * 60 * 60 * 1000;
  const due = await pipeline.tick(Date.now() + 2 * day);
  assert.ok(due.length >= 1);
  assert.ok(sent.every((m) => m.step !== 'day_3_call'));
});
