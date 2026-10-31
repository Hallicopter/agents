package com.craftagents.companion;

import org.json.JSONArray;
import org.json.JSONObject;

/** Informational enrollment snapshot only; never an authorization decision. */
final class GrantSummary {
    static String describe(JSONObject device) {
        if (device == null) return "Not paired";
        String sessions;
        if (!device.has("allSessions") || device.optJSONArray("sessionIds") == null) {
            sessions = "Session grant details unavailable; verify on desktop.";
        } else if (device.optBoolean("allSessions")) {
            sessions = "All workspace sessions";
        } else {
            sessions = device.optJSONArray("sessionIds").length() + " sessions allowed at pairing; device-created sessions are added.";
        }
        JSONArray scopes = device.optJSONArray("scopes");
        StringBuilder names = new StringBuilder();
        if (scopes != null) for (int i=0; i<scopes.length(); i++) {
            if (i > 0) names.append(", ");
            names.append(scopes.optString(i));
        }
        return sessions + "\nPages: workspace-wide read access.\nScopes: " + (names.length() == 0 ? "not recorded" : names.toString())
            + "\nEnrollment grant snapshot; server authorization is authoritative.";
    }
}
