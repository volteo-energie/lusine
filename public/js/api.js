'use strict';
/* Client API de L'usine */

const API = {
  async req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data?.error || `Erreur ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get: (url) => API.req('GET', url),
  post: (url, body) => API.req('POST', url, body ?? {}),
  put: (url, body) => API.req('PUT', url, body ?? {}),
  del: (url) => API.req('DELETE', url)
};

/* ---------- WebSocket temps réel ---------- */
const WS = {
  socket: null,
  listeners: new Set(),
  on(fn) { WS.listeners.add(fn); return () => WS.listeners.delete(fn); },
  connect() {
    if (WS.socket && (WS.socket.readyState === 0 || WS.socket.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    WS.socket = ws;
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      for (const fn of WS.listeners) { try { fn(msg); } catch (err) { console.error(err); } }
    };
    ws.onclose = () => { setTimeout(() => WS.connect(), 2500); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
};
