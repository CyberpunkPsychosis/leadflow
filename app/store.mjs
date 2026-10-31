import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY = { version: 1, leads: {}, events: [], dlq: [], outbox: [] };

export class Store {
  constructor(file) {
    this.file = file;
    this.state = structuredClone(EMPTY);
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      this.state = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.persist();
    }
  }

  // Serialize writes so concurrent webhook calls cannot clobber each other.
  mutate(fn) {
    this.queue = this.queue.then(async () => {
      const result = fn(this.state);
      await this.persist();
      return result;
    });
    return this.queue;
  }

  async persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }

  get(id) {
    return this.state.leads[id];
  }

  findByEmail(email) {
    if (!email) return undefined;
    return Object.values(this.state.leads).find((l) => l.contact?.email === email);
  }

  list({ tier, source, status } = {}) {
    return Object.values(this.state.leads)
      .filter((l) => (!tier || l.qualification?.tier === tier))
      .filter((l) => (!source || l.source === source))
      .filter((l) => (!status || l.status === status))
      .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  }

  addEvent(event) {
    const e = { id: randomUUID(), at: new Date().toISOString(), ...event };
    this.state.events.unshift(e);
    if (this.state.events.length > 5000) this.state.events.length = 5000;
    return e;
  }

  eventsFor(leadId) {
    return this.state.events.filter((e) => e.lead_id === leadId);
  }

  deadLetter(entry) {
    this.state.dlq.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
    if (this.state.dlq.length > 200) this.state.dlq.length = 200;
  }

  recordOutbound(msg) {
    this.state.outbox.unshift({ id: randomUUID(), at: new Date().toISOString(), ...msg });
    if (this.state.outbox.length > 200) this.state.outbox.length = 200;
  }

  stats() {
    const leads = Object.values(this.state.leads);
    const byTier = { hot: 0, warm: 0, cold: 0 };
    const bySource = {};
    let scoreSum = 0;
    let scored = 0;
    let latencySum = 0;
    let pendingFollowups = 0;
    for (const l of leads) {
      const t = l.qualification?.tier;
      if (t in byTier) byTier[t] += 1;
      bySource[l.source] = (bySource[l.source] || 0) + 1;
      if (typeof l.qualification?.score === 'number') {
        scoreSum += l.qualification.score;
        scored += 1;
      }
      if (l.qualification?.latency_ms) latencySum += l.qualification.latency_ms;
      pendingFollowups += (l.followups || []).filter((f) => f.status === 'scheduled').length;
    }
    return {
      total: leads.length,
      byTier,
      bySource,
      avgScore: scored ? Math.round(scoreSum / scored) : 0,
      avgQualifyMs: scored ? Math.round(latencySum / scored) : 0,
      pendingFollowups,
      dlq: this.state.dlq.length,
      outbox: this.state.outbox.length,
      hotRate: leads.length ? Math.round((byTier.hot / leads.length) * 100) : 0,
      updatedAt: new Date().toISOString(),
    };
  }
}
