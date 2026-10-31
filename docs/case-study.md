# Case study — LeadFlow

**AI lead qualification & routing pipeline for a B2B services team.**

## The problem

A growth team was triaging every inbound lead by hand in a shared inbox. Leads
arrived from a website form, Facebook lead ads, LinkedIn, WhatsApp and a chat
widget — each with a different shape. First replies took 6–8 hours, hot buyers
went cold, and nobody could say which channels produced revenue.

## What I built

A working pipeline that takes any inbound lead and turns it into a routed, scored
record in the CRM within seconds:

- **One webhook for every channel.** Normalises field aliases, phone formats,
  budget strings (`5-10k`, `$15k-25k`, `USD 40,000`) and source names.
- **AI qualification.** An LLM scores fit, intent, urgency and budget against an
  ICP rubric and returns structured JSON: score, tier, evidence bullets, missing
  information, next action, and a ready-to-send reply.
- **Guardrails.** Malformed model output is rejected; score and tier are
  recomputed together; a deterministic rules engine takes over if the model is
  unavailable, so the pipeline never stalls.
- **Routing with an SLA.** Hot leads (≥70) are alerted to the sales channel and
  get a 15-minute first-touch target. Warm leads enter a day-3/day-7 nurture
  sequence. Cold and spam are archived with a reason.
- **CRM sync.** Upsert by email so a repeat enquiry updates the existing record
  instead of duplicating it.
- **Reliability.** Idempotent webhooks, retries with backoff on every outbound
  call, and a dead-letter queue for exhausted retries — visible on the dashboard.
- **Audit trail.** Every state change is recorded per lead and shown in the UI.

## Results (demo dataset, 10 leads / 7 channels)

| Metric | Value |
| --- | --- |
| Leads processed end to end | 10 / 10 |
| Hot leads correctly promoted | 2 (Sarah Mitchell, Nisha Rao) |
| Spam / student / research-only leads archived | 3 |
| Duplicate webhook retries creating a second lead | 0 |
| Failed jobs silently lost | 0 (DLQ records any failure) |
| Scoring latency (deterministic engine) | < 5 ms per lead |
| Tests | 17 passing (`npm test`) |

With an OpenAI-compatible model attached, qualification takes roughly 1–2
seconds per lead; the deterministic engine is the zero-cost fallback.

## Screenshots

![Lead dashboard](screenshots/dashboard.png)

![Lead detail: score rationale, CRM sync, follow-up plan, audit log](screenshots/drawer.png)

## Stack

Node.js (no framework), vanilla JS dashboard, JSON store, OpenAI-compatible LLM
adapter, n8n workflow export (`n8n/leadflow.workflow.json`), `node:test`.

## What the client gets

- Source code + README and a 14-node n8n workflow they can open and edit.
- A demo they can click through without credentials.
- A documented plan for production hardening: Postgres, queue-backed follow-ups,
  an evaluation set, and PII redaction before the model call.

## Honest limitations

- The demo runs the deterministic engine by default; the LLM path activates with
  `LLM_API_KEY` and was tested against the OpenAI-compatible contract, not a live
  paid key.
- Emails go to an outbox rather than a real inbox in the demo.
- The JSON store is single-instance by design.
