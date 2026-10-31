package com.craftagents.companion;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Exact v1 scoped HTTPS facade. No RPC, cookies, redirects, custom trust, or mutation retries. */
final class Api {
    final String origin;
    private final String token;
    Api(String origin, String token) { this.origin = Policy.origin(origin); this.token = token; }
    static final class Failure extends Exception {
        final int status;
        final String code;
        Failure(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }
    JSONObject request(String method, String path, JSONObject body) throws Exception {
        HttpsURLConnection c = (HttpsURLConnection) new URL(origin + "/api/companion/v1" + path).openConnection();
        try {
            c.setInstanceFollowRedirects(false); c.setRequestMethod(method);
            c.setConnectTimeout(12000); c.setReadTimeout(20000); c.setUseCaches(false);
            c.setRequestProperty("Accept", "application/json");
            if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setRequestProperty("Content-Type", "application/json");
                c.setDoOutput(true); c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int status = c.getResponseCode();
            if (status >= 300 && status < 400) throw new Failure(status, "redirect", "Server redirect refused. Use its final HTTPS origin.");
            InputStream input = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (input == null) throw new Failure(status, "empty_response", "Server returned no response.");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = input) {
                byte[] chunk = new byte[8192]; int n;
                while ((n = in.read(chunk)) != -1) {
                    if (bytes.size() + n > 2 * 1024 * 1024) throw new Failure(status, "too_large", "Response exceeds the mobile safety limit.");
                    bytes.write(chunk, 0, n);
                }
            }
            JSONObject response;
            try { response = new JSONObject(bytes.toString("UTF-8")); }
            catch (Exception e) { throw new Failure(status, "invalid_response", "Not a companion API response. Check server support."); }
            if (status >= 400 || !response.optBoolean("ok")) {
                JSONObject error = response.optJSONObject("error");
                throw new Failure(status, error == null ? "server_error" : error.optString("code"),
                    error == null ? "Server request failed." : error.optString("message", "Server request failed."));
            }
            return response.getJSONObject("data");
        } finally { c.disconnect(); }
    }
}
