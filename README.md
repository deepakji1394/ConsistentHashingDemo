# Consistent Hashing Interactive Demo

A hands-on visual demo of consistent hashing — add/remove servers and keys on a live ring, watch key migration animations, and read step-by-step explanations of every routing decision.

---

## Screenshots

### Ring Visualization

Servers (filled circles) and keys (diamonds) placed on the hash ring. Dashed lines connect each key to its owning server. The legend shows node count and key count per server.

![Ring visualization — servers S2 and S3 with keys distributed across the ring](DemoImages/Screenshot%202026-07-11%20at%205.19.58%20PM.png)

### Explanation Panel

Every operation produces a step-by-step breakdown: the FNV-1a hash values used to place server nodes, the clockwise routing rule, and exactly which keys migrated and why.

![Explanation panel — adding server S4 with 3 virtual nodes, showing hash positions and 3 key migrations](DemoImages/Screenshot%202026-07-11%20at%205.20.20%20PM.png)

---

## What This Demonstrates

| Concept | What you see |
| --- | --- |
| **Hash ring** | 0–3600 space arranged as a circle; positions map to angles |
| **Server placement** | Each virtual node placed at `FNV-1a("name#i") mod 3600` |
| **Key routing** | Key scans clockwise → first server node found wins |
| **Virtual nodes** | Multiple ring positions per server for even distribution |
| **Add server** | Only keys between the new node and its predecessor migrate |
| **Remove server** | Only orphaned keys (owned by that server) migrate to next node |

---

## Project Structure

```
ConsistentHashingDemo/
├── backend/
│   ├── ConsistentHashRing.java   # Core ring logic and optimized key reassignment
│   ├── ConsistentHashDemo.java   # HTTP server (port 8080) + request handlers
│   └── run.sh                    # Compile + start script
├── frontend/
│   ├── index.html                # Single-page UI layout
│   ├── style.css                 # Styling (layout, panel, animations)
│   └── app.js                    # Canvas ring drawing, animations, API calls, explanations
├── DemoImages/                   # Screenshots used in this README
└── README.md
```

---

## How to Run

### 1. Start the backend

```bash
cd backend
chmod +x run.sh   # first time only
./run.sh
```

Expected output:

```
Compiling...
Starting server on http://localhost:8080
Open frontend/index.html in your browser.
```

### 2. Open the frontend

Open `frontend/index.html` directly in your browser — no web server needed.

> **Note:** Keep the terminal with `run.sh` running. Stop it with `Ctrl+C`.

---

## Suggested Demo Flow

Follow these steps to observe all core consistent hashing behaviours:

### Step 1 — Add servers with virtual nodes

- Add **S1** with 3 virtual nodes → 3 coloured dots appear on the ring
- Add **S2** with 3 virtual nodes → 3 more dots; observe how the ring is now shared

### Step 2 — Add keys and observe routing

- Add keys like `user:1`, `user:2`, `user:3`
- Each key appears as a diamond on the ring
- The explanation panel shows the exact hash value and which clockwise scan found which server

### Step 3 — Add more servers and watch migration

- Add **S3** with 2 virtual nodes
- Keys between S3's new positions and their previous servers animate to S3
- Notice: **only a subset of keys migrate** — this is the core advantage over modular hashing

### Step 4 — Remove a server

- Remove **S1** from the dropdown
- Only S1's owned keys animate to their next clockwise server
- S2's and S3's keys are completely unaffected

### Step 5 — Observe load distribution

- Add 8–10 keys and check the legend (nodes · keys per server)
- Increase virtual nodes on a new server to see how it captures more keys
- Notice better balance with more virtual nodes

---

## Technical Details

### Hash Function — FNV-1a 32-bit

```
hash(input):
    h = 2166136261   (offset basis)
    for each byte b in UTF-8(input):
        h = h XOR b
        h = (h × 16777619) AND 0xFFFFFFFF   (keep 32-bit unsigned)
    return h mod 3600
```

Virtual node `i` of server `S` hashes the string `"S#i"`. The same function runs in both Java (backend) and JavaScript (frontend explanation panel), so displayed positions always match the ring.

### Optimized Key Reassignment

**Remove server** — O(keys owned by that server):
Only keys where `keyOwner == removedServer` are iterated. All other keys' clockwise successor is geometrically unchanged.

**Add server** — O(keys owned by successor servers):
Before inserting new nodes, each new position's current clockwise successor is found. Only keys owned by those successor servers can possibly be captured by the new server. This is collected into `affectedServers`, then only those keys are checked.

This replaces the naïve O(all keys) full scan.

### Ring Routing

```
getOwnerAt(position):
    entry = ring.ceilingEntry(position)   // first node >= position
    if entry == null: entry = ring.firstEntry()   // wrap around
    return serverName from entry value ("serverName#vIndex")
```

### HTTP API

All endpoints on `http://localhost:8080`. CORS headers enabled for local development.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/state` | — | Full ring snapshot |
| `POST` | `/api/server` | `{"name":"S1","virtualNodes":3}` | `{movedKeys:[...]}` |
| `DELETE` | `/api/server` | `{"name":"S1"}` | `{movedKeys:[...]}` |
| `POST` | `/api/key` | `{"key":"user:1","value":"Alice"}` | `{server, position}` |
| `DELETE` | `/api/key` | `{"key":"user:1"}` | `{}` |

**`movedKeys` schema:**

```json
[{"key": "user:1", "fromServer": "S1", "toServer": "S2", "position": 1627}]
```

### Stack

| Layer | Technology |
| --- | --- |
| Backend | Java 17, `com.sun.net.httpserver.HttpServer` (built-in JDK, no Maven) |
| Frontend | Pure HTML/CSS/JavaScript, Canvas API |
| No external dependencies | Everything runs with `javac`, `java`, and a browser |
