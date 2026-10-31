package com.craftagents.companion;

import java.util.*;
import org.json.*;

/** Pure in-memory keyed diff. Unchanged snapshots never notify/rebind Android rows. */
final class ChatModel {
    static final class Row {
        final String id, key, role, content; final long timestamp, stableId;
        Row(JSONObject m,String k,long stable) { key=k;stableId=stable;id=m.optString("id"); role=m.optString("role"); content=m.optString("content"); timestamp=m.optLong("timestamp"); }
        boolean same(Row r) { return id.equals(r.id)&&role.equals(r.role)&&content.equals(r.content)&&timestamp==r.timestamp; }
    }
    final ArrayList<Row> rows=new ArrayList<>();
    int changedRows;
    private long nextStableId=1;
    boolean update(JSONArray messages) {
        changedRows=0;
        if(messages.length()==rows.size()) {
            boolean same=true;
            for(int i=0;i<rows.size();i++) { JSONObject m=messages.optJSONObject(i);Row r=rows.get(i);
                if(m==null||m.optBoolean("hidden")||!r.id.equals(m.optString("id"))||!r.role.equals(m.optString("role"))||!r.content.equals(m.optString("content"))||r.timestamp!=m.optLong("timestamp")){same=false;break;}
            }
            if(same)return false;
        }
        ArrayList<Row> next=new ArrayList<>(); changedRows=0;
        HashMap<String,Row> previous=new HashMap<>();for(Row r:rows)previous.put(r.key,r);
        HashMap<String,Integer> occurrences=new HashMap<>();
        for(int i=0;i<messages.length();i++) { JSONObject m=messages.optJSONObject(i); if(m==null||m.optBoolean("hidden"))continue;
            String id=m.optString("id");int occurrence=occurrences.containsKey(id)?occurrences.get(id):0;occurrences.put(id,occurrence+1);
            String key=id.length()+":"+id+":"+occurrence; Row old=previous.get(key);
            Row r=new Row(m,key,old==null?nextStableId++:old.stableId);
            if(old!=null && old.same(r)) r=old; else changedRows++;
            next.add(r);
        }
        boolean changed=changedRows>0||next.size()!=rows.size();
        if(!changed)for(int i=0;i<next.size();i++)if(next.get(i)!=rows.get(i)){changed=true;break;}
        if(changed){rows.clear();rows.addAll(next);} return changed;
    }
    static boolean label(JSONObject s,String label) { JSONArray labels=s.optJSONArray("labels"); if(labels!=null)for(int i=0;i<labels.length();i++)if(label.equals(labels.optString(i)))return true;return false; }
    static String group(JSONObject s) {
        if(label(s,"puck"))return "Pucks";
        if(label(s,"puck-automation"))return "Automations";
        if(label(s,"puck-subagent"))return "Subagents";
        return "Other chats";
    }
    static boolean primary(JSONObject s) {String id=s.optString("id");return label(s,"puck")&&(id.equals("261022-fresh-gust")||id.equals("261022-golden-reed"));}
}
