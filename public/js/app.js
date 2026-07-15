'use strict';
/* ================================================================
   L'usine — application front
   ================================================================ */

const S = {
  boot: null,
  providers: [],
  credentials: [],
  types: [],
  wf: null,
  canvas: null,
  dirty: false,
  runningExecId: null,
  wsOff: null,
  editorCleanup: null
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3800);
}

/* ---------- Modales ---------- */
const modalStack = [];
function openModal(html, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = html;
  $('#modals').appendChild(wrap);
  const entry = {
    el: wrap,
    close() {
      const i = modalStack.indexOf(entry);
      if (i >= 0) modalStack.splice(i, 1);
      wrap.remove();
      opts.onClose && opts.onClose();
    }
  };
  modalStack.push(entry);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && opts.dismissable !== false) entry.close(); });
  $$('[data-close]', wrap).forEach(b => b.addEventListener('click', () => entry.close()));
  return entry;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1].close();
});

function confirmDialog(message, { danger = true, okLabel = 'Supprimer' } = {}) {
  return new Promise((resolve) => {
    const m = openModal(`
      <div class="modal" style="width:400px">
        <div class="modal-head"><h3>Confirmation</h3></div>
        <div class="modal-body"><p style="line-height:1.6; color:var(--muted)">${esc(message)}</p></div>
        <div class="modal-foot">
          <button class="btn btn-outline" data-close>Annuler</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cf-ok">${esc(okLabel)}</button>
        </div>
      </div>`, { onClose: () => resolve(false) });
    $('#cf-ok', m.el).addEventListener('click', () => { resolve(true); const i = modalStack.indexOf(m); m.close(); });
  });
}

/* ---------- Dates ---------- */
function parseDate(s) {
  if (!s) return null;
  return new Date(String(s).includes('T') ? s : s.replace(' ', 'T') + 'Z');
}
function timeAgo(s) {
  const d = parseDate(s);
  if (!d) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'à l\'instant';
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
  return `il y a ${Math.floor(sec / 86400)} j`;
}
function fmtDate(s) {
  const d = parseDate(s);
  return d ? d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}
function duration(a, b) {
  const d1 = parseDate(a), d2 = parseDate(b);
  if (!d1 || !d2) return '';
  const s = Math.max(0, Math.round((d2 - d1) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_FR = { success: 'Succès', error: 'Erreur', running: 'En cours', stopped: 'Arrêté' };

/* ================================================================
   ROUTER
   ================================================================ */
async function route() {
  if (S.editorCleanup) { S.editorCleanup(); S.editorCleanup = null; }
  const hash = location.hash.replace(/^#\/?/, '');

  if (!S.boot) S.boot = await API.get('/api/bootstrap');
  if (!S.boot.authed) return renderAuth(S.boot.needsSetup ? 'register' : 'login');

  WS.connect();

  const [page, arg] = hash.split('/');
  if (page === 'workflow' && arg) return renderEditor(arg);
  if (page === 'credentials') return renderCredentials();
  if (page === 'executions') return renderExecutions();
  if (page === 'providers') return renderProviders();
  return renderHome();
}
window.addEventListener('hashchange', route);

/* ================================================================
   AUTH
   ================================================================ */
function renderAuth(mode) {
  const first = S.boot?.needsSetup;
  const isReg = mode === 'register';
  const showCode = isReg && !first && S.boot?.signupGated;
  $('#app').innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <div class="auth-logo">🏭</div>
      <div class="auth-title">${first ? 'Bienvenue dans L\'usine' : 'L\'usine'}</div>
      <div class="auth-sub">${first
        ? 'Crée le compte administrateur pour démarrer ta plateforme.'
        : isReg ? 'Crée ton compte pour accéder à ta fabrique d\'agents IA.' : 'Connecte-toi à ta fabrique d\'agents IA.'}</div>
      <div class="field"><label>Email</label>
        <input type="email" class="input" id="email" autofocus autocomplete="username"></div>
      <div class="field"><label>Mot de passe${isReg ? ' (8 caractères min.)' : ''}</label>
        <input type="password" class="input" id="pw" autocomplete="${isReg ? 'new-password' : 'current-password'}"></div>
      ${isReg ? `<div class="field"><label>Confirme le mot de passe</label>
        <input type="password" class="input" id="pw2" autocomplete="new-password"></div>` : ''}
      ${showCode ? `<div class="field"><label>Code d'inscription</label>
        <input type="text" class="input" id="code" placeholder="Fourni par l'administrateur"></div>` : ''}
      <div class="auth-err" id="err"></div>
      <button class="btn btn-primary" id="go">${isReg ? (first ? 'Créer et entrer' : 'Créer mon compte') : 'Se connecter'}</button>
      ${first ? '' : `<div class="auth-switch">
        ${isReg ? 'Déjà un compte ?' : 'Pas encore de compte ?'}
        <a id="switch">${isReg ? 'Se connecter' : 'Créer un compte'}</a>
      </div>`}
    </div></div>`;

  const submit = async () => {
    const email = $('#email').value.trim();
    const pw = $('#pw').value;
    try {
      if (isReg) {
        if (pw !== $('#pw2').value) return $('#err').textContent = 'Les mots de passe ne correspondent pas.';
        await API.post('/api/auth/register', { email, password: pw, code: showCode ? $('#code').value.trim() : undefined });
      } else {
        await API.post('/api/auth/login', { email, password: pw });
      }
      S.boot = null;
      location.hash = '#/';
      route();
    } catch (e) { $('#err').textContent = e.message; }
  };
  $('#go').addEventListener('click', submit);
  $('#switch')?.addEventListener('click', () => renderAuth(isReg ? 'login' : 'register'));
  $('#app').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

/* ================================================================
   SHELL (sidebar + page)
   ================================================================ */
function renderShell(active, content) {
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-logo"><span class="ico">🏭</span><span>L'usine</span></div>
        <nav>
          <a class="nav-item ${active === 'home' ? 'active' : ''}" href="#/"><span class="nav-ico">⚡</span><span>Workflows</span></a>
          <a class="nav-item ${active === 'credentials' ? 'active' : ''}" href="#/credentials"><span class="nav-ico">🔑</span><span>Identifiants</span></a>
          <a class="nav-item ${active === 'executions' ? 'active' : ''}" href="#/executions"><span class="nav-ico">🕘</span><span>Exécutions</span></a>
          <a class="nav-item ${active === 'providers' ? 'active' : ''}" href="#/providers"><span class="nav-ico">🧠</span><span>Fournisseurs IA</span></a>
        </nav>
        <div class="sidebar-foot">
          ${S.boot?.email ? `<div class="sidebar-user" title="${esc(S.boot.email)}">${esc(S.boot.email)}</div>` : ''}
          <button class="btn btn-ghost" id="logout" style="width:100%"><span class="nav-ico">↩</span><span>Déconnexion</span></button>
        </div>
      </aside>
      <main class="main"><div class="page">${content}</div></main>
    </div>`;
  $('#logout').addEventListener('click', async () => {
    await API.post('/api/auth/logout');
    S.boot = null;
    location.hash = '#/';
    route();
  });
}

/* ================================================================
   ACCUEIL — LISTE DES WORKFLOWS
   ================================================================ */
async function renderHome() {
  const wfs = await API.get('/api/workflows');
  const rows = wfs.map(w => `
    <div class="wf-row" data-id="${w.id}">
      <div class="grow">
        <div class="wf-name">${esc(w.name)}</div>
        <div class="wf-meta">Modifié ${timeAgo(w.updated_at)} · Créé le ${fmtDate(w.created_at)}</div>
      </div>
      <span class="badge ${w.active ? 'on' : ''}">${w.active ? 'Actif' : 'Inactif'}</span>
      <div class="menu-wrap">
        <button class="btn btn-ghost btn-icon menu-btn">⋯</button>
        <div class="dropdown">
          <button data-act="rename">✏️ Renommer</button>
          <button data-act="dup">⧉ Dupliquer</button>
          <button data-act="del" class="danger">🗑 Supprimer</button>
        </div>
      </div>
    </div>`).join('');

  renderShell('home', `
    <div class="page-head">
      <div><h1>Workflows</h1><div class="sub">Tes chaînes d'agents IA autonomes</div></div>
      <button class="btn btn-primary" id="new-wf">＋ Créer un workflow</button>
    </div>
    ${wfs.length ? `<div class="wf-list">${rows}</div>` : `
      <div class="empty">
        <div class="big">🏭</div>
        <p>Aucun workflow pour l'instant.<br>Crée ta première chaîne d'agents : chaque agent accomplit sa mission puis passe le relais au suivant.</p>
        <button class="btn btn-primary" id="new-wf-2">＋ Créer mon premier workflow</button>
      </div>`}
  `);

  const createWf = async () => {
    const r = await API.post('/api/workflows', { name: 'Nouveau workflow' });
    location.hash = `#/workflow/${r.id}`;
  };
  $('#new-wf')?.addEventListener('click', createWf);
  $('#new-wf-2')?.addEventListener('click', createWf);

  $$('.wf-row').forEach(row => {
    const id = row.dataset.id;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.menu-wrap')) return;
      location.hash = `#/workflow/${id}`;
    });
    $('.menu-btn', row).addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = $('.dropdown', row);
      $$('.dropdown.open').forEach(d => d !== dd && d.classList.remove('open'));
      dd.classList.toggle('open');
    });
    $$('.dropdown button', row).forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      $('.dropdown', row).classList.remove('open');
      const act = b.dataset.act;
      const wf = wfs.find(w => w.id === id);
      if (act === 'rename') {
        const name = prompt('Nouveau nom :', wf.name);
        if (name && name.trim()) { await API.put(`/api/workflows/${id}`, { name: name.trim() }); renderHome(); }
      } else if (act === 'dup') {
        await API.post(`/api/workflows/${id}/duplicate`);
        renderHome();
      } else if (act === 'del') {
        if (await confirmDialog(`Supprimer « ${wf.name} » et tout son historique d'exécutions ?`)) {
          await API.del(`/api/workflows/${id}`);
          toast('Workflow supprimé', 'success');
          renderHome();
        }
      }
    }));
  });
}
document.addEventListener('click', () => $$('.dropdown.open').forEach(d => d.classList.remove('open')));

