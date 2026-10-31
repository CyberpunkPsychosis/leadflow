// LLM qualification adapter.
// Works with any OpenAI-compatible chat API (DeepSeek, OpenAI, Groq, Ollama).
// Falls back to a deterministic rules engine when no key is configured or the
// model keeps returning unusable output, so the pipeline never drops a lead.

export const DEFAULT_ICP = {
  company: 'Northwind Growth',
  offer: 'Revenue operations and AI automation for B2B service companies',
  target_industries: ['SaaS', 'agency', 'professional services', 'logistics', 'healthtech'],
  min_budget_usd: 5000,
  geography: 'US, UK, EU, Australia',
  disqualifiers: [
    'crypto / gambling / adult traffic',
    'SEO link-selling or guest-post spam',
    'students or free-work requests',
    'budget under $1,000',
  ],
};

const SYSTEM_PROMPT = `You are a senior B2B lead qualification analyst. You score inbound leads for a company and decide how sales should handle them.

BUSINESS CONTEXT
Company: {company}
Offer: {offer}
Target industries: {industries}
Minimum viable budget: {min_budget} USD
Geography: {geography}
Hard disqualifiers: {disqualifiers}

SCORING RUBRIC (0-100)
- fit (0-30): industry and company profile match
- intent (0-30): how explicitly they ask to buy or start a project
- urgency (0-20): timeline and deadline pressure
- budget (0-20): stated or implied budget vs. minimum

TIERS
- 70-100 => "hot" (contact within 15 minutes, book a call)
- 40-69 => "warm" (reply today, nurture with useful content)
- 0-39 => "cold" (archive or long-term nurture)

RULES
- Never invent facts. If a field is missing, say "unknown" instead of guessing.
- Quote evidence from the lead message in "reasons" (short phrases).
- If a disqualifier applies, set tier "cold" and score <= 20 regardless of other signals.
- The draft reply must be under 90 words, reference something specific from their message, ask at most one question, and never promise pricing.

Respond with STRICT JSON only:
{
  "score": number,
  "tier": "hot" | "warm" | "cold",
  "intent": string,            // e.g. "ready to buy", "researching", "vendor spam"
  "urgency": "now" | "this_week" | "this_month" | "later" | "unknown",
  "budget_fit": "in_range" | "below_range" | "above_range" | "unknown",
  "reasons": string[],         // 2-4 short evidence bullets
  "missing_info": string[],
  "flags": string[],           // risk / spam / routing notes
  "next_action": string,       // one concrete sales action
  "draft_reply": string
}`;

function fill(template, icp) {
  return template
    .replaceAll('{company}', icp.company)
    .replaceAll('{offer}', icp.offer)
    .replaceAll('{industries}', icp.target_industries.join(', '))
    .replaceAll('{geography}', icp.geography)
    .replaceAll('{disqualifiers}', icp.disqualifiers.join('; '))
    .replaceAll('{min_budget}', icp.min_budget_usd);
}

export function configFromEnv(env = process.env) {
  return {
    baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'deepseek-chat',
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 20000),
  };
}

export function hasLiveLLM(env = process.env) {
  return Boolean(env.LLM_API_KEY);
}

function leadPayload(lead) {
  return {
    source: lead.source,
    name: lead.contact.name || 'unknown',
    email: lead.contact.email || 'unknown',
    company: lead.contact.company || 'unknown',
    message: lead.message,
    budget_usd: lead.budget_usd ?? 'unknown',
    timeline: lead.timeline || 'unknown',
    utm: lead.utm || {},
  };
}

export async function qualifyWithLLM(lead, { config, icp = DEFAULT_ICP, fetchImpl = fetch }) {
  const started = Date.now();
  const body = {
    model: config.model,
    temperature: 0.2,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: fill(SYSTEM_PROMPT, icp) },
      { role: 'user', content: `QUALIFY THIS LEAD:\n${JSON.stringify(leadPayload(lead), null, 2)}` },
    ],
  };
  const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned an empty completion');
  const parsed = parseJsonObject(content);
  return normalizeQualification(parsed, { engine: 'llm', model: config.model, latencyMs: Date.now() - started });
}

export function parseJsonObject(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Could not parse JSON from model output');
  }
}

const TIERS = new Set(['hot', 'warm', 'cold']);

