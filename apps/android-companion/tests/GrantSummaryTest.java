package com.craftagents.companion;
import org.json.JSONArray;
import org.json.JSONObject;
public final class GrantSummaryTest {
    static int checks;
    static void check(boolean result) { checks++; if (!result) throw new AssertionError("Grant assertion " + checks); }
    public static void main(String[] args) throws Exception {
        check(GrantSummary.describe(null).equals("Not paired"));
        check(GrantSummary.describe(new JSONObject()).contains("unavailable"));
        JSONObject device = new JSONObject().put("allSessions", false).put("sessionIds", new JSONArray().put("s1").put("s2"))
            .put("scopes", new JSONArray().put("read").put("chat").put("existing-permissions"));
        String summary = GrantSummary.describe(device);
        check(summary.contains("2 sessions allowed at pairing"));
        check(summary.contains("device-created sessions are added"));
        check(summary.contains("Pages: workspace-wide read access"));
        check(summary.contains("read, chat, existing-permissions"));
        check(GrantSummary.describe(device.put("allSessions", true)).contains("All workspace sessions"));
        System.out.println("PASS " + checks + " grant disclosure assertions");
    }
}