/* ================================================================
   FOURNISSEURS IA
   ================================================================ */
const PROVIDER_TYPES = {
  anthropic: { label: 'Anthropic (Claude)', models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'] },
  openai: { label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini'] },
  openai_compatible: { label: 'Compatible OpenAI (Groq, Mistral, Ollama…)', models: [] }
};

async function renderProviders() {
  S.providers = await API.get('/api/providers');
  const cards = S.providers.map(p => `
    <div class="card">
      <div class="card-head">
        <div class="card-ico">🧠</div>
        <div><div class="card-title">${esc(p.name)}</div>
        <div class="card-sub">${esc(PROVIDER_TYPES[p.type]?.label || p.type)} · ${esc(p.default_model || 'aucun modèle par défaut')}</div></div>
      </div>
      <div class="card-sub mono">Clé : ${esc(p.key_masked)}${p.base_url ? ` · ${esc(p.base_url)}` : ''}</div>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" data-act="test" data-id="${p.id}">Tester</button>
        <button class="btn btn-outline btn-sm" data-act="edit" data-id="${p.id}">Modifier</button>
        <button class="btn btn-danger btn-sm" data-act="del" data-id="${p.id}">Supprimer</button>
      </div>
    </div>`).join('');

  renderShell('providers', `
    <div class="page-head">
      <div><h1>Fournisseurs IA</h1><div class="sub">Les moteurs qui font tourner tes agents (multi-provider)</div></div>
      <button class="btn btn-primary" id="add-p">＋ Ajouter un fournisseur</button>
    </div>
    ${S.providers.length ? `<div class="cards">${cards}</div>` : `
      <div class="empty"><div class="big">🧠</div>
      <p>Aucun fournisseur IA configuré.<br>Ajoute au moins une clé API (Anthropic, OpenAI, ou tout service compatible OpenAI) pour donner un cerveau à tes agents.</p>
      <button class="btn btn-primary" id="add-p-2">＋ Ajouter un fournisseur</button></div>`}
  `);

  $('#add-p')?.addEventListener('click', () => openProviderModal());
  $('#add-p-2')?.addEventListener('click', () => openProviderModal());
  $$('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const p = S.providers.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'edit') openProviderModal(p);
    else if (b.dataset.act === 'del') {
      if (await confirmDialog(`Supprimer le fournisseur « ${p.name} » ? Les agents qui l'utilisent tomberont en erreur.`)) {
        await API.del(`/api/providers/${p.id}`);
        renderProviders();
      }
    } else if (b.dataset.act === 'test') {
      b.disabled = true; b.textContent = 'Test…';
      try {
        const r = await API.post('/api/providers/test', { id: p.id, model: p.default_model });
        toast(`✓ ${p.name} répond : « ${r.reply.trim()} »`, 'success');
      } catch (e) { toast(`Échec du test : ${e.message}`, 'error'); }
      b.disabled = false; b.textContent = 'Tester';
    }
  }));
}

function openProviderModal(existing) {
  const m = openModal(`
    <div class="modal">
      <div class="modal-head"><h3>${existing ? 'Modifier le fournisseur' : 'Nouveau fournisseur IA'}</h3>
        <button class="btn btn-ghost btn-icon" data-close>✕</button></div>
      <div class="modal-body">
        <div class="field"><label>Nom</label>
          <input class="input" id="p-name" placeholder="Mon compte Claude" value="${esc(existing?.name || '')}"></div>
        <div class="field"><label>Type</label>
          <select class="select" id="p-type">
            ${Object.entries(PROVIDER_TYPES).map(([k, v]) => `<option value="${k}" ${existing?.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select></div>
        <div class="field" id="p-base-wrap" style="display:none"><label>URL de base de l'API</label>
          <input class="input mono" id="p-base" placeholder="https://api.groq.com/openai/v1" value="${esc(existing?.base_url || '')}">
          <div class="hint">L'URL doit inclure le chemin de version (ex. /v1). Le endpoint /chat/completions y sera ajouté.</div></div>
        <div class="field"><label>Clé API ${existing ? '(laisser vide pour conserver l\'actuelle)' : ''}</label>
          <input class="input mono" id="p-key" type="password" placeholder="${existing ? '••••••••' : 'sk-…'}"></div>
        <div class="field"><label>Modèle par défaut</label>
          <input class="input mono" id="p-model" list="p-models" placeholder="claude-sonnet-4-6" value="${esc(existing?.default_model || '')}">
          <datalist id="p-models"></datalist>
          <div class="hint">Utilisé quand un agent ne précise pas son modèle.</div></div>
        <div class="auth-err" id="p-err"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" id="p-test">Tester la connexion</button>
        <button class="btn btn-primary" id="p-save">${existing ? 'Enregistrer' : 'Ajouter'}</button>
      </div>
    </div>`);

  const syncType = () => {
    const t = $('#p-type', m.el).value;
    $('#p-base-wrap', m.el).style.display = t === 'openai_compatible' ? '' : 'none';
    $('#p-models', m.el).innerHTML = (PROVIDER_TYPES[t]?.models || []).map(x => `<option value="${x}">`).join('');
    if (!existing && !$('#p-model', m.el).value) $('#p-model', m.el).value = PROVIDER_TYPES[t]?.models[0] || '';
  };
  $('#p-type', m.el).addEventListener('change', syncType);
  syncType();
  if (existing) $('#p-model', m.el).value = existing.default_model || '';

  const gather = () => ({
    name: $('#p-name', m.el).value.trim(),
    type: $('#p-type', m.el).value,
    base_url: $('#p-base', m.el).value.trim() || null,
    api_key: $('#p-key', m.el).value.trim() || undefined,
    default_model: $('#p-model', m.el).value.trim() || null
  });

  $('#p-test', m.el).addEventListener('click', async () => {
    const d = gather();
    const btn = $('#p-test', m.el);
    btn.disabled = true; btn.textContent = 'Test en cours…';
    try {
      const payload = d.api_key
        ? { type: d.type, base_url: d.base_url, api_key: d.api_key, model: d.default_model }
        : { id: existing?.id, model: d.default_model };
      const r = await API.post('/api/providers/test', payload);
      $('#p-err', m.el).style.color = 'var(--green)';
      $('#p-err', m.el).textContent = `✓ Connexion OK — réponse : « ${r.reply.trim()} »`;
    } catch (e) {
      $('#p-err', m.el).style.color = '';
      $('#p-err', m.el).textContent = e.message;
    }
    btn.disabled = false; btn.textContent = 'Tester la connexion';
  });

  $('#p-save', m.el).addEventListener('click', async () => {
    const d = gather();
    try {
      if (existing) await API.put(`/api/providers/${existing.id}`, d);
      else {
        if (!d.api_key) throw new Error('Clé API requise');
        await API.post('/api/providers', d);
      }
      m.close();
      toast('Fournisseur enregistré', 'success');
      if (location.hash.includes('providers')) renderProviders();
    } catch (e) { $('#p-err', m.el).style.color = ''; $('#p-err', m.el).textContent = e.message; }
  });
}

/* ================================================================
   IDENTIFIANTS (CREDENTIALS)
   ================================================================ */
async function loadTypesAndCreds() {
  [S.types, S.credentials] = await Promise.all([
    S.types.length ? S.types : API.get('/api/connectors/types'),
    API.get('/api/credentials')
  ]);
}

async function renderCredentials() {
  await loadTypesAndCreds();
  const typeById = Object.fromEntries(S.types.map(t => [t.id, t]));
  const cards = S.credentials.map(c => {
    const t = typeById[c.type] || { icon: '🔌', name: c.type };
    return `
    <div class="card">
      <div class="card-head">
        <div class="card-ico">${t.icon}</div>
        <div><div class="card-title">${esc(c.name)}</div>
        <div class="card-sub">${esc(t.name)} · créé le ${fmtDate(c.created_at)}</div></div>
      </div>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" data-act="edit" data-id="${c.id}">Modifier</button>
        <button class="btn btn-danger btn-sm" data-act="del" data-id="${c.id}">Supprimer</button>
      </div>
    </div>`;
  }).join('');

  renderShell('credentials', `
    <div class="page-head">
      <div><h1>Identifiants</h1><div class="sub">Les accès (chiffrés AES-256) que tes agents utilisent comme outils</div></div>
      <button class="btn btn-primary" id="add-c">＋ Ajouter un identifiant</button>
    </div>
    ${S.credentials.length ? `<div class="cards">${cards}</div>` : `
      <div class="empty"><div class="big">🔑</div>
      <p>Aucun identifiant.<br>Ajoute des connecteurs (SMTP, Supabase, Telegram, Printify…) : ils deviennent des outils que tes agents savent utiliser tout seuls.</p>
      <button class="btn btn-primary" id="add-c-2">＋ Ajouter un identifiant</button></div>`}
  `);

  $('#add-c')?.addEventListener('click', () => openCredentialModal({ onSaved: renderCredentials }));
  $('#add-c-2')?.addEventListener('click', () => openCredentialModal({ onSaved: renderCredentials }));
  $$('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const c = S.credentials.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'edit') openCredentialModal({ existing: c, onSaved: renderCredentials });
    else if (await confirmDialog(`Supprimer l'identifiant « ${c.name} » ?`)) {
      await API.del(`/api/credentials/${c.id}`);
      renderCredentials();
    }
  }));
}

