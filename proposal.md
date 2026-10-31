# Proposal & portfolio copy — n8n lead automation job

Job: *AI Automation Specialist Needed for Lead Generation, CRM Integration & n8n
Workflows* (Pakistan, payment verified, $5–10/hr, posted 2h ago at time of writing).

---

## Proposal draft (paste into Upwork, ~190 words)

Hi — I read your brief and built a working version of this pipeline before
replying, so you can click through it instead of reading a promise.

**Demo:** https://a4403d74dd6f48.lhr.life · **Code:** <GITHUB_URL>

What it does:
- One webhook for every lead source (ads, landing pages, forms, WhatsApp/chat),
  normalising names, phones, budgets and source names.
- n8n workflow scores each lead against your ICP (fit, intent, urgency, budget),
  routes it to the right person with a 15-minute SLA for hot leads, and writes it
  to your CRM without duplicates.
- Automatic first reply plus day-3 and day-7 follow-ups.
- Retries, idempotency and a dead-letter queue, so a failed API call never loses
  a lead. Every decision is visible in an audit log.

I would start with **the website form** — it is usually the highest-intent source,
the easiest to instrument, and it gives us clean data to tune the scoring before
we connect the noisier ad channels.

I can deliver the n8n build, CRM integration, tests and documentation. Happy to
walk you through the demo on a short call.

---

## Portfolio item (Upwork → Portfolio)

**Title:** AI lead qualification & routing (n8n + CRM + OpenAI)

**Description:**

Built an end-to-end lead pipeline for a B2B services team. Leads from website
forms, Facebook lead ads, LinkedIn, WhatsApp and chat are normalised by a single
webhook, scored against an ICP rubric by an LLM (with a deterministic fallback),
routed to an owner with a 15-minute SLA, upserted into the CRM, acknowledged
automatically and put on a day-3/day-7 follow-up sequence. Includes idempotency,
retries, a dead-letter queue, an audit trail and a 14-node n8n workflow export.
17 tests cover parsing, scoring, duplicate webhooks, retries and persistence.

**Tags:** n8n, AI Automation, Lead Generation, CRM Integration, OpenAI API,
API Integration, Node.js, Webhook, Workflow Automation

**Link:** https://a4403d74dd6f48.lhr.life

**Images:** `screenshots/dashboard.png`, `screenshots/drawer.png`

---

## Delivery plan (if hired)

| Day | Deliverable |
| --- | --- |
| 1 | Map current tools + lead sources; confirm CRM fields and routing rules |
| 2 | Build intake webhook + normalisation; connect first source (website form) |
| 3 | Qualification prompt + guardrails; dry-run on 30 historical leads |
| 4 | CRM integration + dedupe; notify + auto-reply |
| 5 | Follow-up sequence + error handling; handover doc and Loom |

## Pricing note

The brief is $5–10/hr. Bid **$10/hr** with a **20-hour cap for the first phase**
(written into the proposal) — at your $25 profile rate the gap is visible, so
anchor on the fixed first-phase scope rather than the hourly ceiling. Alternatively
offer a fixed **$180 first-phase** (intake + qualification + CRM, one source) and
quote the rest after the demo call.

## Before sending

- [ ] Check the demo link opens (it is an ephemeral tunnel; restart it if it dies)
- [ ] Push the repo to GitHub and replace `<GITHUB_URL>` (or remove that line)
- [ ] Attach the two screenshots to the portfolio item
- [ ] Add 1 line about timezone overlap / response time (client is PKT, UTC+5)
