'use strict';
/*
 * LCanvas — éditeur de nodes façon n8n en vanilla JS.
 * API :
 *   const cv = LCanvas.create(containerEl, { onChange, onOpenNode })
 *   cv.load({nodes, connections}) / cv.getData()
 *   cv.addNode(node) / cv.removeNode(id) / cv.updateNode(node)
 *   cv.setNodeStatus(id, 'running'|'ok'|'error'|'skipped'|null)
 *   cv.setConnStatus('from->to', 'flowing'|'done'|null) / cv.clearRunStatus()
 *   cv.fit() / cv.zoom(f) / cv.centerWorld()
 */
const LCanvas = (() => {

  const NODE_W = 110, HANDLE_Y = 55, OUT_X = 111, IN_X = -1;

  function create(container, opts = {}) {
    const state = {
      nodes: [], connections: [],
      vp: { x: 0, y: 0, z: 1 },
      sel: null,                 // {type:'node'|'conn', id|key}
      nodeStatus: {}, connStatus: {},
      drag: null, pan: null, link: null
    };

    container.innerHTML = `
      <div class="canvas">
        <svg xmlns="http://www.w3.org/2000/svg">
          <g class="conn-group"></g>
          <g class="temp-group"></g>
        </svg>
        <div class="nodes-layer"></div>
      </div>`;
    const canvasEl = container.querySelector('.canvas');
    const svg = container.querySelector('svg');
    const connGroup = svg.querySelector('.conn-group');
    const tempGroup = svg.querySelector('.temp-group');
    const layer = container.querySelector('.nodes-layer');

    /* ---------- helpers coordonnées ---------- */
    const toWorld = (sx, sy) => {
      const r = canvasEl.getBoundingClientRect();
      return { x: (sx - r.left - state.vp.x) / state.vp.z, y: (sy - r.top - state.vp.y) / state.vp.z };
    };
    const centerWorld = () => {
      const r = canvasEl.getBoundingClientRect();
      return { x: (r.width / 2 - state.vp.x) / state.vp.z, y: (r.height / 2 - state.vp.y) / state.vp.z };
    };

    const emit = () => opts.onChange && opts.onChange();

    /* ---------- rendu ---------- */
    function applyViewport() {
      const { x, y, z } = state.vp;
      layer.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      connGroup.setAttribute('transform', `translate(${x} ${y}) scale(${z})`);
      tempGroup.setAttribute('transform', `translate(${x} ${y}) scale(${z})`);
      canvasEl.style.backgroundSize = `${24 * z}px ${24 * z}px`;
      canvasEl.style.backgroundPosition = `${x}px ${y}px`;
    }

    function bezier(x1, y1, x2, y2) {
      const dx = Math.max(55, Math.abs(x2 - x1) * 0.5);
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }

    function connKey(c) { return `${c.from}->${c.to}`; }

    function renderConns() {
      const byId = new Map(state.nodes.map(n => [n.id, n]));
      let html = '';
      for (const c of state.connections) {
        const a = byId.get(c.from), b = byId.get(c.to);
        if (!a || !b) continue;
        const key = connKey(c);
        const x1 = a.x + OUT_X, y1 = a.y + HANDLE_Y, x2 = b.x + IN_X, y2 = b.y + HANDLE_Y;
        const d = bezier(x1, y1, x2, y2);
        const flow = state.connStatus[key] || '';
        const sel = state.sel?.type === 'conn' && state.sel.key === key;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        html += `<g class="conn-g ${flow} ${sel ? 'selected' : ''}" data-key="${key}">
          <path class="conn-hit" d="${d}"></path>
          <path class="conn-path" d="${d}"></path>
          ${sel ? `<g class="conn-del" data-key="${key}" transform="translate(${mx} ${my})">
            <circle r="10"></circle><text text-anchor="middle" dominant-baseline="central">✕</text>
          </g>` : ''}
        </g>`;
      }
      connGroup.innerHTML = html;
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function renderNodes() {
      layer.innerHTML = state.nodes.map(n => {
        const st = state.nodeStatus[n.id] || '';
        const sel = state.sel?.type === 'node' && state.sel.id === n.id;
        const color = n.config?.color || '#ff6d5a';
        return `<div class="node ${st} ${sel ? 'selected' : ''}" data-id="${n.id}" style="left:${n.x}px; top:${n.y}px">
          <div class="node-actions">
            <button class="act-open" title="Configurer & tester">⚙</button>
            <button class="act-dup" title="Dupliquer">⧉</button>
            <button class="act-del del" title="Supprimer">🗑</button>
          </div>
          <div class="node-box">
            <div class="node-ico" style="background:${color}26">${esc(n.config?.icon || '🤖')}</div>
            <div class="node-badge ok">✓</div>
            <div class="node-badge err">!</div>
            <div class="node-badge run"><span class="spinner"></span></div>
            <div class="handle handle-in" data-id="${n.id}"></div>
            <div class="handle handle-out" data-id="${n.id}"></div>
          </div>
          <div class="node-name">${esc(n.name)}</div>
          ${n.config?.model ? `<div class="node-sub">${esc(n.config.model)}</div>` : ''}
        </div>`;
      }).join('');
    }

    function render() { renderNodes(); renderConns(); applyViewport(); }

    /* ---------- sélection ---------- */
    function select(sel) {
      state.sel = sel;
      layer.querySelectorAll('.node').forEach(el => {
        el.classList.toggle('selected', sel?.type === 'node' && el.dataset.id === sel.id);
      });
      renderConns();
    }

    /* ---------- cycle ? ---------- */
    function wouldCycle(from, to) {
      if (from === to) return true;
      const adj = new Map();
      for (const c of state.connections) {
        if (!adj.has(c.from)) adj.set(c.from, []);
        adj.get(c.from).push(c.to);
      }
      const stack = [to], seen = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (cur === from) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const nx of adj.get(cur) || []) stack.push(nx);
      }
      return false;
    }

    /* ---------- événements ---------- */
    canvasEl.addEventListener('pointerdown', (e) => {
      const handleOut = e.target.closest('.handle-out');
      const handleIn = e.target.closest('.handle-in');
      const action = e.target.closest('.node-actions button');
      const nodeEl = e.target.closest('.node');
      const connDel = e.target.closest('.conn-del');
      const connHit = e.target.closest('.conn-g');

      if (action) return; // géré au click

      if (connDel) {
        const key = connDel.dataset.key;
        state.connections = state.connections.filter(c => connKey(c) !== key);
        state.sel = null;
        renderConns(); emit();
        e.stopPropagation();
        return;
      }

      if (handleOut) {
        e.stopPropagation(); e.preventDefault();
        state.link = { from: handleOut.dataset.id };
        return;
      }
      if (handleIn) { e.stopPropagation(); e.preventDefault(); return; }

      if (nodeEl) {
        e.preventDefault();
        const node = state.nodes.find(n => n.id === nodeEl.dataset.id);
        const w = toWorld(e.clientX, e.clientY);
        state.drag = { node, el: nodeEl, ox: w.x - node.x, oy: w.y - node.y, moved: false };
        return;
      }

      if (connHit) {
        select({ type: 'conn', key: connHit.dataset.key });
        e.stopPropagation();
        return;
      }

      // fond → pan
      state.pan = { sx: e.clientX, sy: e.clientY, vx: state.vp.x, vy: state.vp.y };
      canvasEl.classList.add('panning');
      select(null);
    });

    document.addEventListener('pointermove', (e) => {
      if (state.pan) {
        state.vp.x = state.pan.vx + (e.clientX - state.pan.sx);
        state.vp.y = state.pan.vy + (e.clientY - state.pan.sy);
        applyViewport();
      } else if (state.drag) {
        const w = toWorld(e.clientX, e.clientY);
        const nx = Math.round(w.x - state.drag.ox), ny = Math.round(w.y - state.drag.oy);
        if (nx !== state.drag.node.x || ny !== state.drag.node.y) state.drag.moved = true;
        state.drag.node.x = nx; state.drag.node.y = ny;
        state.drag.el.style.left = nx + 'px';
        state.drag.el.style.top = ny + 'px';
        renderConns();
      } else if (state.link) {
        const from = state.nodes.find(n => n.id === state.link.from);
        if (!from) return;
        const w = toWorld(e.clientX, e.clientY);
        tempGroup.innerHTML = `<path class="temp-path" d="${bezier(from.x + OUT_X, from.y + HANDLE_Y, w.x, w.y)}"></path>`;
      }
    });

    document.addEventListener('pointercancel', () => {
      if (state.pan) { state.pan = null; canvasEl.classList.remove('panning'); }
      if (state.drag) { state.drag = null; }
      if (state.link) { state.link = null; tempGroup.innerHTML = ''; }
    });

    document.addEventListener('pointerup', (e) => {
      if (state.pan) { state.pan = null; canvasEl.classList.remove('panning'); }
      if (state.drag) {
        if (!state.drag.moved) select({ type: 'node', id: state.drag.node.id });
        else emit();
        state.drag = null;
      }
      if (state.link) {
        tempGroup.innerHTML = '';
        const targetEl = document.elementFromPoint(e.clientX, e.clientY);
        const nodeEl = targetEl && targetEl.closest ? targetEl.closest('.node') : null;
        if (nodeEl) {
          const to = nodeEl.dataset.id, from = state.link.from;
          const exists = state.connections.some(c => c.from === from && c.to === to);
          if (to !== from && !exists) {
            if (wouldCycle(from, to)) {
              opts.onToast && opts.onToast('Impossible : cela créerait une boucle dans la chaîne.', 'error');
            } else {
              state.connections.push({ from, to });
              renderConns(); emit();
            }
          }
        }
        state.link = null;
      }
    });

    canvasEl.addEventListener('click', (e) => {
      const action = e.target.closest('.node-actions button');
      if (!action) return;
      const nodeEl = action.closest('.node');
      const node = state.nodes.find(n => n.id === nodeEl.dataset.id);
      if (action.classList.contains('act-open')) opts.onOpenNode && opts.onOpenNode(node);
      else if (action.classList.contains('act-del')) api.removeNode(node.id);
      else if (action.classList.contains('act-dup')) {
        const copy = JSON.parse(JSON.stringify(node));
        copy.id = 'n' + Math.random().toString(36).slice(2, 9);
        copy.name = node.name + ' (copie)';
        copy.x += 60; copy.y += 60;
        api.addNode(copy);
      }
    });

    canvasEl.addEventListener('dblclick', (e) => {
      const nodeEl = e.target.closest('.node');
      if (nodeEl) {
        const node = state.nodes.find(n => n.id === nodeEl.dataset.id);
        opts.onOpenNode && opts.onOpenNode(node);
      }
    });

    canvasEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const r = canvasEl.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const wz = { x: (mx - state.vp.x) / state.vp.z, y: (my - state.vp.y) / state.vp.z };
      state.vp.z = Math.min(2.5, Math.max(0.2, state.vp.z * factor));
      state.vp.x = mx - wz.x * state.vp.z;
      state.vp.y = my - wz.y * state.vp.z;
      applyViewport();
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (!container.isConnected) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) {
        if (state.sel.type === 'node') api.removeNode(state.sel.id);
        else {
          state.connections = state.connections.filter(c => connKey(c) !== state.sel.key);
          state.sel = null; renderConns(); emit();
        }
      }
      if (e.key === 'Escape') { state.link = null; tempGroup.innerHTML = ''; select(null); }
    });

    /* ---------- API publique ---------- */
    const api = {
      load(data) {
        state.nodes = data.nodes || [];
        state.connections = data.connections || [];
        state.nodeStatus = {}; state.connStatus = {}; state.sel = null;
        render();
        if (state.nodes.length) api.fit();
      },
      getData() {
        return { nodes: state.nodes, connections: state.connections };
      },
      addNode(node) {
        if (node.x === undefined) {
          const c = centerWorld();
          const offset = (state.nodes.length % 5) * 30;
          node.x = Math.round(c.x - NODE_W / 2 + offset);
          node.y = Math.round(c.y - 70 + offset);
        }
        state.nodes.push(node);
        render(); emit();
        return node;
      },
      updateNode(node) {
        const i = state.nodes.findIndex(n => n.id === node.id);
        if (i >= 0) { state.nodes[i] = node; render(); emit(); }
      },
      removeNode(id) {
        state.nodes = state.nodes.filter(n => n.id !== id);
        state.connections = state.connections.filter(c => c.from !== id && c.to !== id);
        state.sel = null;
        render(); emit();
      },
      setNodeStatus(id, status) {
        state.nodeStatus[id] = status || '';
        const el = layer.querySelector(`.node[data-id="${id}"]`);
        if (el) {
          el.classList.remove('running', 'ok', 'error', 'skipped');
          if (status) el.classList.add(status);
        }
      },
      setConnStatus(key, status) {
        if (status) state.connStatus[key] = status; else delete state.connStatus[key];
        renderConns();
      },
      clearRunStatus() {
        state.nodeStatus = {}; state.connStatus = {};
        layer.querySelectorAll('.node').forEach(el => el.classList.remove('running', 'ok', 'error', 'skipped'));
        renderConns();
      },
      markIncomingFlow(nodeId, status) {
        for (const c of state.connections) {
          if (c.to === nodeId) api.setConnStatus(connKey(c), status);
        }
      },
      fit() {
        if (!state.nodes.length) { state.vp = { x: 0, y: 0, z: 1 }; applyViewport(); return; }
        const r = canvasEl.getBoundingClientRect();
        const xs = state.nodes.map(n => n.x), ys = state.nodes.map(n => n.y);
        const minX = Math.min(...xs) - 60, minY = Math.min(...ys) - 80;
        const maxX = Math.max(...xs) + NODE_W + 60, maxY = Math.max(...ys) + 200;
        const bw = maxX - minX, bh = maxY - minY;
        const z = Math.min(1.15, Math.max(0.2, Math.min(r.width / bw, r.height / bh)));
        state.vp.z = z;
        state.vp.x = (r.width - bw * z) / 2 - minX * z;
        state.vp.y = (r.height - bh * z) / 2 - minY * z;
        applyViewport();
      },
      zoom(f) {
        const r = canvasEl.getBoundingClientRect();
        const mx = r.width / 2, my = r.height / 2;
        const wz = { x: (mx - state.vp.x) / state.vp.z, y: (my - state.vp.y) / state.vp.z };
        state.vp.z = Math.min(2.5, Math.max(0.2, state.vp.z * f));
        state.vp.x = mx - wz.x * state.vp.z;
        state.vp.y = my - wz.y * state.vp.z;
        applyViewport();
      },
      resetZoom() { state.vp.z = 1; applyViewport(); },
      centerWorld,
      get state() { return state; }
    };

    render();
    return api;
  }

  return { create };
})();