function openCredentialModal({ typeId, existing, onSaved } = {}) {
  const startType = existing?.type || typeId;
  if (!startType) return openCredentialTypePicker({ onPick: (t) => openCredentialModal({ typeId: t, onSaved }) });

  const t = S.types.find(x => x.id === startType);
  const m = openModal(`
    <div class="modal">
      <div class="modal-head">
        <div class="card-ico" style="width:34px;height:34px;font-size:17px">${t.icon}</div>
        <h3>${existing ? 'Modifier' : 'Nouvel identifiant'} — ${esc(t.name)}</h3>
        <button class="btn btn-ghost btn-icon" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="hint" style="margin-bottom:16px; font-size:12.5px; color:var(--muted); line-height:1.55">${esc(t.description || '')}</div>
        <div class="field"><label>Nom de l'identifiant</label>
          <input class="input" id="c-name" value="${esc(existing?.name || t.name)}"></div>
        ${t.fields.map(f => `
          <div class="field"><label>${esc(f.label)}${f.required ? ' *' : ''}</label>
            ${f.type === 'textarea'
              ? `<textarea class="textarea mono" data-field="${f.key}" placeholder="${esc(existing ? '(inchangé — laisser vide pour conserver)' : f.placeholder || '')}"></textarea>`
              : `<input class="input ${f.type === 'password' ? 'mono' : ''}" type="${f.type === 'password' ? 'password' : 'text'}" data-field="${f.key}" placeholder="${esc(existing ? '(inchangé — laisser vide pour conserver)' : f.placeholder || '')}">`}
          </div>`).join('')}
        <div class="auth-err" id="c-err"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" data-close>Annuler</button>
        <button class="btn btn-primary" id="c-save">${existing ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </div>`);

  $('#c-save', m.el).addEventListener('click', async () => {
    const data = {};
    $$('[data-field]', m.el).forEach(i => { data[i.dataset.field] = i.value; });
    const name = $('#c-name', m.el).value.trim();
    try {
      if (!existing) {
        for (const f of t.fields) if (f.required && !data[f.key]) throw new Error(`Champ requis : ${f.label}`);
        const r = await API.post('/api/credentials', { name, type: t.id, data });
        m.close(); toast('Identifiant créé', 'success'); onSaved && onSaved(r.id);
      } else {
        await API.put(`/api/credentials/${existing.id}`, { name, data });
        m.close(); toast('Identifiant mis à jour', 'success'); onSaved && onSaved(existing.id);
      }
    } catch (e) { $('#c-err', m.el).textContent = e.message; }
  });
}

function openCredentialTypePicker({ onPick }) {
  const cats = [...new Set(S.types.map(t => t.category))];
  const m = openModal(`
    <div class="modal" style="width:600px">
      <div class="modal-head"><h3>Choisir un connecteur</h3><button class="btn btn-ghost btn-icon" data-close>✕</button></div>
      <div class="modal-body">
        <div class="field"><input class="input" id="tp-search" placeholder="Rechercher un connecteur… (Printify, SMTP, Telegram…)"></div>
        <div id="tp-list"></div>
      </div>
    </div>`);

  const renderList = (q = '') => {
    const ql = q.toLowerCase();
    $('#tp-list', m.el).innerHTML = cats.map(cat => {
      const items = S.types.filter(t => t.category === cat && (t.name.toLowerCase().includes(ql) || t.description.toLowerCase().includes(ql)));
      if (!items.length) return '';
      return `<div class="sp-cat">${esc(cat)}</div><div class="type-grid" style="margin-bottom:6px">
        ${items.map(t => `<div class="type-item" data-id="${t.id}"><span class="ico">${t.icon}</span><span class="t">${esc(t.name)}</span></div>`).join('')}
      </div>`;
    }).join('') || `<div class="out-empty">Aucun connecteur ne correspond.<br>Utilise « HTTP / API générique » pour tout service non listé.</div>`;
    $$('.type-item', m.el).forEach(el => el.addEventListener('click', () => { m.close(); onPick(el.dataset.id); }));
  };
  renderList();
  $('#tp-search', m.el).addEventListener('input', (e) => renderList(e.target.value));
}

/* ================================================================
   EXÉCUTIONS (page globale)
   ================================================================ */
async function renderExecutions() {
  const execs = await API.get('/api/executions');
  const rows = execs.map(e => `
    <div class="wf-row" data-id="${e.id}">
      <div class="grow">
        <div class="wf-name">${esc(e.workflow_name || 'Workflow supprimé')}</div>
        <div class="wf-meta">Démarré ${fmtDate(e.started_at)} · ${e.finished_at ? `durée ${duration(e.started_at, e.finished_at)}` : 'en cours…'}</div>
      </div>
      <span class="badge status-${e.status}">${STATUS_FR[e.status] || e.status}</span>
    </div>`).join('');

  renderShell('executions', `
    <div class="page-head"><div><h1>Exécutions</h1><div class="sub">Historique de toutes les chaînes lancées</div></div></div>
    ${execs.length ? `<div class="wf-list">${rows}</div>` : `
      <div class="empty"><div class="big">🕘</div><p>Aucune exécution pour l'instant.<br>Lance un workflow avec le bouton orange dans l'éditeur.</p></div>`}
  `);

  $$('.wf-row').forEach(r => r.addEventListener('click', () => openExecDetail(r.dataset.id)));
}

