package com.qsp.qgen;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/**
 * 极小的本机 MCP HTTP 端点。
 *
 * 只监听 127.0.0.1；HTTP/JSON-RPC 的解析在这里完成，真正的 QSP 操作交给
 * WebView 里的 QGenMcp（和编辑器共用 qsp.js / records.js）。
 */
public class McpHttpServer {

    public static final String PROTOCOL = "2024-11-05";
    private static final int MAX_BODY = 8 * 1024 * 1024;
    private static final int PREFERRED_PORT = 8790;

    /** 宿主：负责把 JSON-RPC 原文交给页面并同步返回结果。 */
    public interface Host {
        boolean ready();
        String rpc(String raw);
    }

    private static final Logger LOG = Logger.getLogger("QGenMcp");
    private final Host host;
    private final AtomicLong seq = new AtomicLong();
    private volatile ServerSocket server;
    private volatile boolean running;
    private volatile int port;
    private Thread thread;

    public McpHttpServer(Host host) {
        this.host = host;
    }

    public synchronized void start() {
        if (running) return;
        ServerSocket ss = null;
        int bound = 0;
        for (int p = PREFERRED_PORT; p < PREFERRED_PORT + 10; p++) {
            try {
                ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 16);
                bound = p;
                break;
            } catch (Exception e) {
                if (ss != null) { try { ss.close(); } catch (Exception ignored) { } }
                ss = null;
            }
        }
        if (ss == null) {
            LOG.warning("no loopback port available");
            return;
        }
        server = ss;
        port = bound;
        running = true;
        thread = new Thread(new Runnable() {
            @Override public void run() { loop(); }
        }, "qgen-mcp-http");
        thread.setDaemon(true);
        thread.start();
        LOG.info("listening on 127.0.0.1:" + bound);
    }

    public synchronized void stop() {
        running = false;
        if (server != null) {
            try { server.close(); } catch (Exception ignored) { }
            server = null;
        }
        thread = null;
    }

    public boolean isRunning() { return running; }
    public int getPort() { return port; }

    public String infoJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("name", "qgen-mcp");
            o.put("version", "1.4.0");
            o.put("transport", "streamable-http");
            o.put("endpoint", "/mcp");
            o.put("protocol", PROTOCOL);
            o.put("port", port);
            o.put("running", running);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    private void loop() {
        while (running) {
            Socket s = null;
            try {
                s = server.accept();
                final Socket sock = s;
                Thread t = new Thread(new Runnable() {
                    @Override public void run() { handle(sock); }
                }, "qgen-mcp-conn");
                t.setDaemon(true);
                t.start();
            } catch (Exception e) {
                if (running) LOG.warning("accept: " + e.getMessage());
                if (s != null) { try { s.close(); } catch (Exception ignored) { } }
            }
        }
    }

    private void handle(Socket sock) {
        try {
            sock.setSoTimeout(60000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = new BufferedOutputStream(sock.getOutputStream());
            String reqLine = readLine(in);
            if (reqLine == null || reqLine.length() == 0) { sock.close(); return; }
            String[] parts = reqLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";

            Map<String, String> headers = new HashMap<String, String>();
            String line;
            int guard = 0;
            while ((line = readLine(in)) != null && line.length() > 0 && guard++ < 100) {
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.US), line.substring(c + 1).trim());
            }
            int len = 0;
            try { len = Integer.parseInt(headers.containsKey("content-length") ? headers.get("content-length") : "0"); }
            catch (Exception ignored) { }
            if (len < 0 || len > MAX_BODY) {
                write(out, 413, "{\"error\":\"body too large\"}", null);
                sock.close();
                return;
            }
            byte[] body = new byte[len];
            int off = 0;
            while (off < len) {
                int n = in.read(body, off, len - off);
                if (n < 0) break;
                off += n;
            }

            if ("OPTIONS".equalsIgnoreCase(method)) {
                write(out, 204, "", headers);
            } else if ("GET".equalsIgnoreCase(method) && ("/".equals(path) || "/health".equals(path))) {
                write(out, 200, infoJson(), headers);
            } else if ("GET".equalsIgnoreCase(method) && path.startsWith("/mcp")) {
                write(out, 405, "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"Use POST /mcp\"},\"id\":null}", headers);
            } else if ("POST".equalsIgnoreCase(method) && path.startsWith("/mcp")) {
                String raw = new String(body, StandardCharsets.UTF_8);
                String resp = host.ready() ? host.rpc(raw) : errorResponse(null, -32002, "QGen 页面尚未就绪，请稍后重试");
                if (resp == null || resp.length() == 0) {
                    write(out, 202, "", headers);
                } else {
                    write(out, 200, resp, headers);
                }
            } else if ("DELETE".equalsIgnoreCase(method) && path.startsWith("/mcp")) {
                write(out, 204, "", headers);
            } else {
                write(out, 404, "{\"error\":\"not found\"}", headers);
            }
            out.flush();
            sock.close();
        } catch (Exception e) {
            try { sock.close(); } catch (Exception ignored) { }
        }
    }

    private String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bo.write(c);
            if (bo.size() > 8192) break;
        }
        if (c < 0 && bo.size() == 0) return null;
        return new String(bo.toByteArray(), StandardCharsets.US_ASCII);
    }

    private void write(OutputStream out, int code, String body, Map<String, String> req) throws Exception {
        byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(code == 200 ? " OK" : code == 202 ? " Accepted" : code == 204 ? " No Content" : code == 404 ? " Not Found" : code == 405 ? " Method Not Allowed" : code == 413 ? " Payload Too Large" : " Error").append("\r\n");
        h.append("Content-Type: application/json; charset=utf-8\r\n");
        h.append("Content-Length: ").append(b.length).append("\r\n");
        h.append("Connection: close\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n");
        h.append("Access-Control-Allow-Headers: Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID\r\n");
        h.append("Access-Control-Expose-Headers: Mcp-Session-Id, MCP-Protocol-Version\r\n");
        h.append("Mcp-Session-Id: qgen-local\r\n");
        h.append("MCP-Protocol-Version: ").append(PROTOCOL).append("\r\n");
        h.append("\r\n");
        out.write(h.toString().getBytes(StandardCharsets.US_ASCII));
        if (b.length > 0) out.write(b);
    }

    public static String errorResponse(Object id, int code, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("jsonrpc", "2.0");
            o.put("id", id == null ? JSONObject.NULL : id);
            JSONObject e = new JSONObject();
            e.put("code", code);
            e.put("message", message);
            o.put("error", e);
            return o.toString();
        } catch (Exception ex) {
            return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"internal error\"}}";
        }
    }
}
