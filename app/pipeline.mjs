import { createHash, randomUUID } from 'node:crypto';
import { qualify, DEFAULT_ICP, configFromEnv } from './llm.mjs';

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.status = 422;
    this.field = field;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const SOURCE_ALIASES = {
  fb: 'facebook_ads',
  facebook: 'facebook_ads',
  'facebook lead ads': 'facebook_ads',
  fb_ads: 'facebook_ads',
  landing: 'landing_page',
  landingpage: 'landing_page',
  web: 'website_form',
  website: 'website_form',
  form: 'website_form',
  linkedin: 'linkedin',
  referral: 'referral',
  whatsapp: 'whatsapp',
  chat: 'website_chat',
};

// ---------------------------------------------------------------------------
// Normalisation: every lead source sends a slightly different shape. This is
// the only place that knows about those differences.
// ---------------------------------------------------------------------------

export function normalizeLead(input = {}) {
  const c = input.contact || input;
  const name = firstDefined(c.name, c.full_name, c.fullName, joinName(c.first_name, c.last_name), '');
  const email = String(firstDefined(c.email, c.email_address, c.mail, '') || '').trim().toLowerCase();
  const phone = normalizePhone(firstDefined(c.phone, c.phone_number, c.mobile, '') || '');
  const company = String(firstDefined(c.company, c.company_name, c.organization, '') || '').trim();
  const message = String(firstDefined(input.message, input.comments, input.notes, input.details, '') || '').trim();
  const rawSource = String(firstDefined(input.source, input.channel, input.utm_source, input.utm?.source, 'website_form') || 'website_form')
    .trim()
    .toLowerCase();
  const source = SOURCE_ALIASES[rawSource] || rawSource.replace(/\s+/g, '_');
  const budget = parseBudget(firstDefined(input.budget, input.budget_usd, input.budget_range, ''));
  const timeline = String(firstDefined(input.timeline, input.timeframe, input.start_date, '') || '').trim();

  if (!email && !phone) throw new ValidationError('A lead needs an email or a phone number.', 'email');
  if (email && !EMAIL_RE.test(email)) throw new ValidationError(`"${email}" is not a valid email address.`, 'email');
  if (!name) throw new ValidationError('A lead needs a name.', 'name');
  if (message.length > 8000) throw new ValidationError('Message is too long (max 8000 characters).', 'message');

  return {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    source,
    contact: { name: name.slice(0, 120), email, phone, company: company.slice(0, 160) },
    message: message.slice(0, 8000),
    budget_raw: firstDefined(input.budget, input.budget_usd, input.budget_range, '') || null,
    budget_usd: budget,
    timeline: timeline || null,
    utm: {
      source: input.utm?.source || null,
      medium: input.utm?.medium || null,
      campaign: input.utm?.campaign || null,
    },
    consent: Boolean(input.consent ?? input.opt_in ?? true),
    status: 'received',
  };
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function joinName(a, b) {
  const s = [a, b].filter(Boolean).join(' ').trim();
  return s || undefined;
}

export function normalizePhone(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits;
}

// "10k", "$10,000", "5-10k", "under 3k" -> 10000 / 7500 / 3000
export function parseBudget(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v).toLowerCase().replace(/,/g, '');
  const matches = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?/g)];
  const nums = matches.map((m) => {
    const n = Number(m[1]);
    return m[2] === 'k' ? n * 1_000 : m[2] === 'm' ? n * 1_000_000 : n;
  });
  if (!nums.length) return null;
  if (nums.length >= 2) {
    // "5-10k" means 5k-10k, not 5 to 10,000.
    const unit = matches[1][2];
    const low = matches[0][2] === unit ? nums[0] : unit === 'k' ? nums[0] * 1_000 : unit === 'm' ? nums[0] * 1_000_000 : nums[0];
    return Math.round((low + nums[1]) / 2);
  }
  return Math.round(nums[0]);
}

