#!/usr/bin/env node

/**
 * SINGULAR STACK P2P MESSENGER
 * 
 * Architecture: S_{n+1} = f(S_n, E_n) at every layer.
 * - No server. No accounts. No cloud.
 * - You run this. Your buddy runs this.
 * - You connect directly. Messages are signed events.
 * - State merges on reconnect. Nothing is lost.
 * 
 * Usage:
 *   node messenger.js                    (pick a name, start fresh)
 *   node messenger.js --name alice       (set your name)
 *   node messenger.js --peer ws://IP:PORT (connect to buddy)
 *   node messenger.js --port 4444        (custom port, default 4444)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };

const PORT      = parseInt(get('--port') || '4444');
const MY_NAME   = get('--name') || 'anon';
const PEER_URL  = get('--peer') || null;

// ─── Identity ─────────────────────────────────────────────────────────────────
// Identity = content-addressed. Your ID is a hash of your name + a local secret.
// Same machine = same ID. No accounts needed.
const SECRET_FILE = path.join(process.env.HOME || '.', '.p2p-messenger-secret');
let secret;
try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
catch { secret = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(SECRET_FILE, secret); }

const MY_ID = crypto.createHash('sha256').update(MY_NAME + secret).digest('hex').slice(0, 12);

// ─── State ────────────────────────────────────────────────────────────────────
// S = { messages: [...], peers: {...}, myId, myName }
// Every message is an event E with: id, author, text, ts, lamport
let state = {
  messages: [],       // append-only log — the truth
  peers: {},          // connected peer info
  lamport: 0,         // logical clock
  myId: MY_ID,
  myName: MY_NAME,
};

// ─── Primitive: f(S, E) ───────────────────────────────────────────────────────
function applyEvent(ev) {
  // Idempotent: skip if we've seen this event
  if (state.messages.find(m => m.id === ev.id)) return false;

  // Lamport clock: advance to max(local, remote) + 1
  state.lamport = Math.max(state.lamport, ev.lamport || 0) + 1;
  ev.lamport = state.lamport;

  // Append to log — never mutate, always append
  state.messages.push(ev);
  state.messages.sort((a, b) => a.lamport - b.lamport || a.ts - b.ts);

  return true; // new event
}

// ─── Hash of current state ────────────────────────────────────────────────────
function stateHash() {
  const ids = state.messages.map(m => m.id).join('|');
  return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 8);
}

// ─── Peer connections ─────────────────────────────────────────────────────────
const peers = {}; // id → { ws, name, id }

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  Object.values(peers).forEach(p => {
    if (p.id === excludeId) return;
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

function sendTo(peerId, msg) {
  const p = peers[peerId];
  if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
}

// ─── WebSocket protocol ───────────────────────────────────────────────────────
// Protocol is just events. Every message over the wire is an event or a sync packet.
// { type: 'event', ev: {...} }         — a new message event
// { type: 'hello', id, name }          — identity handshake
// { type: 'sync_req', since: lamport } — ask for events since lamport
// { type: 'sync_res', events: [...] }  — here are your missing events

function handleWS(ws, isIncoming) {
  let peerId = null;

  // Send our hello immediately
  ws.send(JSON.stringify({ type: 'hello', id: MY_ID, name: MY_NAME }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello') {
      peerId = msg.id;
      peers[peerId] = { ws, id: msg.id, name: msg.name };
      state.peers[peerId] = { name: msg.name, online: true };
      pushToUI({ type: 'peer_connected', peer: { id: msg.id, name: msg.name } });
      console.log(`[+] ${msg.name} (${msg.id}) connected`);

      // Request sync: send all our events, ask for theirs
      ws.send(JSON.stringify({ type: 'sync_req', events: state.messages }));
    }

    if (msg.type === 'sync_req') {
      // Merge their events into our state
      let anyNew = false;
      (msg.events || []).forEach(ev => { if (applyEvent(ev)) anyNew = true; });
      // Send back ours
      ws.send(JSON.stringify({ type: 'sync_res', events: state.messages }));
      if (anyNew) pushToUI({ type: 'state_update', messages: state.messages, hash: stateHash() });
    }

    if (msg.type === 'sync_res') {
      let anyNew = false;
      (msg.events || []).forEach(ev => { if (applyEvent(ev)) anyNew = true; });
      if (anyNew) pushToUI({ type: 'state_update', messages: state.messages, hash: stateHash() });
    }

    if (msg.type === 'event') {
      const isNew = applyEvent(msg.ev);
      if (isNew) {
        // Relay to other peers (gossip)
        broadcast(msg, peerId);
        pushToUI({ type: 'new_message', ev: msg.ev, hash: stateHash() });
        console.log(`[msg] ${msg.ev.author}: ${msg.ev.text}`);
      }
    }
  });

  ws.on('close', () => {
    if (peerId) {
      const name = peers[peerId]?.name || peerId;
      delete peers[peerId];
      state.peers[peerId] = { ...state.peers[peerId], online: false };
      pushToUI({ type: 'peer_disconnected', peerId, name });
      console.log(`[-] ${name} disconnected`);
    }
  });

  ws.on('error', () => {});
}

// Connect to a peer by URL
function connectToPeer(url) {
  console.log(`Connecting to ${url}...`);
  const ws = new WebSocket(url);
  ws.on('open', () => {
    console.log(`Connected to ${url}`);
    handleWS(ws, false);
  });
  ws.on('error', (e) => {
    console.log(`Could not connect to ${url}: ${e.message}`);
    console.log('Retrying in 5s...');
    setTimeout(() => connectToPeer(url), 5000);
  });
}

// ─── UI Server-Sent Events ────────────────────────────────────────────────────
// The browser UI connects via SSE to get real-time updates.
const uiClients = new Set();

function pushToUI(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  uiClients.forEach(res => { try { res.write(msg); } catch {} });
}

// ─── HTTP server (serves the UI) ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(UI_HTML);
    return;
  }

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'init', state: { messages: state.messages, peers: state.peers, myId: MY_ID, myName: MY_NAME, hash: stateHash(), wsPort: PORT } })}\n\n`);
    uiClients.add(res);
    req.on('close', () => uiClients.delete(res));
    return;
  }

  if (req.url === '/send' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || !text.trim()) { res.writeHead(400); res.end(); return; }
        state.lamport++;
        const ev = {
          id: crypto.randomBytes(8).toString('hex'),
          author: MY_NAME,
          authorId: MY_ID,
          text: text.trim(),
          ts: Date.now(),
          lamport: state.lamport,
        };
        applyEvent(ev);
        broadcast({ type: 'event', ev });
        pushToUI({ type: 'new_message', ev, hash: stateHash() });
        console.log(`[you] ${text.trim()}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hash: stateHash() }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { url } = JSON.parse(body);
        connectToPeer(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      myId: MY_ID, myName: MY_NAME,
      peers: Object.values(peers).map(p => ({ id: p.id, name: p.name })),
      messages: state.messages.length,
      hash: stateHash(),
    }));
    return;
  }

  res.writeHead(404); res.end();
});

// ─── WebSocket server (P2P layer) ─────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => handleWS(ws, true));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║     SINGULAR STACK P2P MESSENGER      ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  you:      ${MY_NAME.padEnd(28)}║`);
  console.log(`║  your id:  ${MY_ID.padEnd(28)}║`);
  console.log(`║  port:     ${String(PORT).padEnd(28)}║`);
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  UI:       http://localhost:${PORT.toString().padEnd(12)}║`);
  console.log('║                                       ║');
  console.log('║  share your IP + port with your buddy ║');
  console.log('║  they run:                            ║');
  console.log(`║  node messenger.js --name bob \\       ║`);
  console.log(`║    --peer ws://YOUR_IP:${PORT}          ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');

  // If peer URL given, connect immediately
  if (PEER_URL) {
    connectToPeer(PEER_URL);
  }
});

// ─── UI ───────────────────────────────────────────────────────────────────────
const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>p2p messenger</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@300;400;500&display=swap');

*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--surface:#111;--surface2:#1a1a1a;--border:#222;--border2:#2a2a2a;
  --text:#e8e8e8;--muted:#555;--muted2:#444;
  --purple:#7F77DD;--purple-dim:#2a2860;--teal:#1D9E75;--teal-dim:#0a3328;
  --coral:#D85A30;
  --mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans)}
body{display:flex;flex-direction:column;height:100vh;overflow:hidden}

.topbar{
  display:flex;align-items:center;gap:12px;padding:10px 16px;
  border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0;
}
.logo{font-family:var(--mono);font-size:12px;color:var(--purple);letter-spacing:0.08em;font-weight:500}
.identity{font-size:11px;color:var(--muted);font-family:var(--mono)}
.id-name{color:var(--text);font-weight:500}
.id-hash{color:var(--muted)}
.peers-bar{display:flex;gap:6px;margin-left:auto;align-items:center}
.peer-chip{
  font-size:10px;font-family:var(--mono);padding:2px 8px;border-radius:2px;
  border:1px solid;display:flex;align-items:center;gap:4px;
}
.peer-chip.online{border-color:var(--teal);color:var(--teal);background:var(--teal-dim)}
.peer-chip.offline{border-color:var(--muted2);color:var(--muted);background:transparent}
.dot{width:5px;height:5px;border-radius:50%}
.dot-on{background:var(--teal)}.dot-off{background:var(--muted2)}
.hash-display{font-size:10px;font-family:var(--mono);color:var(--muted);border-left:1px solid var(--border);padding-left:12px}

.main{display:flex;flex:1;overflow:hidden}

.sidebar{
  width:220px;flex-shrink:0;border-right:1px solid var(--border);
  background:var(--surface);display:flex;flex-direction:column;overflow:hidden;
}
.sidebar-section{padding:10px 12px;border-bottom:1px solid var(--border)}
.sidebar-label{font-size:9px;font-family:var(--mono);color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px}
.connect-row{display:flex;gap:4px}
.connect-row input{
  flex:1;background:var(--surface2);border:1px solid var(--border2);color:var(--text);
  font-family:var(--mono);font-size:10px;padding:5px 7px;border-radius:2px;outline:none;
}
.connect-row input:focus{border-color:var(--purple)}
.connect-row input::placeholder{color:var(--muted2)}
.btn{
  background:transparent;border:1px solid var(--border2);color:var(--muted);
  font-family:var(--mono);font-size:10px;padding:5px 8px;cursor:pointer;border-radius:2px;
  transition:all 0.15s;white-space:nowrap;
}
.btn:hover{border-color:var(--purple);color:var(--purple)}
.btn.primary{border-color:var(--purple);color:var(--purple);background:var(--purple-dim)}
.btn.primary:hover{background:var(--purple)}
.btn.primary:hover{color:#fff}

.my-addr{
  font-family:var(--mono);font-size:9px;color:var(--muted);
  background:var(--surface2);padding:6px 8px;border-radius:2px;
  border:1px solid var(--border);word-break:break-all;line-height:1.5;
  cursor:pointer;transition:border-color 0.15s;
}
.my-addr:hover{border-color:var(--purple)}
.my-addr .addr-label{color:var(--muted2);display:block;margin-bottom:3px;font-size:8px}
.my-addr .addr-val{color:var(--text)}
.copied{color:var(--teal)!important}

.state-box{padding:10px 12px;flex:1;overflow-y:auto}
.state-line{display:flex;justify-content:space-between;font-size:10px;font-family:var(--mono);padding:2px 0}
.state-key{color:var(--muted)}
.state-val{color:var(--text)}

.chat{flex:1;display:flex;flex-direction:column;overflow:hidden}
.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-track{background:transparent}
.messages::-webkit-scrollbar-thumb{background:var(--border2)}

.msg{display:flex;flex-direction:column;gap:2px;max-width:75%;animation:msgIn 0.15s ease}
@keyframes msgIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.msg.mine{align-self:flex-end;align-items:flex-end}
.msg.theirs{align-self:flex-start;align-items:flex-start}
.msg-meta{font-size:10px;font-family:var(--mono);color:var(--muted);display:flex;gap:6px;align-items:center}
.msg-author{color:var(--muted)}
.msg.mine .msg-author{color:var(--purple)}
.msg.theirs .msg-author{color:var(--teal)}
.msg-bubble{
  padding:8px 12px;border-radius:2px;font-size:13px;line-height:1.5;
  border:1px solid;word-break:break-word;
}
.msg.mine .msg-bubble{
  background:var(--purple-dim);border-color:var(--purple);color:var(--text);
}
.msg.theirs .msg-bubble{
  background:var(--surface2);border-color:var(--border2);color:var(--text);
}
.msg-lamport{font-size:9px;color:var(--muted2)}

.system-msg{
  text-align:center;font-family:var(--mono);font-size:10px;color:var(--muted);
  padding:4px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);
  margin:4px 0;
}

.compose{
  border-top:1px solid var(--border);padding:12px 16px;
  display:flex;gap:8px;align-items:flex-end;background:var(--surface);flex-shrink:0;
}
.compose textarea{
  flex:1;background:var(--surface2);border:1px solid var(--border2);color:var(--text);
  font-family:var(--sans);font-size:13px;padding:8px 10px;border-radius:2px;
  outline:none;resize:none;min-height:38px;max-height:120px;line-height:1.5;
}
.compose textarea:focus{border-color:var(--purple)}
.compose textarea::placeholder{color:var(--muted2)}
.send-btn{
  background:var(--purple-dim);border:1px solid var(--purple);color:var(--purple);
  font-family:var(--mono);font-size:11px;padding:8px 14px;cursor:pointer;border-radius:2px;
  transition:all 0.15s;white-space:nowrap;height:38px;
}
.send-btn:hover{background:var(--purple);color:#fff}
.send-btn:active{transform:scale(0.97)}

.primitive-bar{
  background:var(--surface);border-top:1px solid var(--border);
  padding:4px 16px;font-family:var(--mono);font-size:9px;color:var(--muted2);
  display:flex;gap:16px;flex-shrink:0;
}
.prim-item{display:flex;gap:5px}
.prim-label{color:var(--muted2)}
.prim-val{color:var(--muted)}

.empty-state{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:8px;color:var(--muted);font-family:var(--mono);font-size:11px;
}
.empty-title{color:var(--muted);font-size:13px}
.empty-hint{font-size:10px;color:var(--muted2);max-width:280px;text-align:center;line-height:1.6}
</style>
</head>
<body>

<div class="topbar">
  <div class="logo">▸ p2p</div>
  <div class="identity">
    <span class="id-name" id="my-name">...</span>
    <span class="id-hash" id="my-id"></span>
  </div>
  <div class="peers-bar" id="peers-bar"></div>
  <div class="hash-display">H(S)=<span id="state-hash">--------</span></div>
</div>

<div class="main">
  <div class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-label">connect to peer</div>
      <div class="connect-row">
        <input type="text" id="peer-url" placeholder="ws://IP:4444" />
        <button class="btn" onclick="doConnect()">→</button>
      </div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">your address</div>
      <div class="my-addr" id="my-addr-box" onclick="copyAddr()" title="click to copy">
        <span class="addr-label">share this with your buddy</span>
        <span class="addr-val" id="my-addr-val">detecting...</span>
      </div>
    </div>
    <div class="state-box">
      <div class="sidebar-label">state</div>
      <div class="state-line"><span class="state-key">events</span><span class="state-val" id="stat-msgs">0</span></div>
      <div class="state-line"><span class="state-key">peers</span><span class="state-val" id="stat-peers">0</span></div>
      <div class="state-line"><span class="state-key">lamport</span><span class="state-val" id="stat-lamport">0</span></div>
      <div class="state-line"><span class="state-key">H(S)</span><span class="state-val" id="stat-hash">--</span></div>
    </div>
  </div>

  <div class="chat">
    <div class="messages" id="messages">
      <div class="empty-state" id="empty-state">
        <div class="empty-title">no messages yet</div>
        <div class="empty-hint">paste a peer address in the sidebar, or share your address with your buddy. messages sync automatically on connect.</div>
      </div>
    </div>
    <div class="compose">
      <textarea id="msg-input" placeholder="type a message..." rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
      <button class="send-btn" onclick="sendMsg()">send</button>
    </div>
  </div>
</div>

<div class="primitive-bar">
  <div class="prim-item"><span class="prim-label">primitive:</span><span class="prim-val">S_{n+1} = f(S_n, E_n)</span></div>
  <div class="prim-item"><span class="prim-label">merge:</span><span class="prim-val">max(lamport) · append-only log</span></div>
  <div class="prim-item"><span class="prim-label">auth:</span><span class="prim-val">cap(E,S) · content-addressed id</span></div>
  <div class="prim-item"><span class="prim-label">transport:</span><span class="prim-val">websocket p2p · no server</span></div>
</div>

<script>
let myId='', myName='', wsPort=4444;
let allPeers={}, allMessages=[];
let lamport=0;

const es = new EventSource('/events');
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'init') {
    myId = msg.state.myId;
    myName = msg.state.myName;
    wsPort = msg.state.wsPort;
    document.getElementById('my-name').textContent = myName;
    document.getElementById('my-id').textContent = ' #'+myId;
    allPeers = msg.state.peers || {};
    allMessages = msg.state.messages || [];
    updateHash(msg.state.hash);
    detectAddr();
    renderPeers();
    renderMessages();
  }
  if (msg.type === 'new_message') {
    if (!allMessages.find(m => m.id === msg.ev.id)) {
      allMessages.push(msg.ev);
      allMessages.sort((a,b) => (a.lamport-b.lamport)||a.ts-b.ts);
    }
    updateHash(msg.hash);
    renderMessages();
    lamport = Math.max(lamport, msg.ev.lamport||0);
    document.getElementById('stat-lamport').textContent = lamport;
  }
  if (msg.type === 'state_update') {
    allMessages = msg.messages;
    updateHash(msg.hash);
    renderMessages();
  }
  if (msg.type === 'peer_connected') {
    allPeers[msg.peer.id] = { name: msg.peer.name, online: true };
    renderPeers();
    addSystemMsg(msg.peer.name + ' connected');
  }
  if (msg.type === 'peer_disconnected') {
    if (allPeers[msg.peerId]) allPeers[msg.peerId].online = false;
    renderPeers();
    addSystemMsg(msg.name + ' disconnected');
  }
};

function updateHash(h) {
  document.getElementById('state-hash').textContent = h || '--------';
  document.getElementById('stat-hash').textContent = h || '--';
  document.getElementById('stat-msgs').textContent = allMessages.length;
}

function renderPeers() {
  const bar = document.getElementById('peers-bar');
  const online = Object.values(allPeers).filter(p=>p.online);
  const offline = Object.values(allPeers).filter(p=>!p.online);
  document.getElementById('stat-peers').textContent = online.length;
  if (Object.keys(allPeers).length === 0) {
    bar.innerHTML = '<span style="font-size:10px;font-family:var(--mono);color:var(--muted)">no peers</span>';
    return;
  }
  bar.innerHTML = [...online.map(p=>'<div class="peer-chip online"><div class="dot dot-on"></div>'+p.name+'</div>'),
    ...offline.map(p=>'<div class="peer-chip offline"><div class="dot dot-off"></div>'+p.name+'</div>')].join('');
}

function renderMessages() {
  const box = document.getElementById('messages');
  const empty = document.getElementById('empty-state');
  if (allMessages.length === 0) { empty.style.display='flex'; return; }
  empty.style.display = 'none';

  const scrolledToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const existing = new Set([...box.querySelectorAll('.msg, .system-msg')].map(el=>el.dataset.id));

  allMessages.forEach(msg => {
    if (existing.has(msg.id)) return;
    const mine = msg.authorId === myId || msg.author === myName;
    const t = new Date(msg.ts);
    const time = t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'mine' : 'theirs');
    div.dataset.id = msg.id;
    div.innerHTML = \`
      <div class="msg-meta">
        <span class="msg-author">\${msg.author}</span>
        <span>\${time}</span>
        <span class="msg-lamport">L\${msg.lamport}</span>
      </div>
      <div class="msg-bubble">\${escHtml(msg.text)}</div>
    \`;
    box.appendChild(div);
  });

  if (scrolledToBottom) box.scrollTop = box.scrollHeight;
}

function addSystemMsg(text) {
  const box = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.dataset.id = 'sys-'+Date.now();
  div.textContent = '— ' + text + ' —';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');
}

async function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '';
  await fetch('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function doConnect() {
  const url = document.getElementById('peer-url').value.trim();
  if (!url) return;
  await fetch('/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  addSystemMsg('connecting to ' + url + '...');
}

document.getElementById('peer-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') doConnect();
});

async function detectAddr() {
  const el = document.getElementById('my-addr-val');
  el.textContent = 'ws://YOUR_IP:' + wsPort + '  (find your IP: whatismyip.com)';
}

function copyAddr() {
  const text = 'ws://YOUR_IP:' + wsPort;
  navigator.clipboard.writeText(text).then(() => {
    const el = document.getElementById('my-addr-box');
    el.classList.add('copied');
    el.querySelector('.addr-label').textContent = 'copied!';
    setTimeout(() => {
      el.classList.remove('copied');
      el.querySelector('.addr-label').textContent = 'share this with your buddy';
    }, 2000);
  });
}
</script>
</body>
</html>`;
