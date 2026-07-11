import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;

public class ConsistentHashDemo {

    private static final ConsistentHashRing ring = new ConsistentHashRing();
    private static final int PORT = 8080;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.createContext("/api/state",  new StateHandler());
        server.createContext("/api/server", new ServerHandler());
        server.createContext("/api/key",    new KeyHandler());
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("Consistent Hashing Demo running at http://localhost:" + PORT);
        System.out.println("Open frontend/index.html in your browser to start.");
    }

    // ------------------------------------------------------------------ //
    //  Shared utilities
    // ------------------------------------------------------------------ //

    static void addCorsHeaders(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        ex.getResponseHeaders().set("Content-Type", "application/json");
    }

    static String readBody(HttpExchange ex) throws IOException {
        return new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    static void sendJson(HttpExchange ex, int code, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.sendResponseHeaders(code, bytes.length);
        try (var out = ex.getResponseBody()) {
            out.write(bytes);
        }
    }

    // Generic recursive JSON serializer (handles Map, List, String, Number, Boolean, null)
    static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof Boolean) return obj.toString();
        if (obj instanceof Number) return obj.toString();
        if (obj instanceof String) {
            String s = (String) obj;
            s = s.replace("\\", "\\\\")
                 .replace("\"", "\\\"")
                 .replace("\n", "\\n")
                 .replace("\r", "\\r")
                 .replace("\t", "\\t");
            return "\"" + s + "\"";
        }
        if (obj instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<Object, Object> map = (Map<Object, Object>) obj;
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<Object, Object> e : map.entrySet()) {
                if (!first) sb.append(",");
                sb.append(toJson(e.getKey().toString())).append(":").append(toJson(e.getValue()));
                first = false;
            }
            return sb.append("}").toString();
        }
        if (obj instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) obj;
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : list) {
                if (!first) sb.append(",");
                sb.append(toJson(item));
                first = false;
            }
            return sb.append("]").toString();
        }
        return "\"" + obj + "\"";
    }

    // Minimal flat-object JSON parser: {"key":"val","num":3}
    // Returns Map<String, String> — all values as strings; caller parses numbers
    static Map<String, String> parseJsonObject(String json) {
        Map<String, String> result = new LinkedHashMap<>();
        if (json == null || json.isBlank()) return result;
        json = json.trim();
        if (json.startsWith("{")) json = json.substring(1);
        if (json.endsWith("}"))  json = json.substring(0, json.length() - 1);

        // Split on commas that are not inside quotes (simple heuristic for flat objects)
        int i = 0;
        while (i < json.length()) {
            // Skip whitespace
            while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
            if (i >= json.length()) break;

            // Read key (quoted)
            if (json.charAt(i) != '"') { i++; continue; }
            int keyStart = i + 1;
            i = json.indexOf('"', keyStart);
            if (i < 0) break;
            String key = json.substring(keyStart, i);
            i++; // skip closing quote

            // Skip : and whitespace
            while (i < json.length() && (json.charAt(i) == ':' || Character.isWhitespace(json.charAt(i)))) i++;
            if (i >= json.length()) break;

            // Read value: quoted string or unquoted token
            String value;
            if (json.charAt(i) == '"') {
                int valStart = i + 1;
                // find closing quote, skip escaped
                int j = valStart;
                while (j < json.length()) {
                    if (json.charAt(j) == '\\') { j += 2; continue; }
                    if (json.charAt(j) == '"') break;
                    j++;
                }
                value = json.substring(valStart, j);
                i = j + 1;
            } else {
                // unquoted (number, boolean, null)
                int valStart = i;
                while (i < json.length() && json.charAt(i) != ',' && json.charAt(i) != '}') i++;
                value = json.substring(valStart, i).trim();
            }
            result.put(key, value);

            // Skip comma
            while (i < json.length() && (json.charAt(i) == ',' || Character.isWhitespace(json.charAt(i)))) i++;
        }
        return result;
    }

    // ------------------------------------------------------------------ //
    //  Handlers
    // ------------------------------------------------------------------ //

    static class StateHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCorsHeaders(ex);
            if ("OPTIONS".equals(ex.getRequestMethod())) { sendJson(ex, 204, ""); return; }
            sendJson(ex, 200, toJson(ring.getState()));
        }
    }

    static class ServerHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCorsHeaders(ex);
            String method = ex.getRequestMethod();

            if ("OPTIONS".equals(method)) { sendJson(ex, 204, ""); return; }

            Map<String, String> body = parseJsonObject(readBody(ex));

            if ("POST".equals(method)) {
                String name = body.get("name");
                if (name == null || name.isBlank()) {
                    sendJson(ex, 400, "{\"error\":\"name required\"}"); return;
                }
                int vn = 1;
                try { vn = Math.max(1, Math.min(10, Integer.parseInt(body.getOrDefault("virtualNodes", "1")))); }
                catch (NumberFormatException ignored) {}

                List<Map<String, Object>> moves = ring.addServer(name, vn);
                Map<String, Object> resp = new LinkedHashMap<>();
                resp.put("movedKeys", moves);
                sendJson(ex, 200, toJson(resp));

            } else if ("DELETE".equals(method)) {
                String name = body.get("name");
                if (name == null || name.isBlank()) {
                    sendJson(ex, 400, "{\"error\":\"name required\"}"); return;
                }
                List<Map<String, Object>> moves = ring.removeServer(name);
                Map<String, Object> resp = new LinkedHashMap<>();
                resp.put("movedKeys", moves);
                sendJson(ex, 200, toJson(resp));

            } else {
                sendJson(ex, 405, "{\"error\":\"method not allowed\"}");
            }
        }
    }

    static class KeyHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCorsHeaders(ex);
            String method = ex.getRequestMethod();

            if ("OPTIONS".equals(method)) { sendJson(ex, 204, ""); return; }

            Map<String, String> body = parseJsonObject(readBody(ex));

            if ("POST".equals(method)) {
                String key   = body.get("key");
                String value = body.getOrDefault("value", "");
                if (key == null || key.isBlank()) {
                    sendJson(ex, 400, "{\"error\":\"key required\"}"); return;
                }
                Map<String, Object> result = ring.addKey(key, value);
                if (result == null) {
                    sendJson(ex, 400, "{\"error\":\"No servers in ring\"}"); return;
                }
                sendJson(ex, 200, toJson(result));

            } else if ("DELETE".equals(method)) {
                String key = body.get("key");
                if (key != null) ring.removeKey(key);
                sendJson(ex, 200, "{}");

            } else {
                sendJson(ex, 405, "{\"error\":\"method not allowed\"}");
            }
        }
    }
}