export function normalizeQualification(raw, meta = {}) {
  const score = clamp(Math.round(Number(raw.score) || 0), 0, 100);
  let tier = TIERS.has(raw.tier) ? raw.tier : tierForScore(score);
  // Keep tier and score coherent even if the model contradicts itself.
  tier = tierForScore(score);
  const flags = asStrings(raw.flags).slice(0, 5);
  const reasons = asStrings(raw.reasons).slice(0, 5);
  const missing = asStrings(raw.missing_info).slice(0, 6);
  return {
    score,
    tier,
    intent: String(raw.intent || 'unknown').slice(0, 120),
    urgency: ['now', 'this_week', 'this_month', 'later', 'unknown'].includes(raw.urgency)
      ? raw.urgency
      : 'unknown',
    budget_fit: ['in_range', 'below_range', 'above_range', 'unknown'].includes(raw.budget_fit)
      ? raw.budget_fit
      : 'unknown',
    reasons: reasons.length ? reasons : ['No explicit buying signals found in the message.'],
    missing_info: missing,
    flags,
    next_action: String(raw.next_action || 'Review manually').slice(0, 200),
    draft_reply: String(raw.draft_reply || '').slice(0, 1200),
    engine: meta.engine || 'llm',
    model: meta.model || null,
    latency_ms: meta.latencyMs || 0,
    degraded: Boolean(meta.degraded),
    qualified_at: new Date().toISOString(),
  };
}

