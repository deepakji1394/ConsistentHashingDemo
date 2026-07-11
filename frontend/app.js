// ------------------------------------------------------------------ //
//  Constants & state
// ------------------------------------------------------------------ //

const API_BASE  = 'http://localhost:8080';
const RING_SIZE = 3600;
const CX = 280, CY = 280, RING_R = 210;  // canvas center and ring radius

const PALETTE = [
    '#E53E3E', '#3182CE', '#38A169', '#D69E2E',
    '#805AD5', '#319795', '#DD6B20', '#2B6CB0'
];

const canvas = document.getElementById('ring-canvas');
const ctx    = canvas.getContext('2d');

let appState = { servers: {}, keys: [] };

const serverColorMap = new Map();   // serverName → color string
let   colorIndex = 0;

let activeAnimations = [];          // in-flight key migration animations
let animFrameId = null;

// ------------------------------------------------------------------ //
//  Utility helpers
// ------------------------------------------------------------------ //

function posToAngle(position) {
    return (position / RING_SIZE) * 2 * Math.PI - Math.PI / 2;
}

function angleToXY(angle, radius) {
    return {
        x: CX + radius * Math.cos(angle),
        y: CY + radius * Math.sin(angle)
    };
}

function drawDiamond(ctx, x, y, size, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.rect(-size / 2, -size / 2, size, size);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// FNV-1a 32-bit — matches the Java backend exactly (UTF-8 bytes)
function fnv1a(str) {
    const bytes = new TextEncoder().encode(str);
    let h = 2166136261; // offset basis
    for (const b of bytes) {
        h ^= b;
        h >>>= 0;
        h = Math.imul(h, 16777619);
        h >>>= 0;
    }
    return h % RING_SIZE;
}

// Find the node that owns a given key position in the current state
function findOwningNode(keyPos, servers) {
    const allNodes = [];
    for (const [name, nodes] of Object.entries(servers)) {
        for (const node of nodes) {
            allNodes.push({ position: node.position, label: node.label, server: name });
        }
    }
    if (allNodes.length === 0) return null;
    allNodes.sort((a, b) => a.position - b.position);
    return allNodes.find(n => n.position >= keyPos) || allNodes[0]; // wrap
}

function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function getServerColor(name) {
    if (!serverColorMap.has(name)) {
        serverColorMap.set(name, PALETTE[colorIndex++ % PALETTE.length]);
    }
    return serverColorMap.get(name);
}

function now() { return Date.now(); }

// ------------------------------------------------------------------ //
//  Log
// ------------------------------------------------------------------ //

// addLogEntry accepts a string (plain) or an array of string | {b: 'text'} segments
function addLogEntry(parts) {
    const ul = document.getElementById('log-list');
    const li = document.createElement('li');

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = new Date().toLocaleTimeString();
    li.appendChild(timeSpan);

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg';
    const segments = typeof parts === 'string' ? [parts] : parts;
    for (const seg of segments) {
        if (typeof seg === 'string') {
            msgSpan.appendChild(document.createTextNode(seg));
        } else if (seg.b != null) {
            const b = document.createElement('b');
            b.textContent = seg.b;
            msgSpan.appendChild(b);
        }
    }
    li.appendChild(msgSpan);
    ul.prepend(li);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
}

// ------------------------------------------------------------------ //
//  UI sync
// ------------------------------------------------------------------ //

function syncControlPanel() {
    const serverNames = Object.keys(appState.servers);
    const keyNames    = appState.keys.map(k => k.key);

    // Server remove dropdown
    const sSelect = document.getElementById('server-remove-select');
    const sVal = sSelect.value;
    sSelect.innerHTML = '<option value="">— select server —</option>';
    serverNames.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        if (n === sVal) opt.selected = true;
        sSelect.appendChild(opt);
    });

    // Key remove dropdown
    const kSelect = document.getElementById('key-remove-select');
    const kVal = kSelect.value;
    kSelect.innerHTML = '<option value="">— select key —</option>';
    appState.keys.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k.key; opt.textContent = `${k.key} → ${k.server}`;
        if (k.key === kVal) opt.selected = true;
        kSelect.appendChild(opt);
    });

    // Legend
    const legend = document.getElementById('legend-items');
    legend.textContent = '';
    if (serverNames.length === 0) {
        const empty = document.createElement('span');
        empty.style.cssText = 'font-size:0.75rem;color:#A0AEC0';
        empty.textContent = 'No servers yet.';
        legend.appendChild(empty);
    } else {
        serverNames.forEach(name => {
            const color     = getServerColor(name);
            const nodeCount = (appState.servers[name] || []).length;
            const keyCount  = appState.keys.filter(k => k.server === name).length;

            const div = document.createElement('div');
            div.className = 'legend-item';

            const dot = document.createElement('span');
            dot.className = 'legend-dot';
            dot.style.background = color;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'legend-name';
            nameSpan.textContent = name;

            const countSpan = document.createElement('span');
            countSpan.className = 'legend-count';
            countSpan.textContent = `${nodeCount} nodes · ${keyCount} keys`;

            div.appendChild(dot);
            div.appendChild(nameSpan);
            div.appendChild(countSpan);
            legend.appendChild(div);
        });
    }

    // Empty hint
    const hint = document.getElementById('empty-hint');
    hint.style.display = serverNames.length === 0 ? 'block' : 'none';
}

