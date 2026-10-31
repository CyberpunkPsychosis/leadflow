const $ = (sel) => document.querySelector(sel);
const state = { leads: [], stats: null, tier: '', source: '', q: '', activeId: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rel(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function refresh() {
  const [stats, leads] = await Promise.all([api('/api/stats'), api('/api/leads')]);
  state.stats = stats;
  state.leads = leads;
  renderStats();
  renderSources();
  renderRows();
  if (state.activeId) {
    const fresh = leads.find((l) => l.id === state.activeId);
    if (fresh) renderDrawer(fresh);
  }
}

function renderStats() {
  const s = state.stats || {};
  $('#s-total').textContent = s.total ?? 0;
  $('#s-sources').textContent = Object.keys(s.bySource || {}).length + ' channels';
  $('#s-hot').textContent = s.byTier?.hot ?? 0;
  $('#s-hotrate').textContent = `${s.hotRate ?? 0}% of inbound`;
  $('#s-score').textContent = s.avgScore ?? 0;
  $('#s-latency').textContent = s.total && (s.avgQualifyMs ?? 0) < 1 ? '<1 ms' : `${s.avgQualifyMs ?? 0} ms`;
  $('#s-followups').textContent = s.pendingFollowups ?? 0;
  $('#s-outbox').textContent = `${s.outbox ?? 0} emails sent`;
  $('#s-dlq').textContent = s.dlq ?? 0;
  $('#s-dlq').closest('.stat').classList.toggle('danger', (s.dlq ?? 0) > 0);
}

function renderSources() {
  const sel = $('#source-filter');
  const current = sel.value;
  const sources = [...new Set(state.leads.map((l) => l.source))].sort();
  sel.innerHTML =
    '<option value="">All sources</option>' +
    sources.map((s) => `<option value="${esc(s)}">${esc(s.replaceAll('_', ' '))}</option>`).join('');
  sel.value = current;
}

function visible() {
  const q = state.q.toLowerCase();
  return state.leads
    .filter((l) => !state.tier || l.qualification?.tier === state.tier)
    .filter((l) => !state.source || l.source === state.source)
    .filter((l) =>
      !q ||
      [l.contact?.name, l.contact?.company, l.contact?.email, l.message]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q)),
    );
}

function renderRows() {
  const rows = visible();
  $('#empty').hidden = state.leads.length > 0;
  $('#rows').innerHTML = rows
    .map((l) => {
      const q = l.qualification || {};
      return `<tr data-id="${l.id}" class="row">
        <td>
          <div class="lead-cell">
            <div class="avatar">${esc(initials(l.contact?.name))}</div>
            <div>
              <div class="lead-name">${esc(l.contact?.name)}</div>
              <div class="lead-sub">${esc(l.contact?.company || l.contact?.email)}</div>
            </div>
          </div>
        </td>
        <td><span class="source">${esc(l.source.replaceAll('_', ' '))}</span></td>
        <td>
          <div class="score-cell">
            <div class="score-bar"><i class="${q.tier}" style="width:${q.score ?? 0}%"></i></div>
            <span class="score-num ${q.tier}">${q.score ?? '—'}</span>
          </div>
        </td>
        <td class="intent">${esc(q.intent || '—')}</td>
        <td>${l.routing?.owner ? esc(l.routing.owner) : '<span class="muted">—</span>'}</td>
        <td><span class="pill ${statusClass(l.status)}">${esc(statusLabel(l.status))}</span></td>
        <td class="muted nowrap">${rel(l.created_at)}</td>
      </tr>`;
    })
    .join('');

  document.querySelectorAll('tr.row').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.id));
  });
}

