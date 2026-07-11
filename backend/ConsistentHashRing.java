import java.nio.charset.StandardCharsets;
import java.util.*;

public class ConsistentHashRing {

    public static final int RING_SIZE = 3600;

    // position (0–3599) → "serverName#vIndex"
    private final TreeMap<Integer, String> ring = new TreeMap<>();
    // serverName → set of ring positions it occupies
    private final Map<String, Set<Integer>> serverNodes = new LinkedHashMap<>();
    // key → hash position
    private final Map<String, Integer> keyPositions = new LinkedHashMap<>();
    // key → value
    private final Map<String, String> keyValues = new LinkedHashMap<>();
    // key → owning serverName (cached)
    private final Map<String, String> keyOwners = new LinkedHashMap<>();

    // FNV-1a 32-bit hash → [0, RING_SIZE)
    public static int hash(String input) {
        long h = 2166136261L;
        for (byte b : input.getBytes(StandardCharsets.UTF_8)) {
            h ^= (b & 0xFF);
            h = (h * 16777619L) & 0xFFFFFFFFL;
        }
        return (int)(h % RING_SIZE);
    }

    // --- Server management ---

    public synchronized List<Map<String, Object>> addServer(String name, int virtualNodes) {
        if (serverNodes.containsKey(name)) {
            removeServer(name);
        }

        // Before inserting the new nodes, find which servers currently own the
        // clockwise-successor positions. Only keys owned by those servers can
        // possibly be captured by the new server — all other keys are unaffected.
        Set<String> affectedServers = new HashSet<>();
        int[] positions = new int[virtualNodes];
        for (int i = 0; i < virtualNodes; i++) {
            positions[i] = hash(name + "#" + i);
            Map.Entry<Integer, String> succ = ring.ceilingEntry(positions[i]);
            if (succ == null) succ = ring.firstEntry();
            if (succ != null) {
                String succServer = succ.getValue().substring(0, succ.getValue().lastIndexOf('#'));
                affectedServers.add(succServer);
            }
        }

        // Insert the new virtual nodes
        serverNodes.put(name, new LinkedHashSet<>());
        for (int i = 0; i < virtualNodes; i++) {
            ring.put(positions[i], name + "#" + i);
            serverNodes.get(name).add(positions[i]);
        }

        // Only check keys owned by the affected servers
        return reassignKeys(affectedServers);
    }

    public synchronized List<Map<String, Object>> removeServer(String name) {
        Set<Integer> positions = serverNodes.remove(name);
        if (positions != null) {
            for (int pos : positions) {
                ring.remove(pos);
            }
        }

        // Only keys currently owned by the removed server need reassignment.
        // Every other key's clockwise successor is unchanged.
        return reassignKeys(Collections.singleton(name));
    }

    // Reassigns only the keys currently owned by one of the given servers.
    // Entry.setValue() during iteration is safe — it mutates the value without
    // structurally modifying the map.
    private List<Map<String, Object>> reassignKeys(Set<String> fromServers) {
        List<Map<String, Object>> moves = new ArrayList<>();
        for (Map.Entry<String, String> ownerEntry : keyOwners.entrySet()) {
            if (!fromServers.contains(ownerEntry.getValue())) continue;
            String key      = ownerEntry.getKey();
            int    pos      = keyPositions.get(key);
            String newOwner = getOwnerAt(pos);
            if (newOwner != null && !newOwner.equals(ownerEntry.getValue())) {
                Map<String, Object> move = new LinkedHashMap<>();
                move.put("key",        key);
                move.put("fromServer", ownerEntry.getValue());
                move.put("toServer",   newOwner);
                move.put("position",   pos);
                moves.add(move);
                ownerEntry.setValue(newOwner);
            }
        }
        return moves;
    }

    // --- Key management ---

    public synchronized Map<String, Object> addKey(String key, String value) {
        if (ring.isEmpty()) return null; // no servers
        int pos = hash(key);
        String owner = getOwnerAt(pos);
        keyPositions.put(key, pos);
        keyValues.put(key, value);
        keyOwners.put(key, owner);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("server", owner);
        result.put("position", pos);
        return result;
    }

    public synchronized void removeKey(String key) {
        keyPositions.remove(key);
        keyValues.remove(key);
        keyOwners.remove(key);
    }

    // --- Ownership lookup ---

    private String getOwnerAt(int position) {
        if (ring.isEmpty()) return null;
        Map.Entry<Integer, String> entry = ring.ceilingEntry(position);
        if (entry == null) entry = ring.firstEntry(); // wrap around
        // Extract server name: "serverName#vIndex" → split on "#"
        String nodeId = entry.getValue();
        return nodeId.substring(0, nodeId.lastIndexOf('#'));
    }

    // --- State snapshot (returns Map<String,Object> for JSON serialization) ---

    public synchronized Map<String, Object> getState() {
        // servers: { "S1": [{position, label}, ...], ... }
        Map<String, Object> servers = new LinkedHashMap<>();
        for (Map.Entry<String, Set<Integer>> entry : serverNodes.entrySet()) {
            String name = entry.getKey();
            List<Map<String, Object>> nodes = new ArrayList<>();
            for (int pos : entry.getValue()) {
                // find the label stored in the ring
                String label = ring.getOrDefault(pos, name + "#?");
                Map<String, Object> node = new LinkedHashMap<>();
                node.put("position", pos);
                node.put("label", label);
                nodes.add(node);
            }
            servers.put(name, nodes);
        }

        // keys: [{key, value, position, server}, ...]
        List<Map<String, Object>> keys = new ArrayList<>();
        for (String key : keyPositions.keySet()) {
            Map<String, Object> k = new LinkedHashMap<>();
            k.put("key", key);
            k.put("value", keyValues.getOrDefault(key, ""));
            k.put("position", keyPositions.get(key));
            k.put("server", keyOwners.getOrDefault(key, ""));
            keys.add(k);
        }

        Map<String, Object> state = new LinkedHashMap<>();
        state.put("servers", servers);
        state.put("keys", keys);
        return state;
    }

    public synchronized Set<String> getServerNames() {
        return new LinkedHashSet<>(serverNodes.keySet());
    }

    public synchronized Set<String> getKeyNames() {
        return new LinkedHashSet<>(keyPositions.keySet());
    }
}
