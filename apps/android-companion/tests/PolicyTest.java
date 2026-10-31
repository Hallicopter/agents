package com.craftagents.companion;

public final class PolicyTest {
    private static int checks;
    private static void equal(Object expected, Object actual) {
        checks++; if (!expected.equals(actual)) throw new AssertionError(expected + " != " + actual);
    }
    private static void denied(String value) {
        checks++; try { Policy.origin(value); throw new AssertionError("Accepted unsafe origin: " + value); }
        catch (IllegalArgumentException expected) { }
    }
    public static void main(String[] args) {
        equal("https://example.com", Policy.origin(" https://example.com/ "));
        equal("https://example.com:443", Policy.origin("https://example.com:443"));
        equal("https://[::1]:8443", Policy.origin("https://[::1]:8443"));
        for (String bad : new String[]{"http://example.com", "file:///etc/passwd", "https://a@b", "https://a:b@c", "https://example.com/path", "https://example.com?token=x", "https://example.com#fragment", "https://", "example.com", "javascript:alert(1)", "https://example.com:0", "https://example.com:65536", "https://example.com\\@evil.com", "https://example.com\r\nX-Foo:bar"}) denied(bad);
        equal("safe-id_12", Policy.segment("safe-id_12"));
        equal("a%2Fb", Policy.segment("a/b"));
        equal("a%3Fb%23c", Policy.segment("a?b#c"));
        equal("a%20b", Policy.segment("a b"));
        for (String bad : new String[]{"", ".", ".."}) {
            checks++; try { Policy.segment(bad); throw new AssertionError("Unsafe segment"); }
            catch (IllegalArgumentException expected) { }
        }
        equal(2000L, Policy.pollDelay(0, true));
        equal(10000L, Policy.pollDelay(0, false));
        equal(4000L, Policy.pollDelay(1, true));
        equal(30000L, Policy.pollDelay(100, false));
        System.out.println("PASS " + checks + " policy assertions");
    }
}