// ------------------------------------------------------------------ //
//  Canvas rendering
// ------------------------------------------------------------------ //

function drawRing(state, animations) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const t = now();

    // 1. Background ring
    ctx.beginPath();
    ctx.arc(CX, CY, RING_R, 0, 2 * Math.PI);
    ctx.strokeStyle = '#CBD5E0';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. Hash-space tick marks (every 360 = 10%)
    for (let pos = 0; pos < RING_SIZE; pos += 360) {
        const angle = posToAngle(pos);
        const inner = angleToXY(angle, RING_R - 6);
        const outer = angleToXY(angle, RING_R + 6);
        ctx.beginPath();
        ctx.moveTo(inner.x, inner.y);
        ctx.lineTo(outer.x, outer.y);
        ctx.strokeStyle = '#A0AEC0';
        ctx.lineWidth = 1;
        ctx.stroke();
        // label
        const lp = angleToXY(angle, RING_R + 18);
        ctx.fillStyle = '#A0AEC0';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pos, lp.x, lp.y);
    }

    // 3. Dashed lines: key → owning server node
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    for (const keyInfo of state.keys) {
        const server = state.servers[keyInfo.server];
        if (!server || server.length === 0) continue;
        const color = getServerColor(keyInfo.server);

        // find the actual owning node (the one clockwise-closest to key position)
        // For display purposes, connect to the closest-clockwise virtual node
        const kAngle = posToAngle(keyInfo.position);
        const kp     = angleToXY(kAngle, RING_R);

        // primary node (#0) as anchor for line
        const primary = server.find(n => n.label.endsWith('#0')) || server[0];
        const sAngle = posToAngle(primary.position);
        const sp     = angleToXY(sAngle, RING_R);

        ctx.beginPath();
        ctx.moveTo(kp.x, kp.y);
        ctx.lineTo(sp.x, sp.y);
        ctx.strokeStyle = color + '55';
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // 4. Virtual node tick marks (small radial lines at each vnode position)
    for (const [name, nodes] of Object.entries(state.servers)) {
        const color = getServerColor(name);
        for (const node of nodes) {
            if (node.label.endsWith('#0')) continue; // primary drawn separately
            const angle = posToAngle(node.position);
            const inner = angleToXY(angle, RING_R - 5);
            const outer = angleToXY(angle, RING_R + 5);
            ctx.beginPath();
            ctx.moveTo(inner.x, inner.y);
            ctx.lineTo(outer.x, outer.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }
    }

    // 5. Server virtual nodes (small filled circles)
    for (const [name, nodes] of Object.entries(state.servers)) {
        const color = getServerColor(name);
        for (const node of nodes) {
            if (node.label.endsWith('#0')) continue; // primary drawn after
            const angle = posToAngle(node.position);
            const p = angleToXY(angle, RING_R);

            ctx.beginPath();
            ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#FFF';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Small label outside ring
            const lp = angleToXY(angle, RING_R + 22);
            ctx.fillStyle = '#4A5568';
            ctx.font = '8px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const idx = node.label.split('#')[1];
            ctx.fillText('v' + idx, lp.x, lp.y);
        }
    }

    // 6. Primary server nodes (large circles) — drawn on top of virtual nodes
    for (const [name, nodes] of Object.entries(state.servers)) {
        const color = getServerColor(name);
        const primary = nodes.find(n => n.label.endsWith('#0')) || nodes[0];
        if (!primary) continue;
        const angle = posToAngle(primary.position);
        const p = angleToXY(angle, RING_R);

        // glow
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, 2 * Math.PI);
        const grad = ctx.createRadialGradient(p.x, p.y, 5, p.x, p.y, 16);
        grad.addColorStop(0, color + '40');
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // circle
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#FFF';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // server name label outside ring
        const lp = angleToXY(angle, RING_R + 34);
        ctx.fillStyle = color;
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, lp.x, lp.y);
    }

    // 7. Keys (diamonds on ring)
    for (const keyInfo of state.keys) {
        const color = getServerColor(keyInfo.server) || '#718096';
        const angle = posToAngle(keyInfo.position);
        const p = angleToXY(angle, RING_R);
        drawDiamond(ctx, p.x, p.y, 10, color);

        // Key label inside the ring
        const lp = angleToXY(angle, RING_R - 22);
        ctx.fillStyle = '#4A5568';
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(keyInfo.key, lp.x, lp.y);
    }

    // 8. Animated migrating keys (travel just outside ring)
    for (const anim of animations) {
        const elapsed = t - anim.startTime;
        if (elapsed >= anim.duration) continue;

        const progress = easeInOut(elapsed / anim.duration);

        // Arc-interpolate: choose shorter arc direction
        let delta = anim.endAngle - anim.startAngle;
        if (delta >  Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;

        const currentAngle = anim.startAngle + delta * progress;
        const p = angleToXY(currentAngle, RING_R + 20);

        // Trail
        for (let trail = 1; trail <= 3; trail++) {
            const trailProgress = Math.max(0, progress - trail * 0.08);
            const trailAngle    = anim.startAngle + delta * easeInOut(trailProgress);
            const tp            = angleToXY(trailAngle, RING_R + 20);
            drawDiamond(ctx, tp.x, tp.y, 6 - trail, anim.color, 0.3 / trail);
        }

        // Main animated diamond
        drawDiamond(ctx, p.x, p.y, 11, anim.color);

        // Pulsing ring around it
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14 + 4 * Math.sin(elapsed / 100), 0, 2 * Math.PI);
        ctx.strokeStyle = anim.color + '66';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Label
        ctx.fillStyle = anim.color;
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(anim.key, p.x, p.y - 18);
    }

    // Center info
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const serverCount = Object.keys(state.servers).length;
    const keyCount    = state.keys.length;
    ctx.fillStyle = '#CBD5E0';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${serverCount} server${serverCount !== 1 ? 's' : ''} · ${keyCount} key${keyCount !== 1 ? 's' : ''}`, CX, CY);
}

// ------------------------------------------------------------------ //
//  Animation engine
// ------------------------------------------------------------------ //

function startMigrationAnimations(movedKeys, oldState) {
    for (const move of movedKeys) {
        if (!move.fromServer || !move.toServer) continue;

        const fromNodes = oldState.servers[move.fromServer];
        const toNodes   = appState.servers[move.toServer];
        if (!fromNodes || !toNodes) continue;

        const fromPrimary = fromNodes.find(n => n.label.endsWith('#0')) || fromNodes[0];
        const toPrimary   = toNodes.find(n => n.label.endsWith('#0'))   || toNodes[0];
        if (!fromPrimary || !toPrimary) continue;

        activeAnimations.push({
            key:        move.key,
            startAngle: posToAngle(fromPrimary.position),
            endAngle:   posToAngle(toPrimary.position),
            startTime:  now(),
            duration:   700,
            color:      getServerColor(move.toServer),
        });
    }

    if (animFrameId === null && activeAnimations.length > 0) {
        animFrameId = requestAnimationFrame(animLoop);
    }
}

function animLoop() {
    const t = now();
    activeAnimations = activeAnimations.filter(a => t - a.startTime < a.duration);
    drawRing(appState, activeAnimations);
    if (activeAnimations.length > 0) {
        animFrameId = requestAnimationFrame(animLoop);
    } else {
        animFrameId = null;
        drawRing(appState, []);
    }
}

// ------------------------------------------------------------------ //
//  API helpers
// ------------------------------------------------------------------ //

async function fetchState() {
    const res  = await fetch(`${API_BASE}/api/state`);
    const data = await res.json();
    applyState(data);
}

function applyState(data) {
    // Preserve and extend color assignments
    for (const name of Object.keys(data.servers || {})) {
        getServerColor(name);   // side-effect: assigns color if not yet assigned
    }
    appState.servers = data.servers || {};
    appState.keys    = data.keys    || [];
    syncControlPanel();
    if (animFrameId === null) drawRing(appState, []);
}

function setLoading(busy) {
    ['add-server-btn', 'remove-server-btn', 'add-key-btn', 'remove-key-btn']
        .forEach(id => document.getElementById(id).disabled = busy);
}

// ------------------------------------------------------------------ //
//  Event handlers
// ------------------------------------------------------------------ //

async function handleAddServer() {
    const name = document.getElementById('server-name-input').value.trim();
    const vn   = parseInt(document.getElementById('vn-slider').value, 10);
    if (!name) { addLogEntry('Please enter a server name.'); return; }

    setLoading(true);
    try {
        const oldState = deepClone(appState);
        const res      = await fetch(`${API_BASE}/api/server`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name, virtualNodes: vn })
        });
        const result = await res.json();
        await fetchState();

        const moved = result.movedKeys || [];
        if (moved.length > 0) startMigrationAnimations(moved, oldState);
        updateExplanation('add_server', { name, virtualNodes: vn, movedKeys: moved, oldState, newState: appState });
        addLogEntry([
            'Added ', {b: name},
            ` (${vn} virtual node${vn > 1 ? 's' : ''}) — ${moved.length} key${moved.length !== 1 ? 's' : ''} migrated`
        ]);
        document.getElementById('server-name-input').value = '';
    } catch (e) {
        addLogEntry(`Error: ${e.message}`);
    } finally {
        setLoading(false);
    }
}

async function handleRemoveServer() {
    const name = document.getElementById('server-remove-select').value;
    if (!name) { addLogEntry('Select a server to remove.'); return; }

    setLoading(true);
    try {
        const oldState = deepClone(appState);
        const res      = await fetch(`${API_BASE}/api/server`, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name })
        });
        const result = await res.json();
        await fetchState();

        const moved = result.movedKeys || [];
        if (moved.length > 0) startMigrationAnimations(moved, oldState);
        updateExplanation('remove_server', { name, movedKeys: moved, oldState, newState: appState });
        addLogEntry(['Removed ', {b: name}, ` — ${moved.length} key${moved.length !== 1 ? 's' : ''} migrated`]);
    } catch (e) {
        addLogEntry(`Error: ${e.message}`);
    } finally {
        setLoading(false);
    }
}

async function handleAddKey() {
    const key   = document.getElementById('key-input').value.trim();
    const value = document.getElementById('value-input').value.trim();
    if (!key) { addLogEntry('Please enter a key.'); return; }

    setLoading(true);
    try {
        const res    = await fetch(`${API_BASE}/api/key`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ key, value })
        });
        const result = await res.json();
        if (result.error) { addLogEntry(`Error: ${result.error}`); return; }
        await fetchState();
        updateExplanation('add_key', { key, value, position: result.position, server: result.server, newState: appState });
        addLogEntry([
            'Added key ', {b: key},
            ...(value ? [' = "', value, '"'] : []),
            ' → ', {b: result.server},
            ` (pos ${result.position})`
        ]);
        document.getElementById('key-input').value   = '';
        document.getElementById('value-input').value = '';
    } catch (e) {
        addLogEntry(`Error: ${e.message}`);
    } finally {
        setLoading(false);
    }
}

async function handleRemoveKey() {
    const key = document.getElementById('key-remove-select').value;
    if (!key) { addLogEntry('Select a key to remove.'); return; }

    const oldKeyInfo = appState.keys.find(k => k.key === key);

    setLoading(true);
    try {
        await fetch(`${API_BASE}/api/key`, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ key })
        });
        await fetchState();
        updateExplanation('remove_key', { key, oldKeyInfo });
        addLogEntry(['Removed key ', {b: key}]);
    } catch (e) {
        addLogEntry(`Error: ${e.message}`);
    } finally {
        setLoading(false);
    }
}

// ------------------------------------------------------------------ //
//  Explanation panel
// ------------------------------------------------------------------ //

function expHeading(parent, text) {
    const el = document.createElement('div');
    el.className = 'exp-heading';
    el.textContent = text;
    parent.appendChild(el);
}

function expSub(parent, text) {
    const el = document.createElement('div');
    el.className = 'exp-subheading';
    el.textContent = text;
    parent.appendChild(el);
}

function expPara(parent, ...parts) {
    // parts: strings or {code:'...'} or {pos: number} objects
    const p = document.createElement('p');
    p.className = 'exp-para';
    for (const part of parts) {
        if (typeof part === 'string') {
            p.appendChild(document.createTextNode(part));
        } else if (part.code != null) {
            const s = document.createElement('span');
            s.className = 'exp-code';
            s.textContent = part.code;
            p.appendChild(s);
        } else if (part.pos != null) {
            const s = document.createElement('span');
            s.className = 'exp-pos';
            s.textContent = part.pos;
            p.appendChild(s);
        } else if (part.arrow != null) {
            const s = document.createElement('span');
            s.className = 'exp-arrow';
            s.textContent = part.arrow;
            p.appendChild(s);
        }
    }
    parent.appendChild(p);
}

function expMigrateItem(parent, keyName, fromServer, toServer, keyPos, owningNode) {
    const div = document.createElement('div');
    div.className = 'exp-migrate-item';

    const main = document.createElement('div');
    main.appendChild(document.createTextNode('"' + keyName + '" '));
    const posSpan = document.createElement('span');
    posSpan.className = 'exp-pos';
    posSpan.textContent = 'pos ' + keyPos;
    main.appendChild(posSpan);
    if (fromServer) {
        main.appendChild(document.createTextNode('  ' + fromServer + ' '));
        const arr = document.createElement('span');
        arr.className = 'exp-arrow';
        arr.textContent = '→';
        main.appendChild(arr);
        main.appendChild(document.createTextNode(' ' + toServer));
    } else {
        main.appendChild(document.createTextNode(' → ' + toServer));
    }
    div.appendChild(main);

    if (owningNode) {
        const sub = document.createElement('div');
        sub.className = 'exp-migrate-sub';
        const wrapped = owningNode.position < keyPos;
        sub.textContent = `Next clockwise node: ${owningNode.label} at pos ${owningNode.position}${wrapped ? '  (wrapped past 3600 → 0)' : ''}`;
        div.appendChild(sub);
    }
    parent.appendChild(div);
}

function updateExplanation(type, data) {
    const box = document.getElementById('detail-content');
    box.textContent = '';

    if (type === 'add_server') {
        const { name, virtualNodes, movedKeys, newState } = data;

        expHeading(box, `Added server "${name}" with ${virtualNodes} virtual node${virtualNodes > 1 ? 's' : ''}`);

        // Position selection
        expSub(box, '1. How server positions are chosen');
        expPara(box, 'Each virtual node is hashed independently using FNV-1a:');
        expPara(box, { code: 'position = FNV-1a("name#index") mod 3600' });

        for (let i = 0; i < virtualNodes; i++) {
            const label = `${name}#${i}`;
            const pos   = fnv1a(label);
            const deg   = (pos / RING_SIZE * 360).toFixed(1);
            expPara(box,
                { code: `"${label}"` }, ` → hash = `,
                { pos: pos }, ` (≈ ${deg}° on ring)`
            );
        }

        // Routing rule reminder
        expSub(box, '2. Key routing rule');
        expPara(box, 'A key at position P routes to the ', { arrow: 'first server node found scanning clockwise' }, ' from P (wraps at 3600 → 0).');

        // Migrations
        expSub(box, `3. Keys migrated to "${name}": ${movedKeys.length}`);
        if (movedKeys.length === 0) {
            expPara(box, 'No existing keys fell between an existing node and one of the new nodes — nothing moved.');
        } else {
            expPara(box, 'A key moves when a new node appears before its old server when scanning clockwise:');
            for (const m of movedKeys) {
                const owningNode = findOwningNode(m.position, newState.servers);
                expMigrateItem(box, m.key, m.fromServer, name, m.position, owningNode);
            }
        }

    } else if (type === 'remove_server') {
        const { name, movedKeys, oldState, newState } = data;

        expHeading(box, `Removed server "${name}"`);

        // Which nodes were removed
        const removedNodes = oldState.servers[name] || [];
        expSub(box, `1. Nodes removed from ring (${removedNodes.length})`);
        for (const n of removedNodes) {
            expPara(box, { code: n.label }, '  at position ', { pos: n.position });
        }

        // Migration rule
        expSub(box, '2. Migration rule');
        expPara(box, 'Each key owned by the removed server rescans clockwise for the ', { arrow: 'next remaining node' }, '. Only those keys are affected — all other keys stay put.');

        // Individual migrations
        expSub(box, `3. Keys migrated: ${movedKeys.length}`);
        if (movedKeys.length === 0) {
            expPara(box, 'No keys were owned by this server.');
        } else {
            for (const m of movedKeys) {
                const owningNode = findOwningNode(m.position, newState.servers);
                expMigrateItem(box, m.key, name, m.toServer, m.position, owningNode);
            }
        }

    } else if (type === 'add_key') {
        const { key, value, position, server, newState } = data;

        expHeading(box, `Added key "${key}"`);

        expSub(box, '1. Position calculation');
        expPara(box,
            { code: `FNV-1a("${key}") mod 3600` }, ' = ',
            { pos: position }, ` (≈ ${(position / RING_SIZE * 360).toFixed(1)}° on ring)`
        );

        expSub(box, '2. Routing decision');
        expPara(box, 'Scan clockwise from position ', { pos: position }, '...');

        const owningNode = findOwningNode(position, newState.servers);
        if (owningNode) {
            const wrapped = owningNode.position < position;
            expPara(box,
                'First node found: ', { code: owningNode.label },
                ' at ', { pos: owningNode.position },
                wrapped ? '  (wrapped past 3600 → 0)' : ''
            );
            expPara(box, { arrow: `→ Assigned to server "${server}"` });
        } else {
            expPara(box, 'No servers in ring — add a server first.');
        }

        if (value) {
            expSub(box, '3. Stored value');
            expPara(box, { code: `"${key}"` }, ' = ', { code: `"${value}"` });
        }

    } else if (type === 'remove_key') {
        const { key, oldKeyInfo } = data;

        expHeading(box, `Removed key "${key}"`);
        if (oldKeyInfo) {
            expSub(box, 'Key details');
            expPara(box, 'Position: ', { pos: oldKeyInfo.position },
                ` (≈ ${(oldKeyInfo.position / RING_SIZE * 360).toFixed(1)}°)`);
            expPara(box, `Was owned by server "${oldKeyInfo.server}".`);
            expPara(box, 'Removing a key never triggers migration — only server removals do.');
        }
    }
}

// ------------------------------------------------------------------ //
//  Bootstrap
// ------------------------------------------------------------------ //

document.addEventListener('DOMContentLoaded', () => {
    // Virtual node slider label
    const slider  = document.getElementById('vn-slider');
    const vnCount = document.getElementById('vn-count');
    slider.addEventListener('input', () => { vnCount.textContent = slider.value; });

    // Button clicks
    document.getElementById('add-server-btn')   .addEventListener('click', handleAddServer);
    document.getElementById('remove-server-btn') .addEventListener('click', handleRemoveServer);
    document.getElementById('add-key-btn')       .addEventListener('click', handleAddKey);
    document.getElementById('remove-key-btn')    .addEventListener('click', handleRemoveKey);

    // Enter key on inputs
    document.getElementById('server-name-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleAddServer();
    });
    document.getElementById('value-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleAddKey();
    });

    // Initial draw (empty ring)
    drawRing(appState, []);
    syncControlPanel();

    // Fetch initial state from backend
    fetchState().catch(() => {
        addLogEntry('Could not connect to backend. Start the Java server: cd backend && ./run.sh');
    });
});
