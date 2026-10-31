package com.craftagents.companion;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** Pure policy helpers, independently testable without Android. */
public final class Policy {
    private Policy() {}
    public static String origin(String value) {
        try {
            URI uri = new URI(value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                    || uri.getPort() == 0 || uri.getPort() > 65535) throw new Exception();
            return "https://" + uri.getRawAuthority();
        } catch (Exception e) { throw new IllegalArgumentException("Enter an HTTPS server origin, without a path, password, query or fragment."); }
    }
    public static String segment(String id) {
        if (id == null || id.isEmpty() || id.equals(".") || id.equals(".."))
            throw new IllegalArgumentException("Invalid resource ID");
        try { return URLEncoder.encode(id, "UTF-8").replace("+", "%20"); }
        catch (java.io.UnsupportedEncodingException e) { throw new AssertionError(e); }
    }
    public static long pollDelay(int failures, boolean processing) {
        if (failures > 0) return Math.min(30000L, 2000L << Math.min(failures, 4));
        return processing ? 2000L : 10000L;
    }
}