function statusLabel(s) {
  return s === 'hot' ? 'Priority' : s === 'nurturing' ? 'Nurturing' : s === 'archived' ? 'Archived' : 'New';
}
function statusClass(s) {
  return s === 'hot' ? 'pill-hot' : s === 'nurturing' ? 'pill-warm' : s === 'archived' ? 'pill-cold' : 'pill-muted';
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

async function openDrawer(id) {
  state.activeId = id;
  const lead = await api(`/api/leads/${id}`);
  renderDrawer(lead);
  $('#drawer').hidden = false;
  document.body.classList.add('drawer-open');
}

function renderDrawer(l) {
  const q = l.qualification || {};
  $('#d-tier').className = `pill pill-${q.tier || 'muted'}`;
  $('#d-tier').textContent = `${q.tier || 'new'} • ${q.engine || '—'}`;
  $('#d-name').textContent = l.contact?.name || 'Unknown lead';
  $('#d-meta').textContent = [l.contact?.company, l.contact?.email, l.contact?.phone].filter(Boolean).join(' · ');
  $('#d-score').textContent = q.score ?? 0;
  $('#d-ring').className = `score-ring ${q.tier}`;
  $('#d-next').textContent = q.next_action || '—';
  $('#d-intent').textContent = `${q.intent || ''} · urgency: ${(q.urgency || 'unknown').replaceAll('_', ' ')} · budget: ${(q.budget_fit || 'unknown').replaceAll('_', ' ')}`;
  $('#d-reasons').innerHTML = (q.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  $('#d-missing').innerHTML = (q.missing_info?.length
    ? `<span class="tag">Missing:</span> ` + q.missing_info.map((m) => `<span class="chip">${esc(m)}</span>`).join('')
    : '') + (q.flags?.length ? `<div class="flags">${q.flags.map((f) => `<span class="chip chip-warn">${esc(f)}</span>`).join('')}</div>` : '');
  $('#d-message').textContent = l.message || '(no message)';
  $('#d-source').textContent = l.source.replaceAll('_', ' ');
  $('#d-budget').textContent = l.budget_usd ? `$${l.budget_usd.toLocaleString('en-US')}` : (l.budget_raw || 'not stated');
  $('#d-timeline').textContent = l.timeline || 'not stated';
  $('#d-crm').textContent = l.crm ? `${l.crm.id} (${l.crm.target})` : 'not synced';

  $('#d-followups').innerHTML = (l.followups || [])
    .map(
      (f) => `<li class="fu ${f.status}">
        <span class="dot"></span>
        <div><strong>${esc(f.step.replaceAll('_', ' '))}</strong><small>${f.status === 'sent' ? `sent ${when(f.sent_at)}` : `due ${when(f.due_at)}`}</small></div>
      </li>`,
    )
    .join('') || '<li class="muted">No follow-ups for archived leads.</li>';

  $('#d-events').innerHTML = (l.events || [])
    .slice(0, 20)
    .map((e) => `<li><time>${new Date(e.at).toLocaleTimeString('en-US')}</time><span>${esc(e.message)}</span></li>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

$('#btn-seed').addEventListener('click', async () => {
  const btn = $('#btn-seed');
  btn.disabled = true;
  btn.textContent = 'Qualifying…';
  try {
    const res = await api('/api/demo/seed', { method: 'POST' });
    await api('/api/tick', { method: 'POST' });
    await refresh();
    btn.textContent = res.created === 0 ? 'Demo batch already loaded' : 'Demo batch added';
  } catch (err) {
    console.error(err);
    btn.textContent = 'Failed — try again';
  } finally {
    btn.disabled = false;
    setTimeout(() => (btn.textContent = 'Run demo batch'), 1800);
  }
});
$('#btn-seed-2').addEventListener('click', () => $('#btn-seed').click());

$('#btn-advance').addEventListener('click', async () => {
  await api('/api/demo/advance', { method: 'POST', body: JSON.stringify({ hours: 24 }) });
  const { sent } = await api('/api/tick', { method: 'POST' });
  await refresh();
  $('#btn-advance').textContent = `Sent ${sent.length} follow-up${sent.length === 1 ? '' : 's'}`;
  setTimeout(() => ($('#btn-advance').textContent = 'Fast-forward 1 day'), 1800);
});

$('#tier-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  state.tier = btn.dataset.tier;
  renderRows();
});

$('#search').addEventListener('input', (e) => {
  state.q = e.target.value;
  renderRows();
});

$('#source-filter').addEventListener('change', (e) => {
  state.source = e.target.value;
  renderRows();
});

$('#d-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});
$('#drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') closeDrawer();
});

function closeDrawer() {
  $('#drawer').hidden = true;
  document.body.classList.remove('drawer-open');
  state.activeId = null;
}

const dlg = $('#dlg');
$('#btn-simulate').addEventListener('click', () => dlg.showModal());
$('#lead-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'submit') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const btn = $('#dlg-submit');
  btn.disabled = true;
  btn.textContent = 'Qualifying…';
  try {
    await api('/api/leads', { method: 'POST', body: JSON.stringify(payload) });
    dlg.close();
    e.target.reset();
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add & qualify';
  }
});

async function boot() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const h = await api('/api/health');
      const badge = $('#engine-badge');
      if (h.llm === 'live') {
        badge.className = 'badge badge-live';
        badge.textContent = `AI live · ${h.model}`;
      } else {
        badge.className = 'badge badge-fallback';
        badge.textContent = 'Rules engine (no API key)';
      }
      await refresh();
      return;
    } catch (err) {
      if (attempt === 2) console.error(err);
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

boot().catch((err) => console.error(err));
