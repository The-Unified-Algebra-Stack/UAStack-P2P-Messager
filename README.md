# Singular Stack P2P Messenger

No server. No accounts. No cloud. Direct peer-to-peer messaging built on one primitive:

```
S_{n+1} = f(S_n, E_n)
```

Every message is an event. State is an append-only log. Peers sync on connect.

---

## Requirements

- Node.js 16+ (check: `node --version`)
- Both you and your buddy need Node.js installed

---

## Setup (do this once)

```bash
npm install
```

---

## Running it

### You:
```bash
node messenger.js --name alice --port 4444
```

Open http://localhost:4444 in your browser.

### Your buddy (in another town):
```bash
node messenger.js --name bob --port 4444 --peer ws://YOUR_IP:4444
```

Replace `YOUR_IP` with your actual public IP address.  
Find it at: https://whatismyip.com

---

## Connecting

Two ways to connect:

**Option A — buddy connects to you (easiest):**
1. You run the app, find your IP at whatismyip.com
2. Share `ws://YOUR_IP:4444` with your buddy
3. Buddy runs: `node messenger.js --name bob --peer ws://YOUR_IP:4444`

**Option B — connect via the UI:**
1. Both of you run the app
2. One of you pastes the other's address into the "connect to peer" box in the sidebar
3. Hit enter or click →

---

## Firewall / Router note

Your buddy connects directly to your machine. You may need to:
- Open port 4444 in your OS firewall
- Forward port 4444 in your router settings (if behind NAT)

Or use a tool like `ngrok` to expose your port without router config:
```bash
npx ngrok http 4444
```
Then share the `wss://...ngrok.io` URL with your buddy.

---

## What this proves

- **State primitive holds** — every message is `f(S, E)`. Same function, same signature, local or remote.
- **No server needed** — the two nodes are the network.
- **Merge on reconnect** — disconnect, both send messages, reconnect. State merges automatically. Nothing lost.
- **Content-addressed identity** — your ID is `H(name + secret)`. No accounts. No passwords.
- **Partition tolerance** — if the connection drops, both nodes keep running. On reconnect, `merge(S_a, S_b)` runs and you see everything.

---

## Architecture

```
You                           Buddy
─────                         ─────
HTTP :4444 (UI)               HTTP :4444 (UI)  
WS   :4444 (P2P) ←──────────→ WS   :4444 (P2P)

f(S, E):  applyEvent()        same function
merge:    sync_req/sync_res   same protocol
identity: H(name+secret)      same primitive
UI:       P(S) via SSE        same projection
```

All four layers — compute, storage, auth, UI — run on `S_{n+1} = f(S_n, E_n)`.