export function tierForScore(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function asStrings(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

// ---------------------------------------------------------------------------
// Deterministic fallback. Same output contract, no network. Used when the LLM
// is unavailable so routing and follow-ups still happen (with degraded=true).
// ---------------------------------------------------------------------------

const SPAM_TERMS = [
  'seo services', 'buy backlinks', 'guest post', 'crypto', 'bitcoin', 'casino',
  'loan offer', 'work from home', 'click here to win', 'guaranteed traffic',
];
const BUY_TERMS = [
  'need', 'looking for', 'looking to', 'want', 'hire', 'quote', 'proposal', 'rfp',
  'evaluating', 'pricing', 'how much', 'budget approved', 'budget', 'interested in', 'can you',
];
const RESEARCH_TERMS = ['just researching', 'just looking', 'no project yet', 'for now'];
const URGENT_TERMS = ['asap', 'urgent', 'today', 'tomorrow', 'this week', 'immediately', 'deadline', 'by friday', 'next week', 'within'];

export function heuristicQualify(lead, { icp = DEFAULT_ICP, reason = 'rules fallback' } = {}) {
  const started = Date.now();
  const text = `${lead.message || ''} ${lead.contact.company || ''}`.toLowerCase();
  const reasons = [];
  const flags = [];
  let score = 12;

  if (SPAM_TERMS.some((t) => text.includes(t))) {
    return normalizeQualification(
      {
        score: 5,
        intent: 'vendor spam',
        urgency: 'unknown',
        budget_fit: 'unknown',
        reasons: ['Message matches a known spam pattern.'],
        missing_info: [],
        flags: ['spam'],
        next_action: 'Archive. Do not reply.',
        draft_reply: '',
      },
      { engine: 'rules', model: null, latencyMs: Date.now() - started, degraded: true },
    );
  }

  const buys = BUY_TERMS.filter((t) => text.includes(t));
  if (buys.length) {
    const intentPoints = Math.min(24, 6 + buys.length * 4);
    score += intentPoints;
    reasons.push(`Buying language in the message ("${buys.slice(0, 3).join('", "')}") adds ${intentPoints} intent points.`);
  }
  const researching = RESEARCH_TERMS.some((t) => text.includes(t));
  if (researching) {
    score -= 18;
    flags.push('research_only');
    reasons.push('Explicitly says they are only researching — no active project.');
  }
  const urgents = URGENT_TERMS.filter((t) => text.includes(t));
  if (urgents.length) {
    score += 10;
    reasons.push(`Timeline pressure ("${urgents[0]}") adds 10 urgency points.`);
  }
  if (lead.budget_usd == null) {
    reasons.push('No budget stated — treated as neutral and flagged as missing info.');
  } else if (lead.budget_usd >= icp.min_budget_usd * 2) {
    score += 24;
    reasons.push(`Budget of $${lead.budget_usd.toLocaleString()} is ${(lead.budget_usd / icp.min_budget_usd).toFixed(1)}× the $${icp.min_budget_usd.toLocaleString()} floor.`);
  } else if (lead.budget_usd >= icp.min_budget_usd) {
    score += 16;
    reasons.push(`Budget of $${lead.budget_usd.toLocaleString()} clears the $${icp.min_budget_usd.toLocaleString()} floor.`);
  } else {
    score -= 8;
    reasons.push(`Budget of $${lead.budget_usd.toLocaleString()} is below the $${icp.min_budget_usd.toLocaleString()} floor.`);
    flags.push('below_min_budget');
  }
  if (lead.contact.company) {
    score += 6;
    reasons.push(`Identified company: ${lead.contact.company}.`);
  }
  const len = (lead.message || '').length;
  if (len > 150) {
    score += 6;
    reasons.push('Detailed brief with concrete context (150+ characters).');
  } else if (len > 60) {
    score += 3;
    reasons.push('Message includes enough context to qualify.');
  }
  if (lead.source === 'referral') {
    score += 4;
    reasons.push('Referral-sourced lead — historically the highest close rate.');
  }
  if (text.includes('student') || /\bfree\b/.test(text)) {
    score = Math.min(score, 22);
    flags.push('possible_free_work');
    reasons.push('Mentions "student" or free work — excluded from sales routing.');
  }
  // Business override: a confirmed budget at 2× the floor plus an explicit
  // request is a hot lead even if the keyword count is low.
  if (!researching && !flags.includes('possible_free_work') && lead.budget_usd >= icp.min_budget_usd * 2 && buys.length >= 2) {
    if (score < 72) {
      score = 72;
      reasons.push('Confirmed budget at 2× the floor with an explicit request — promoted to hot.');
    }
  }
  score = clamp(score, 0, 100);
  const tier = tierForScore(score);
  const urgency =
    urgents.includes('asap') || urgents.includes('urgent') || urgents.includes('immediately') || urgents.includes('today')
      ? 'now'
      : urgents.length
        ? 'this_week'
        : lead.timeline && /month|quarter|week/i.test(String(lead.timeline))
          ? 'this_month'
          : 'unknown';
  return normalizeQualification(
    {
      score,
      tier,
      intent: researching
        ? 'early research, no project'
        : buys.length >= 3 && lead.budget_usd && lead.budget_usd >= icp.min_budget_usd
          ? 'vendor evaluation, budget confirmed'
          : buys.length >= 2
            ? 'active project enquiry'
            : buys.length
              ? 'asking about a project'
              : 'unclear',
      urgency,
      budget_fit:
        lead.budget_usd == null
          ? 'unknown'
          : lead.budget_usd >= icp.min_budget_usd
            ? 'in_range'
            : 'below_range',
      reasons,
      missing_info: [
        !lead.budget_usd && 'budget',
        !lead.contact.company && 'company',
        !lead.timeline && 'timeline',
        !lead.contact.phone && 'phone number',
      ].filter(Boolean),
      flags,
      next_action:
        tier === 'hot'
          ? 'Call within 15 minutes and send a scoped proposal the same day.'
          : tier === 'warm'
            ? 'Reply with one relevant case study, then follow up in 3 days.'
            : 'Add to long-term nurture. Do not spend sales time yet.',
      draft_reply:
        tier === 'cold'
          ? ''
          : `Hi ${firstName(lead.contact.name) || 'there'}, thanks for reaching out about ${shortTopic(lead)}. We've handled similar projects — I can share a short overview and a rough scope. One quick question: what does your ideal start date look like?`,
    },
    { engine: 'rules', model: null, latencyMs: Date.now() - started, degraded: true, reason },
  );
}

export async function qualify(lead, opts = {}) {
  const config = opts.config || configFromEnv();
  if (!config.apiKey) return heuristicQualify(lead, { icp: opts.icp, reason: 'no API key configured' });
  try {
    return await qualifyWithLLM(lead, { ...opts, config });
  } catch (err) {
    if (opts.onError) opts.onError(err);
    return heuristicQualify(lead, { icp: opts.icp, reason: `LLM failed: ${err.message}` });
  }
}

function firstName(name = '') {
  return String(name).trim().split(/\s+/)[0] || '';
}

function shortTopic(lead) {
  const msg = String(lead.message || '').toLowerCase();
  if (msg.includes('automation')) return 'automation';
  if (msg.includes('lead')) return 'lead generation';
  if (msg.includes('chatbot') || msg.includes('ai')) return 'AI workflows';
  return 'your project';
}
