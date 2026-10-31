package com.craftagents.companion;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** In-memory HTTPS connection fixture: no port or actual network is opened. */
public final class ApiTest {
    private static Fake next, last;
    private static int opened, checks;
    static class Fake extends HttpsURLConnection {
        int status;
        String response;
        boolean disconnected;
        ByteArrayOutputStream sent = new ByteArrayOutputStream();
        Fake(int status, String response) throws Exception { super(new URL("https://fixture.invalid")); this.status=status; this.response=response; }
        public String getCipherSuite() { return "fixture"; }
        public Certificate[] getLocalCertificates() { return null; }
        public Certificate[] getServerCertificates() { return null; }
        public void disconnect() { disconnected = true; }
        public boolean usingProxy() { return false; }
        public void connect() { }
        public OutputStream getOutputStream() { return sent; }
        public int getResponseCode() { return status; }
        public InputStream getInputStream() { return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8)); }
        public InputStream getErrorStream() { return getInputStream(); }
        int fixedLength() { return fixedContentLength; }
    }
    private static void check(boolean test) { checks++; if(!test) throw new AssertionError("Assertion " + checks); }
    private static void fixture(int status, String body) throws Exception { next = new Fake(status, body); }
    private static void failure(Api api, int status, String body, String code) throws Exception {
        fixture(status, body);
        try { api.request("GET", "/sessions", null); throw new AssertionError("Expected failure"); }
        catch(Api.Failure e) { check(code.equals(e.code)); check(status == e.status); }
        check(last.disconnected);
    }
    public static void main(String[] args) throws Exception {
        URL.setURLStreamHandlerFactory(protocol -> "https".equals(protocol) ? new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL url) { opened++; last=next; check(url.getHost().equals("fixture.invalid")); return next; }
        } : null);
        Api api = new Api("https://fixture.invalid", "fake-device-token");
        fixture(200, "{\"ok\":true,\"data\":{\"sessions\":[]}}");
        check(api.request("GET", "/sessions", null).getJSONArray("sessions").length()==0);
        check("Bearer fake-device-token".equals(last.getRequestProperty("Authorization")));
        check(!last.getInstanceFollowRedirects()); check(!last.getUseCaches()); check(last.disconnected);
        fixture(202, "{\"ok\":true,\"data\":{\"accepted\":true}}");
        int before=opened;
        check(api.request("POST", "/sessions/session-1/messages", new JSONObject().put("text", "hello")).getBoolean("accepted"));
        check(opened==before+1); check(last.getRequestMethod().equals("POST"));
        check(last.fixedLength()==last.sent.size()); check(new JSONObject(last.sent.toString("UTF-8")).getString("text").equals("hello"));
        fixture(200, "{\"ok\":true,\"data\":{\"deviceToken\":\"fake\",\"scopes\":[\"read\"]}}");
        new Api("https://fixture.invalid", null).request("POST", "/enroll", new JSONObject().put("code", "test"));
        check(last.getRequestProperty("Authorization")==null);
        failure(api, 302, "", "redirect");
        failure(api, 401, "{\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"revoked\"}}", "unauthorized");
        failure(api, 403, "{\"ok\":false,\"error\":{\"code\":\"existing_permissions_required\"}}", "existing_permissions_required");
        failure(api, 429, "{\"ok\":false,\"error\":{\"code\":\"rate_limited\"}}", "rate_limited");
        failure(api, 200, "<html>not companion API</html>", "invalid_response");
        failure(api, 200, new String(new char[2*1024*1024+1]).replace('\0', 'x'), "too_large");
        System.out.println("PASS " + checks + " HTTPS facade fixture assertions (no live TLS/server)");
    }
}