function imageGallery(text) {
  const raw = String(text ?? '');
  const imgRe = /https?:\/\/[^\s)\]<>"']+?\.(?:png|jpe?g|webp|gif)|https?:\/\/[^\s)\]<>"']*\/generated\/[^\s)\]<>"']+|\/generated\/[^\s)\]<>"']+/gi;
  const urls = [...new Set(raw.match(imgRe) || [])];
  if (!urls.length) return '';
  return `<div class="gen-gallery">${urls.map(u =>
    `<a href="${esc(u)}" target="_blank" rel="noopener" title="Ouvrir en grand"><img class="gen-img" src="${esc(u)}" loading="lazy" alt="image générée"></a>`
  ).join('')}</div>`;
}

function stepHtml(s) {
  if (s.type === 'llm') return `<div class="step step-llm">💭 ${esc(s.text)}${imageGallery(s.text)}</div>`;
  if (s.type === 'tool:start') return '';
  if (s.type === 'tool:end') return `
    <details class="step step-tool">
      <summary>🔧 ${esc(s.name)}</summary>
      <pre>${esc(s.result)}</pre>
      ${imageGallery(s.result)}
    </details>`;
  return '';
}

async function openExecDetail(execId) {
  const e = await API.get(`/api/executions/${execId}`);
  const icon = { success: '✅', error: '❌', running: '⏳', stopped: '⏹', skipped: '⏭' };
  const body = (e.logs || []).map((l, i) => `
    <details class="exec-node" ${l.status === 'error' || i === 0 ? 'open' : ''}>
      <summary>
        <span>${icon[l.status] || '•'}</span>
        <span style="flex:1">${esc(l.name)}</span>
        <span class="badge status-${l.status}">${STATUS_FR[l.status] || l.status}</span>
        ${l.startedAt && l.finishedAt ? `<span class="wf-meta">${duration(l.startedAt, l.finishedAt)}</span>` : ''}
      </summary>
      <div class="body">
        ${(l.steps || []).map(stepHtml).join('')}
        ${l.output ? `<div class="step step-final">${esc(l.output)}${imageGallery(l.output)}</div>` : ''}
        ${l.error ? `<div class="step step-error">${esc(l.error)}</div>` : ''}
      </div>
    </details>`).join('');

  openModal(`
    <div class="modal" style="width:760px">
      <div class="modal-head">
        <h3>Exécution du ${fmtDate(e.started_at)}</h3>
        <span class="badge status-${e.status}">${STATUS_FR[e.status] || e.status}</span>
        <button class="btn btn-ghost btn-icon" data-close>✕</button>
      </div>
      <div class="modal-body">
        ${e.input ? `<div class="field"><label>Donnée d'entrée</label><div class="step-llm">${esc(e.input)}</div></div>` : ''}
        ${body || '<div class="out-empty">Aucun log.</div>'}
      </div>
    </div>`);
}

/* ================================================================
   ÉDITEUR DE WORKFLOW
   ================================================================ */
const AGENT_TEMPLATES = [
  { name: 'Agent vide', icon: '🤖', color: '#ff6d5a', d: 'Un agent à configurer de zéro.', mission: '' },
  { name: 'Chercheur web', icon: '🔎', color: '#6c8cff', d: 'Cherche sur le web et synthétise (connecteur Recherche web conseillé).', mission: 'Recherche sur le web les informations les plus récentes et pertinentes sur le sujet fourni en entrée. Utilise ton outil de recherche plusieurs fois si nécessaire. Cite tes sources (URLs) et termine par une synthèse structurée et actionnable.' },
  { name: 'Rédacteur', icon: '✍️', color: '#b57bff', d: 'Transforme des infos brutes en contenu pro.', mission: 'À partir des informations fournies en entrée, rédige un contenu de qualité professionnelle en français (article, post, page ou email selon le contexte). Structure claire, ton naturel, prêt à publier.' },
  { name: 'Développeur', icon: '🛠️', color: '#39c0c8', d: 'Produit du code ou des solutions techniques.', mission: 'Analyse la demande technique fournie en entrée et produis le code ou la solution demandée. Code propre, commenté quand utile, avec une courte explication.' },
  { name: 'Commercial email', icon: '✉️', color: '#2fbf71', d: 'Rédige et envoie des emails (connecteur SMTP requis).', mission: 'À partir du contexte fourni en entrée, rédige les emails nécessaires et envoie-les réellement via ton outil d\'envoi d\'email. Termine en confirmant précisément ce qui a été envoyé et à qui.' },
  { name: 'Analyste data', icon: '📊', color: '#ffb15e', d: 'Interroge ta base SQL et interprète (connecteur Postgres requis).', mission: 'Réponds à la question posée en entrée en interrogeant la base de données avec ton outil SQL. Vérifie d\'abord la structure si besoin (requêtes exploratoires), puis fournis les chiffres et ton interprétation.' },
  { name: 'Community manager', icon: '📣', color: '#ea4b71', d: 'Publie sur Telegram, Discord, Slack…', mission: 'Transforme le contenu fourni en entrée en publications adaptées (messages courts, percutants) et publie-les réellement via tes outils de messagerie disponibles. Confirme ce qui a été publié et où.' },
  { name: 'Agent e-commerce', icon: '🛒', color: '#ff8a3d', d: 'Pilote Printify, Shopify, Etsy, Stripe…', mission: 'Réalise les opérations e-commerce demandées en entrée via tes outils (catalogue, produits, commandes, paiements). Procède étape par étape et rends compte précisément de chaque action effectuée.' }
];

const AGENT_ICONS = ['🤖', '🧠', '✉️', '📦', '🛒', '🎬', '📊', '🔎', '✍️', '🧾', '📣', '🛠️', '🎨', '👕', '🐘', '✈️'];
const AGENT_COLORS = ['#ff6d5a', '#6c8cff', '#2fbf71', '#b57bff', '#ffb15e', '#ea4b71', '#39c0c8'];

/* ================================================================
   DÉCLENCHEURS (helpers)
   ================================================================ */
function SOURCE_TAG(source) {
  if (source === 'cron') return '<span class="src-tag cron">⏰ cron</span>';
  if (source === 'webhook') return '<span class="src-tag hook">🔗 webhook</span>';
  return '';
}

function webhookUrl(t) {
  return `${location.origin}/api/hooks/${t.id}/${t.secret}`;
}

const CRON_PRESETS = [
  { label: 'Toutes les heures', expr: '0 * * * *' },
  { label: 'Tous les jours à 8h', expr: '0 8 * * *' },
  { label: 'Tous les jours à 18h', expr: '0 18 * * *' },
  { label: 'Chaque lundi à 8h', expr: '0 8 * * 1' },
  { label: 'Toutes les 4 heures', expr: '0 */4 * * *' },
  { label: 'Du lundi au vendredi à 9h', expr: '0 9 * * 1-5' },
  { label: '1er du mois à 8h', expr: '0 8 1 * *' }
];

function cronHuman(expr) {
  const p = CRON_PRESETS.find(x => x.expr === expr);
  return p ? p.label : expr;
}

function renderTriggerCard(t) {
  const on = t.enabled;
  if (t.type === 'cron') {
    return `<div class="trig-card ${on ? '' : 'off'}" data-id="${t.id}">
      <div class="trig-top">
        <span class="trig-ico">⏰</span>
        <div class="grow"><div class="trig-name">${esc(t.name || 'Cron')}</div>
        <div class="trig-sub mono">${esc(t.config.expression || '')}</div></div>
        <label class="trig-toggle toggle"><input type="checkbox" ${on ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div class="trig-meta">${esc(cronHuman(t.config.expression))}${t.last_fired_at ? ` · dernier : ${timeAgo(t.last_fired_at)}` : ''}</div>
      <div class="trig-actions">
        <button class="btn btn-outline btn-sm trig-fire">▶ Tester</button>
        <button class="btn btn-outline btn-sm trig-edit">Modifier</button>
        <button class="btn btn-danger btn-sm trig-del">Suppr.</button>
      </div>
    </div>`;
  }
  return `<div class="trig-card ${on ? '' : 'off'}" data-id="${t.id}">
    <div class="trig-top">
      <span class="trig-ico">🔗</span>
      <div class="grow"><div class="trig-name">${esc(t.name || 'Webhook')}</div>
      <div class="trig-sub">${t.config.inputMode === 'fixed' ? 'entrée fixe' : 'le corps de la requête devient l\'entrée'}</div></div>
      <label class="trig-toggle toggle"><input type="checkbox" ${on ? 'checked' : ''}><span class="track"></span></label>
    </div>
    <div class="trig-url mono">${esc(webhookUrl(t))}</div>
    <div class="trig-actions">
      <button class="btn btn-outline btn-sm trig-copy">📋 Copier l'URL</button>
      <button class="btn btn-outline btn-sm trig-fire">▶ Tester</button>
      <button class="btn btn-outline btn-sm trig-edit">Modifier</button>
      <button class="btn btn-danger btn-sm trig-del">Suppr.</button>
    </div>
  </div>`;
}

function openCronModal(workflowId, existing, onSaved) {
  const cfg = existing?.config || {};
  const m = openModal(`
    <div class="modal" style="width:540px">
      <div class="modal-head"><h3>${existing ? 'Modifier' : 'Nouveau'} déclencheur planifié</h3>
        <button class="btn btn-ghost btn-icon" data-close>✕</button></div>
      <div class="modal-body">
        <div class="field"><label>Nom</label>
          <input class="input" id="cr-name" value="${esc(existing?.name || 'Déclencheur cron')}"></div>
        <div class="field"><label>Fréquence — modèles rapides</label>
          <div class="preset-grid">${CRON_PRESETS.map(p => `<button class="preset-btn" data-expr="${p.expr}">${p.label}</button>`).join('')}</div></div>
        <div class="field"><label>Expression cron</label>
          <input class="input mono" id="cr-expr" value="${esc(cfg.expression || '0 8 * * 1')}" placeholder="min heure jour mois jour-semaine">
          <div class="hint" id="cr-preview">…</div></div>
        <div class="field"><label>Donnée d'entrée envoyée au premier agent (optionnel)</label>
          <textarea class="textarea" id="cr-input" placeholder="Ex. : Sujet du jour : veille bornes de recharge…">${esc(cfg.input || '')}</textarea></div>
        <div class="auth-err" id="cr-err"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" data-close>Annuler</button>
        <button class="btn btn-primary" id="cr-save">${existing ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </div>`);

  let previewTimer;
  const preview = async () => {
    const expr = $('#cr-expr', m.el).value.trim();
    const el = $('#cr-preview', m.el);
    el.style.color = '';
    el.textContent = 'Vérification…';
    try {
      const r = await API.get(`/api/triggers/cron/preview?expression=${encodeURIComponent(expr)}`);
      el.innerHTML = 'Prochaines exécutions (heure de Paris) : ' + r.next.map(d => fmtDate(d)).join(' · ');
    } catch {
      el.style.color = 'var(--red)';
      el.textContent = 'Expression cron invalide.';
    }
  };
  $('#cr-expr', m.el).addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 350); });
  $$('.preset-btn', m.el).forEach(b => b.addEventListener('click', () => { $('#cr-expr', m.el).value = b.dataset.expr; preview(); }));
  preview();

  $('#cr-save', m.el).addEventListener('click', async () => {
    const body = {
      type: 'cron',
      name: $('#cr-name', m.el).value.trim() || 'Déclencheur cron',
      config: { expression: $('#cr-expr', m.el).value.trim(), input: $('#cr-input', m.el).value }
    };
    try {
      if (existing) await API.put(`/api/triggers/${existing.id}`, { name: body.name, config: body.config });
      else await API.post(`/api/workflows/${workflowId}/triggers`, body);
      m.close(); toast('Déclencheur enregistré', 'success'); onSaved && onSaved();
    } catch (e) { $('#cr-err', m.el).textContent = e.message; }
  });
}

function openWebhookModal(workflowId, existing, onSaved) {
  const cfg = existing?.config || {};
  const mode = cfg.inputMode || 'body';
  const m = openModal(`
    <div class="modal" style="width:560px">
      <div class="modal-head"><h3>${existing ? 'Modifier' : 'Nouveau'} webhook</h3>
        <button class="btn btn-ghost btn-icon" data-close>✕</button></div>
      <div class="modal-body">
        <div class="field"><label>Nom</label>
          <input class="input" id="wh-name" value="${esc(existing?.name || 'Webhook')}"></div>
        <div class="field"><label>Entrée transmise à la chaîne</label>
          <select class="select" id="wh-mode">
            <option value="body" ${mode === 'body' ? 'selected' : ''}>Le corps de la requête (POST) devient l'entrée</option>
            <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Toujours la même entrée fixe</option>
          </select></div>
        <div class="field" id="wh-fixed-wrap" style="${mode === 'fixed' ? '' : 'display:none'}">
          <label>Entrée fixe</label>
          <textarea class="textarea" id="wh-input">${esc(cfg.input || '')}</textarea></div>
        ${existing ? `
        <div class="field"><label>URL du webhook (garde-la secrète)</label>
          <div class="trig-url mono" style="margin:0">${esc(webhookUrl(existing))}</div>
          <div class="hint">Un appel <b>POST</b> (ou GET) sur cette URL lance la chaîne. Exemple :</div>
          <div class="trig-url mono" style="margin-top:6px">curl -X POST "${esc(webhookUrl(existing))}" -H "Content-Type: application/json" -d '{"sujet":"test"}'</div>
        </div>` : `<div class="hint" style="margin-bottom:12px">L'URL secrète sera générée à la création.</div>`}
        <div class="auth-err" id="wh-err"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" data-close>Annuler</button>
        <button class="btn btn-primary" id="wh-save">${existing ? 'Enregistrer' : 'Créer le webhook'}</button>
      </div>
    </div>`);

  $('#wh-mode', m.el).addEventListener('change', (e) => {
    $('#wh-fixed-wrap', m.el).style.display = e.target.value === 'fixed' ? '' : 'none';
  });
  $('#wh-save', m.el).addEventListener('click', async () => {
    const config = { inputMode: $('#wh-mode', m.el).value, input: $('#wh-input', m.el)?.value || '' };
    const name = $('#wh-name', m.el).value.trim() || 'Webhook';
    try {
      if (existing) await API.put(`/api/triggers/${existing.id}`, { name, config });
      else await API.post(`/api/workflows/${workflowId}/triggers`, { type: 'webhook', name, config });
      m.close(); toast('Webhook enregistré', 'success'); onSaved && onSaved();
    } catch (e) { $('#wh-err', m.el).textContent = e.message; }
  });
}

async function renderEditor(id) {
  let wf;
  try {
    [wf, S.providers] = await Promise.all([API.get(`/api/workflows/${id}`), API.get('/api/providers')]);
    await loadTypesAndCreds();
  } catch (e) {
    toast(e.message, 'error');
    location.hash = '#/';
    return;
  }
  S.wf = wf;
  S.dirty = false;
  S.runningExecId = null;

  $('#app').innerHTML = `
    <div class="editor">
      <div class="topbar">
        <button class="back" id="ed-back" title="Retour aux workflows">←</button>
        <input class="wf-title-input" id="ed-title" value="${esc(wf.name)}">
        <span class="dirty-dot" id="ed-dirty" title="Modifications non enregistrées"></span>
        <div class="spacer"></div>
        <label class="active-toggle"><span id="ed-active-label">${wf.active ? 'Actif' : 'Inactif'}</span>
          <span class="toggle"><input type="checkbox" id="ed-active" ${wf.active ? 'checked' : ''}><span class="track"></span></span>
        </label>
        <button class="btn btn-outline" id="ed-save">Enregistrer <span class="kbd">Ctrl+S</span></button>
      </div>
      <div class="canvas-wrap" id="ed-wrap">
        <button class="canvas-add" id="ed-add" title="Ajouter un agent">＋</button>
        <div class="zoom-ctrl">
          <button id="z-in" title="Zoomer">＋</button>
          <button id="z-out" title="Dézoomer">−</button>
          <button id="z-fit" title="Ajuster à la vue">⤢</button>
          <button id="z-reset" title="Zoom 100%">1:1</button>
        </div>
        <div class="exec-bar">
          <button class="exec-hist-btn" id="ed-settings">⚙️ Réglages</button>
          <button class="exec-hist-btn" id="ed-triggers">⏰ Déclencheurs</button>
          <button class="exec-hist-btn" id="ed-hist">🕘 Historique</button>
          <button class="exec-btn" id="ed-run">▶ Exécuter la chaîne</button>
        </div>
        <div class="side-panel" id="add-panel">
          <div class="sp-head"><h3>Ajouter un agent</h3><button class="sp-close" id="add-close">✕</button></div>
          <div class="sp-search"><input class="input" id="add-search" placeholder="Rechercher un modèle d'agent…"></div>
          <div class="sp-body" id="add-body"></div>
        </div>
        <div class="side-panel" id="trigger-panel">
          <div class="sp-head"><h3>Déclencheurs</h3><button class="sp-close" id="trig-close">✕</button></div>
          <div class="sp-body" id="trig-body"><div class="out-empty">Chargement…</div></div>
        </div>
        <div class="side-panel left" id="hist-panel">
          <div class="sp-head"><h3>Exécutions</h3><button class="sp-close" id="hist-close">✕</button></div>
          <div class="sp-body" id="hist-body"><div class="out-empty">Chargement…</div></div>
        </div>
      </div>
    </div>`;

  /* ---------- canvas ---------- */
  const wrap = $('#ed-wrap');
  const canvasContainer = document.createElement('div');
  canvasContainer.style.position = 'absolute';
  canvasContainer.style.inset = '0';
  wrap.prepend(canvasContainer);
  const cv = LCanvas.create(canvasContainer, {
    onChange: () => setDirty(true),
    onOpenNode: (node) => openNDV(node, cv),
    onToast: toast
  });
  S.canvas = cv;
  cv.load(wf.data);

  /* ---------- état dirty / save ---------- */
  function setDirty(v) {
    S.dirty = v;
    $('#ed-dirty').classList.toggle('show', v);
  }
  const wfSettings = (wf.data && wf.data.settings) || {};
  async function save() {
    try {
      await API.put(`/api/workflows/${wf.id}`, {
        name: $('#ed-title').value.trim() || 'Sans nom',
        data: { ...cv.getData(), settings: wfSettings },
        active: $('#ed-active').checked
      });
      setDirty(false);
      toast('Workflow enregistré', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------- réglages de la chaîne ---------- */
  $('#ed-settings').addEventListener('click', () => {
    const m = openModal(`
      <div class="modal" style="max-width:560px">
        <div class="modal-head"><h3>⚙️ Réglages de la chaîne</h3><button class="sp-close" data-close>✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Webhook de notification en cas d'échec</label>
            <input class="input mono" id="set-notify" value="${esc(wfSettings.notifyWebhookUrl || '')}" placeholder="https://discord.com/api/webhooks/…">
            <div class="hint">Si la chaîne échoue (surtout la nuit en cron), L'usine envoie un message ici.
            Compatible Discord, Slack, ou n'importe quelle URL qui accepte du JSON. Laisse vide pour désactiver.</div></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>Annuler</button>
          <button class="btn btn-primary" id="set-save">Enregistrer</button>
        </div>
      </div>`);
    $('#set-save', m.el).addEventListener('click', () => {
      wfSettings.notifyWebhookUrl = $('#set-notify', m.el).value.trim();
      setDirty(true);
      m.close();
      toast('Réglages appliqués — pense à enregistrer la chaîne', 'success');
    });
  });
  $('#ed-save').addEventListener('click', save);
  $('#ed-title').addEventListener('input', () => setDirty(true));
  $('#ed-active').addEventListener('change', () => {
    $('#ed-active-label').textContent = $('#ed-active').checked ? 'Actif' : 'Inactif';
    setDirty(true);
  });
  $('#ed-back').addEventListener('click', async () => {
    if (S.dirty && !(await confirmDialog('Des modifications ne sont pas enregistrées. Quitter quand même ?', { okLabel: 'Quitter', danger: false }))) return;
    location.hash = '#/';
  });

  const keyHandler = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  };
  document.addEventListener('keydown', keyHandler);

  /* ---------- zoom ---------- */
  $('#z-in').addEventListener('click', () => cv.zoom(1.2));
  $('#z-out').addEventListener('click', () => cv.zoom(1 / 1.2));
  $('#z-fit').addEventListener('click', () => cv.fit());
  $('#z-reset').addEventListener('click', () => cv.resetZoom());

  /* ---------- panneau ajout ---------- */
  const renderAddPanel = (q = '') => {
    const ql = q.toLowerCase();
    $('#add-body').innerHTML = `
      <div class="sp-cat">Modèles d'agents</div>
      ${AGENT_TEMPLATES.filter(t => t.name.toLowerCase().includes(ql) || t.d.toLowerCase().includes(ql)).map((t, i) => `
        <div class="sp-item" data-i="${i}">
          <div class="ico" style="background:${t.color}26">${t.icon}</div>
          <div><div class="t">${esc(t.name)}</div><div class="d">${esc(t.d)}</div></div>
        </div>`).join('') || '<div class="out-empty">Aucun modèle ne correspond.</div>'}`;
    $$('#add-body .sp-item').forEach(el => el.addEventListener('click', () => {
      const t = AGENT_TEMPLATES[Number(el.dataset.i)];
      const node = {
        id: 'n' + Math.random().toString(36).slice(2, 9),
        type: 'agent',
        name: t.name === 'Agent vide' ? `Agent ${cv.state.nodes.length + 1}` : t.name,
        config: {
          icon: t.icon, color: t.color, mission: t.mission,
          providerId: S.providers[0]?.id || '',
          model: '', temperature: 0.7, maxIterations: 8, credentialIds: []
        }
      };
      cv.addNode(node);
      $('#add-panel').classList.remove('open');
      openNDV(node, cv);
    }));
  };
  renderAddPanel();
  $('#ed-add').addEventListener('click', () => { $('#hist-panel').classList.remove('open'); $('#add-panel').classList.add('open'); });
  $('#add-close').addEventListener('click', () => $('#add-panel').classList.remove('open'));
  $('#add-search').addEventListener('input', (e) => renderAddPanel(e.target.value));

  /* ---------- panneau historique ---------- */
  async function refreshHist(selId) {
    const execs = await API.get(`/api/executions?workflowId=${wf.id}`);
    $('#hist-body').innerHTML = execs.length ? execs.map(e => `
      <div class="exec-row ${e.id === selId ? 'sel' : ''}" data-id="${e.id}">
        <span>${{ success: '✅', error: '❌', running: '⏳', stopped: '⏹' }[e.status] || '•'}</span>
        <div style="flex:1">
          <div class="t">${fmtDate(e.started_at)} ${SOURCE_TAG(e.source)}</div>
          <div class="d">${e.finished_at ? duration(e.started_at, e.finished_at) : 'en cours…'}</div>
        </div>
        <span class="badge status-${e.status}">${STATUS_FR[e.status] || e.status}</span>
      </div>`).join('') : '<div class="out-empty">Aucune exécution.<br>Lance la chaîne, ou ajoute un déclencheur.</div>';
    $$('#hist-body .exec-row').forEach(r => r.addEventListener('click', async () => {
      const e = await API.get(`/api/executions/${r.dataset.id}`);
      cv.clearRunStatus();
      for (const l of e.logs || []) {
        if (!l.nodeId) continue;
        const st = { success: 'ok', error: 'error', running: 'running', stopped: 'error', skipped: 'skipped' }[l.status];
        cv.setNodeStatus(l.nodeId, st);
        if (l.status === 'success') cv.markIncomingFlow(l.nodeId, 'done');
      }
      openExecDetail(r.dataset.id);
    }));
  }
  $('#ed-hist').addEventListener('click', () => {
    $('#add-panel').classList.remove('open');
    $('#hist-panel').classList.toggle('open');
    if ($('#hist-panel').classList.contains('open')) refreshHist();
  });
  $('#hist-close').addEventListener('click', () => $('#hist-panel').classList.remove('open'));

  /* ---------- panneau déclencheurs ---------- */
  async function refreshTriggers() {
    let triggers = [];
    try { triggers = await API.get(`/api/workflows/${wf.id}/triggers`); } catch {}
    const body = $('#trig-body');
    body.innerHTML = `
      <div class="trig-add">
        <button class="btn btn-outline btn-sm" id="trig-add-cron">⏰ Planifier (cron)</button>
        <button class="btn btn-outline btn-sm" id="trig-add-hook">🔗 Webhook</button>
      </div>
      <div class="hint" style="margin:2px 2px 14px">Un déclencheur lance cette chaîne automatiquement, même quand tu n'es pas là.</div>
      ${triggers.length ? triggers.map(renderTriggerCard).join('') : '<div class="out-empty" style="padding:20px 8px">Aucun déclencheur.<br>Planifie une exécution ou crée un webhook.</div>'}`;

    $('#trig-add-cron').addEventListener('click', () => openCronModal(wf.id, null, refreshTriggers));
    $('#trig-add-hook').addEventListener('click', () => openWebhookModal(wf.id, null, refreshTriggers));

    $$('#trig-body .trig-card').forEach(card => {
      const id = card.dataset.id;
      const t = triggers.find(x => x.id === id);
      $('.trig-toggle input', card)?.addEventListener('change', async (e) => {
        try { await API.put(`/api/triggers/${id}`, { enabled: e.target.checked }); refreshTriggers(); }
        catch (err) { toast(err.message, 'error'); }
      });
      $('.trig-edit', card)?.addEventListener('click', () => {
        if (t.type === 'cron') openCronModal(wf.id, t, refreshTriggers);
        else openWebhookModal(wf.id, t, refreshTriggers);
      });
      $('.trig-fire', card)?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { await API.post(`/api/triggers/${id}/fire`); toast('Déclenchement lancé — regarde le canvas', 'success'); }
        catch (err) { toast(err.message, 'error'); }
        e.target.disabled = false;
      });
      $('.trig-del', card)?.addEventListener('click', async () => {
        if (await confirmDialog('Supprimer ce déclencheur ?')) { await API.del(`/api/triggers/${id}`); refreshTriggers(); }
      });
      $('.trig-copy', card)?.addEventListener('click', () => {
        const url = webhookUrl(t);
        navigator.clipboard?.writeText(url).then(() => toast('URL du webhook copiée', 'success'), () => {});
      });
    });
  }
  $('#ed-triggers').addEventListener('click', () => {
    $('#add-panel').classList.remove('open');
    $('#trigger-panel').classList.toggle('open');
    if ($('#trigger-panel').classList.contains('open')) refreshTriggers();
  });
  $('#trig-close').addEventListener('click', () => $('#trigger-panel').classList.remove('open'));

  /* ---------- exécution ---------- */
  const runBtn = $('#ed-run');
  function updateRunBtn() {
    if (S.runningExecId) {
      runBtn.classList.add('stop');
      runBtn.innerHTML = '■ Arrêter';
    } else {
      runBtn.classList.remove('stop');
      runBtn.innerHTML = '▶ Exécuter la chaîne';
    }
  }
  runBtn.addEventListener('click', async () => {
    if (S.runningExecId) {
      await API.post(`/api/executions/${S.runningExecId}/stop`);
      toast('Arrêt demandé…');
      return;
    }
    if (!cv.state.nodes.length) return toast('Ajoute d\'abord un agent avec le bouton ＋', 'error');
    if (S.dirty) await save();

    const m = openModal(`
      <div class="modal">
        <div class="modal-head"><h3>Exécuter la chaîne</h3><button class="btn btn-ghost btn-icon" data-close>✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Donnée d'entrée pour le premier agent (optionnel)</label>
            <textarea class="textarea" id="run-input" placeholder="Ex. : Sujet du jour : les bornes de recharge en copropriété…"></textarea>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" data-close>Annuler</button>
          <button class="btn btn-primary" id="run-go">▶ Lancer</button>
        </div>
      </div>`);
    $('#run-go', m.el).addEventListener('click', async () => {
      const input = $('#run-input', m.el).value;
      m.close();
      try {
        cv.clearRunStatus();
        const r = await API.post(`/api/workflows/${wf.id}/run`, { input });
        S.runningExecId = r.execId;
        updateRunBtn();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  /* ---------- événements WebSocket ---------- */
  const off = WS.on((msg) => {
    if (msg.workflowId && msg.workflowId !== wf.id && msg.type === 'exec:start') return;
    switch (msg.type) {
      case 'exec:start':
        if (msg.workflowId === wf.id) { S.runningExecId = msg.execId; cv.clearRunStatus(); updateRunBtn(); }
        break;
      case 'node:start':
        if (msg.execId === S.runningExecId) { cv.setNodeStatus(msg.nodeId, 'running'); cv.markIncomingFlow(msg.nodeId, 'flowing'); }
        break;
      case 'node:done':
        if (msg.execId === S.runningExecId) { cv.setNodeStatus(msg.nodeId, 'ok'); cv.markIncomingFlow(msg.nodeId, 'done'); }
        break;
      case 'node:error':
        if (msg.execId === S.runningExecId) cv.setNodeStatus(msg.nodeId, 'error');
        break;
      case 'exec:error':
        if (msg.execId === S.runningExecId) toast(msg.error, 'error');
        break;
      case 'exec:done':
        if (msg.execId === S.runningExecId) {
          const st = msg.status;
          toast(st === 'success' ? '✅ Chaîne terminée avec succès' : st === 'stopped' ? '⏹ Chaîne arrêtée' : '❌ La chaîne s\'est arrêtée en erreur', st === 'success' ? 'success' : st === 'error' ? 'error' : '');
          const doneId = S.runningExecId;
          S.runningExecId = null;
          updateRunBtn();
          if ($('#hist-panel').classList.contains('open')) refreshHist(doneId);
          if ($('#trigger-panel').classList.contains('open')) refreshTriggers();
        }
        break;
      case 'trigger:fired':
        if (msg.workflowId === wf.id) {
          toast(msg.source === 'cron' ? '⏰ Déclenchement planifié en cours' : msg.source === 'webhook' ? '🔗 Webhook reçu — chaîne lancée' : 'Chaîne lancée', '');
        }
        break;
      case 'trigger:error':
        toast('Déclencheur en erreur : ' + msg.error, 'error');
        break;
    }
  });

  /* ---------- garde-fous ---------- */
  const beforeUnload = (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  S.editorCleanup = () => {
    off();
    document.removeEventListener('keydown', keyHandler);
    window.removeEventListener('beforeunload', beforeUnload);
    S.canvas = null;
  };
}

/* ================================================================
   NDV — CONFIGURATION D'UN AGENT
   ================================================================ */
function openNDV(node, cv) {
  node.config = node.config || {};
  const cfg = node.config;
  const typeById = Object.fromEntries(S.types.map(t => [t.id, t]));

  const credRows = () => S.credentials.map(c => {
    const t = typeById[c.type] || { icon: '🔌', name: c.type };
    const on = (cfg.credentialIds || []).includes(c.id);
    return `<label class="cred-check ${on ? 'sel' : ''}">
      <input type="checkbox" data-cred="${c.id}" ${on ? 'checked' : ''}>
      <span class="ci">${t.icon}</span>
      <span class="cn">${esc(c.name)}</span>
      <span class="ct">${esc(t.name)}</span>
    </label>`;
  }).join('') || '<div class="hint" style="margin-bottom:8px">Aucun identifiant créé pour l\'instant.</div>';

  const m = openModal(`
    <div class="modal ndv">
      <div class="modal-head">
        <div class="card-ico" style="width:36px;height:36px;font-size:18px;background:${cfg.color || '#ff6d5a'}26" id="ndv-head-ico">${esc(cfg.icon || '🤖')}</div>
        <h3 style="display:flex;align-items:center;gap:10px">Configuration de l'agent</h3>
        <button class="btn btn-ghost btn-icon" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="ndv-params">
          <div class="field"><label>Nom de l'agent</label>
            <input class="input" id="ndv-name" value="${esc(node.name)}"></div>

          <div class="field"><label>Icône</label>
            <div class="ico-pick">${AGENT_ICONS.map(i => `<button class="ico-btn ${cfg.icon === i ? 'sel' : ''}" data-ico="${i}">${i}</button>`).join('')}</div></div>

          <div class="field"><label>Couleur</label>
            <div class="color-pick">${AGENT_COLORS.map(c => `<span class="color-dot ${cfg.color === c ? 'sel' : ''}" data-color="${c}" style="background:${c}"></span>`).join('')}</div></div>

          <div class="field"><label>Mission de l'agent</label>
            <textarea class="textarea" id="ndv-mission" style="min-height:130px" placeholder="Décris précisément ce que cet agent doit accomplir. Il reçoit le résultat de l'agent précédent en entrée, et son résultat final sera transmis au suivant.">${esc(cfg.mission || '')}</textarea></div>

          ${S.providers.length ? `
          <div class="field"><label>Fournisseur IA</label>
            <select class="select" id="ndv-provider">
              ${S.providers.map(p => `<option value="${p.id}" ${cfg.providerId === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(PROVIDER_TYPES[p.type]?.label || p.type)})</option>`).join('')}
            </select></div>
          <div class="field"><label>Modèle</label>
            <input class="input mono" id="ndv-model" list="ndv-models" value="${esc(cfg.model || '')}" placeholder="défaut du fournisseur">
            <datalist id="ndv-models"></datalist></div>
          ` : `
          <div class="step-error" style="margin-bottom:16px">Aucun fournisseur IA configuré. <a href="#/providers" style="color:var(--primary)">Ajoute une clé API ici</a> pour que cet agent puisse fonctionner.</div>`}

          <div class="field"><label>Température · <span id="ndv-temp-val">${cfg.temperature ?? 0.7}</span></label>
            <div class="range-row"><span class="hint">précis</span>
              <input type="range" min="0" max="1" step="0.1" id="ndv-temp" value="${cfg.temperature ?? 0.7}">
              <span class="hint">créatif</span></div></div>

          <div class="field"><label>Itérations max (appels d'outils)</label>
            <input class="input" type="number" min="1" max="25" id="ndv-iter" value="${cfg.maxIterations || 8}"></div>

          <div class="field"><label>Connecteurs de l'agent (ses outils)</label>
            <div id="ndv-creds">${credRows()}</div>
            <button class="btn btn-outline btn-sm" id="ndv-new-cred">＋ Nouvel identifiant</button></div>

          <div class="ndv-sep">Fiabilité</div>

          <div class="two-fields">
            <div class="field"><label>Réessais si échec</label>
              <input class="input" type="number" min="0" max="5" id="ndv-retries" value="${cfg.retries ?? 0}"></div>
            <div class="field"><label>Délai entre essais (s)</label>
              <input class="input" type="number" min="1" max="120" id="ndv-retry-delay" value="${cfg.retryDelay ?? 3}"></div>
          </div>
          <div class="field"><label>Si l'agent échoue quand même</label>
            <select class="select" id="ndv-onerror">
              <option value="stop" ${cfg.onError !== 'continue' ? 'selected' : ''}>Arrêter la chaîne (défaut)</option>
              <option value="continue" ${cfg.onError === 'continue' ? 'selected' : ''}>Continuer sans lui</option>
            </select>
            <div class="hint">Utile pour les APIs capricieuses : l'agent retente avant d'abandonner.</div></div>

          <div class="ndv-sep">Aiguillage</div>

          <div class="field">
            <label class="check-row">
              <input type="checkbox" id="ndv-router" ${cfg.isRouter ? 'checked' : ''}>
              <span>Cet agent est un <strong>aiguilleur</strong></span>
            </label>
            <div class="hint">S'il a plusieurs agents branchés en sortie, il choisira lui-même lequel doit traiter la suite. Les autres branches seront ignorées.</div></div>
          <div class="field"><label>Critère de choix (optionnel)</label>
            <textarea class="textarea" id="ndv-route-hint" style="min-height:56px" placeholder="Ex. : si le lead est chaud → agent commercial ; sinon → agent newsletter.">${esc(cfg.routeHint || '')}</textarea></div>
        </div>

        <div class="ndv-output">
          <div class="ndv-output-head"><span>Test de l'agent</span><span id="ndv-test-status"></span></div>
          <div class="ndv-output-body" id="ndv-steps">
            <div class="out-empty"><div class="big">🧪</div>Teste cet agent seul, sans lancer toute la chaîne.<br>Il utilisera réellement ses connecteurs.</div>
          </div>
          <div class="ndv-input-zone">
            <div class="field" style="margin-bottom:10px"><label>Entrée simulée (ce que l'agent précédent lui enverrait)</label>
              <textarea class="textarea" id="ndv-test-input" style="min-height:60px"></textarea></div>
            <button class="btn btn-primary" id="ndv-test" style="width:100%; justify-content:center">▶ Tester l'agent</button>
          </div>
        </div>
      </div>
    </div>`, {
    onClose: () => { syncNode(); cv.updateNode(node); }
  });

  /* ----- bindings ----- */
  function syncNode() {
    node.name = $('#ndv-name', m.el).value.trim() || 'Agent';
    cfg.mission = $('#ndv-mission', m.el).value;
    if ($('#ndv-provider', m.el)) cfg.providerId = $('#ndv-provider', m.el).value;
    if ($('#ndv-model', m.el)) cfg.model = $('#ndv-model', m.el).value.trim();
    cfg.temperature = Number($('#ndv-temp', m.el).value);
    cfg.maxIterations = Number($('#ndv-iter', m.el).value) || 8;
    cfg.credentialIds = $$('#ndv-creds input:checked', m.el).map(i => i.dataset.cred);
    cfg.retries = Math.min(Math.max(Number($('#ndv-retries', m.el).value) || 0, 0), 5);
    cfg.retryDelay = Math.min(Math.max(Number($('#ndv-retry-delay', m.el).value) || 3, 1), 120);
    cfg.onError = $('#ndv-onerror', m.el).value;
    cfg.isRouter = $('#ndv-router', m.el).checked;
    cfg.routeHint = $('#ndv-route-hint', m.el).value.trim();
  }

  m.el.addEventListener('input', () => { $('#ndv-temp-val', m.el).textContent = $('#ndv-temp', m.el).value; });

  $$('.ico-btn', m.el).forEach(b => b.addEventListener('click', () => {
    $$('.ico-btn', m.el).forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    cfg.icon = b.dataset.ico;
    $('#ndv-head-ico', m.el).textContent = cfg.icon;
  }));
  $$('.color-dot', m.el).forEach(b => b.addEventListener('click', () => {
    $$('.color-dot', m.el).forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    cfg.color = b.dataset.color;
    $('#ndv-head-ico', m.el).style.background = cfg.color + '26';
  }));

  const syncModels = () => {
    const sel = $('#ndv-provider', m.el);
    if (!sel) return;
    const p = S.providers.find(x => x.id === sel.value);
    const list = PROVIDER_TYPES[p?.type]?.models || [];
    $('#ndv-models', m.el).innerHTML = list.map(x => `<option value="${x}">`).join('');
    $('#ndv-model', m.el).placeholder = p?.default_model ? `défaut : ${p.default_model}` : 'ex. claude-sonnet-4-6';
  };
  $('#ndv-provider', m.el)?.addEventListener('change', syncModels);
  syncModels();

  $('#ndv-creds', m.el).addEventListener('change', () => {
    $$('#ndv-creds .cred-check', m.el).forEach(l => l.classList.toggle('sel', $('input', l).checked));
  });

  $('#ndv-new-cred', m.el).addEventListener('click', () => {
    syncNode();
    openCredentialModal({
      onSaved: async (newId) => {
        S.credentials = await API.get('/api/credentials');
        if (newId && !(cfg.credentialIds || []).includes(newId)) (cfg.credentialIds = cfg.credentialIds || []).push(newId);
        $('#ndv-creds', m.el).innerHTML = credRows();
      }
    });
  });

  /* ----- test de l'agent ----- */
  $('#ndv-test', m.el).addEventListener('click', async () => {
    syncNode();
    if (!cfg.providerId) return toast('Configure d\'abord un fournisseur IA.', 'error');
    const btn = $('#ndv-test', m.el);
    const stepsEl = $('#ndv-steps', m.el);
    btn.disabled = true;
    $('#ndv-test-status', m.el).innerHTML = '<span class="spinner"></span>';
    stepsEl.innerHTML = '<div class="out-empty"><span class="spinner"></span><br><br>L\'agent travaille… (les étapes s\'affichent à la fin du test)</div>';
    try {
      const r = await API.post('/api/agents/test', { node, input: $('#ndv-test-input', m.el).value });
      stepsEl.innerHTML = (r.steps || []).map(stepHtml).join('') +
        `<div class="step step-final">${esc(r.output)}${imageGallery(r.output)}</div>`;
    } catch (e) {
      stepsEl.innerHTML = `<div class="step step-error">${esc(e.message)}</div>`;
    }
    btn.disabled = false;
    $('#ndv-test-status', m.el).textContent = '';
  });
}

/* ================================================================
   BOOT
   ================================================================ */
route();