export function idempotencyKey(lead, headerKey) {
  if (headerKey) return String(headerKey).slice(0, 200);
  return createHash('sha256')
    .update(`${lead.source}|${lead.contact.email || lead.contact.phone}|${lead.message}`)
    .digest('hex')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Retry helper used around every outbound side effect.
// ---------------------------------------------------------------------------

export async function withRetry(fn, { attempts = 3, baseDelayMs = 120, sleep = defaultSleep, onAttempt } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (onAttempt) onAttempt(err, attempt);
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Routing + follow-up plan
// ---------------------------------------------------------------------------

export function routeLead(lead, qualification, { owners = ['Alex Chen', 'Priya Nair'], cursor = 0 } = {}) {
  const tier = qualification.tier;
  const owner = owners[cursor % owners.length];
  const slack = tier === 'hot' ? 15 * MIN : tier === 'warm' ? 4 * 60 * MIN : null;
  return {
    tier,
    owner: tier === 'cold' ? null : owner,
    queue: tier === 'hot' ? 'priority' : tier === 'warm' ? 'nurture' : 'archive',
    sla_due: slack ? new Date(Date.now() + slack).toISOString() : null,
    notified: tier === 'hot',
    routed_at: new Date().toISOString(),
  };
}

export function followupPlan(tier, now = Date.now()) {
  const steps = [];
  const add = (step, delay, subject) =>
    steps.push({
      step,
      due_at: new Date(now + delay).toISOString(),
      status: 'scheduled',
      subject,
    });
  if (tier === 'hot') {
    add('auto_reply', 0, 'Re: your enquiry — next steps');
    add('day_1_check_in', 1 * DAY, 'Quick question about your timeline');
    add('day_3_call', 3 * DAY, 'Worth a 20-minute call?');
  } else if (tier === 'warm') {
    add('auto_reply', 0, 'Re: your enquiry — a case study you might like');
    add('day_3_case_study', 3 * DAY, 'How we cut lead response time to 2 minutes');
    add('day_7_breakup', 7 * DAY, 'Should I close your file?');
  }
  return steps;
}

// ---------------------------------------------------------------------------
// CRM + notifications are adapters so the demo runs with zero external
// accounts, while production can point them at HubSpot/Pipedrive/Slack.
// ---------------------------------------------------------------------------

export function createAdapters({ store, env = process.env, fetchImpl = fetch, sleep } = {}) {
  return {
    async crmUpsert(lead) {
      const externalId = `crm_${createHash('sha1').update(lead.contact.email || lead.id).digest('hex').slice(0, 10)}`;
      const url = env.CRM_WEBHOOK_URL;
      if (url) {
        await withRetry(
          async () => {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ external_id: externalId, ...lead, qualification: lead.qualification }),
              signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) throw new Error(`CRM HTTP ${res.status}`);
          },
          { sleep },
        );
      }
      return { id: externalId, synced_at: new Date().toISOString(), target: url ? 'webhook' : 'local-crm' };
    },

    async notify(lead, qualification) {
      const payload = {
        type: 'hot_lead',
        lead_id: lead.id,
        name: lead.contact.name,
        company: lead.contact.company,
        score: qualification.score,
        next_action: qualification.next_action,
      };
      if (env.NOTIFY_WEBHOOK_URL) {
        await withRetry(async () => {
          const res = await fetchImpl(env.NOTIFY_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) throw new Error(`Notify HTTP ${res.status}`);
        }, { sleep });
        return { channel: 'slack', ...payload };
      }
      return { channel: 'log', ...payload };
    },

    async sendEmail({ to, subject, body, lead_id, step }) {
      store.recordOutbound({ kind: 'email', to, subject, body, lead_id, step });
      return { id: randomUUID(), sent_at: new Date().toISOString() };
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function createPipeline({ store, adapters, llmConfig = configFromEnv(), icp = DEFAULT_ICP, env = process.env }) {
  let ownerCursor = 0;

  async function intake(input, { idempotencyKey: key } = {}) {
    const lead = normalizeLead(input);
    const idem = idempotencyKey(lead, key);

    const existing = store.findByEmail(lead.contact.email);
    if (existing && existing.idempotency_key === idem) {
      store.addEvent({ lead_id: existing.id, type: 'duplicate_ignored', message: 'Idempotent retry ignored.' });
      return { lead: existing, duplicate: true };
    }

    lead.idempotency_key = idem;
    store.state.leads[lead.id] = lead;
    store.addEvent({ lead_id: lead.id, type: 'received', message: `Lead received from ${lead.source}.` });

    const started = Date.now();
    const qualification = await qualify(lead, {
      config: llmConfig,
      icp,
      onError: (err) => store.addEvent({ lead_id: lead.id, type: 'llm_error', message: err.message }),
    });
    lead.qualification = qualification;
    lead.status = 'qualified';
    store.addEvent({
      lead_id: lead.id,
      type: 'qualified',
      message: `${qualification.tier.toUpperCase()} ${qualification.score}/100 via ${qualification.engine}`,
      meta: { ms: Date.now() - started, degraded: qualification.degraded },
    });

    const routing = routeLead(lead, qualification, { cursor: ownerCursor++ });
    lead.routing = routing;
    store.addEvent({
      lead_id: lead.id,
      type: 'routed',
      message: `Routed to ${routing.owner || 'archive'} (${routing.queue}).`,
    });

    lead.followups = followupPlan(qualification.tier);
    if (qualification.tier === 'hot' || routing.notified) {
      try {
        const n = await adapters.notify(lead, qualification);
        store.recordOutbound({ kind: 'notification', ...n });
        store.addEvent({ lead_id: lead.id, type: 'notified', message: `Sales alert sent (${n.channel}).` });
      } catch (err) {
        store.deadLetter({ lead_id: lead.id, stage: 'notify', error: err.message });
        store.addEvent({ lead_id: lead.id, type: 'notify_failed', message: err.message });
      }
    }

    try {
      lead.crm = await adapters.crmUpsert(lead);
      store.addEvent({ lead_id: lead.id, type: 'crm_synced', message: `CRM record ${lead.crm.id} (${lead.crm.target}).` });
    } catch (err) {
      store.deadLetter({ lead_id: lead.id, stage: 'crm', error: err.message });
      store.addEvent({ lead_id: lead.id, type: 'crm_failed', message: err.message });
    }

    // Instant acknowledgement for hot/warm leads only.
    if (qualification.draft_reply && (qualification.tier === 'hot' || qualification.tier === 'warm')) {
      const first = lead.followups.find((f) => f.step === 'auto_reply');
      if (first) {
        try {
          await adapters.sendEmail({ to: lead.contact.email, subject: first.subject, body: qualification.draft_reply, lead_id: lead.id, step: 'auto_reply' });
          first.status = 'sent';
          first.sent_at = new Date().toISOString();
          store.addEvent({ lead_id: lead.id, type: 'auto_reply_sent', message: `Auto-reply sent to ${lead.contact.email}.` });
        } catch (err) {
          store.deadLetter({ lead_id: lead.id, stage: 'auto_reply', error: err.message });
        }
      }
    }

    lead.status = qualification.tier === 'cold' ? 'archived' : qualification.tier === 'hot' ? 'hot' : 'nurturing';
    lead.updated_at = new Date().toISOString();
    store.addEvent({ lead_id: lead.id, type: 'completed', message: `Pipeline finished in ${Date.now() - started} ms.` });
    await store.mutate(() => {});
    return { lead, duplicate: false };
  }

  async function tick(now = Date.now()) {
    const sent = [];
    for (const lead of Object.values(store.state.leads)) {
      for (const f of lead.followups || []) {
        if (f.status !== 'scheduled') continue;
        if (new Date(f.due_at).getTime() > now) continue;
        if (lead.status === 'archived') continue;
        await adapters.sendEmail({
          to: lead.contact.email,
          subject: f.subject,
          body: `Follow-up step: ${f.step}`,
          lead_id: lead.id,
          step: f.step,
        });
        f.status = 'sent';
        f.sent_at = new Date().toISOString();
        sent.push({ lead_id: lead.id, step: f.step });
        store.addEvent({ lead_id: lead.id, type: 'followup_sent', message: `Follow-up "${f.step}" sent.` });
      }
    }
    // Requeue hot leads that blew their SLA.
    for (const lead of Object.values(store.state.leads)) {
      if (lead.status !== 'hot' || !lead.routing?.sla_due) continue;
      if (lead.routing.sla_breached) continue;
      if (new Date(lead.routing.sla_due).getTime() < now) {
        lead.routing.sla_breached = true;
        store.addEvent({ lead_id: lead.id, type: 'sla_breached', message: 'First-touch SLA breached; escalated to team lead.' });
      }
    }
    await store.mutate(() => {});
    return sent;
  }

  return { intake, tick };
}
