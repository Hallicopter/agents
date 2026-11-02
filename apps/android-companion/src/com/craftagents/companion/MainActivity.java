package com.craftagents.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.text.TextWatcher;
import android.text.Editable;
import android.view.Gravity;
import android.view.ViewGroup;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import android.text.InputFilter;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native, deliberately small companion. Sensitive transcript data lives in memory only. */
public final class MainActivity extends Activity {
    private static final int INK = Color.rgb(24, 43, 38), MUTED = Color.rgb(91, 108, 100), GREEN = Color.rgb(0, 106, 82);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private CredentialStore store;
    private JSONObject device;
    private Api api;
    private LinearLayout root, content, messages;
    private TextView connection, detailMeta;
    private EditText composer;
    private Button send;
    private ListView history;
    private final ChatModel chatModel = new ChatModel();
    private ChatAdapter chatAdapter;
    private TextView activity, historyNotice;
    private JSONArray sessionSnapshot = new JSONArray();
    private String listKey = "", search = "", category = "Pucks", lastActivity = "";
    private boolean wasProcessing, awaitingReply;
    private String acceptedAssistantKey = "";
    private final HashMap<String,String> drafts = new HashMap<>();
    private StaticPageView pageView;
    private String screen = "sessions", selected = "", transcriptKey = "";
    private int generation = 0, failures = 0;
    private boolean resumed, reading, mutating, processing;
    private String permissionMode = "";
    private final Runnable poll = () -> refresh(false);

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        store = new CredentialStore(this);
        try {
            device = store.load();
            if (device != null) api = new Api(device.getString("origin"), device.getString("deviceToken"));
        } catch (Exception e) { device = null; api = null; }
        if (api == null) enrollment(); else shell("sessions", "");
    }
    @Override public void onResume() { super.onResume(); resumed = true; if (pageView != null) pageView.onResume(); if (api != null) refresh(false); }
    @Override public void onPause() { resumed = false; if (pageView != null) pageView.onPause(); main.removeCallbacks(poll); super.onPause(); }
    @Override public void onDestroy() { generation++; disposePage(); main.removeCallbacksAndMessages(null); io.shutdownNow(); super.onDestroy(); }
    @Override public void onBackPressed() {
        if (screen.equals("chat") || screen.equals("children")) shell("sessions", "");
        else if (screen.equals("page")) shell("pages", "");
        else super.onBackPressed();
    }
    private int dp(int n) { return (int)(getResources().getDisplayMetrics().density * n + .5f); }
    private LinearLayout column() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private TextView text(String value, int size, int color) {
        TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); t.setPadding(0, dp(6), 0, dp(6)); return t;
    }
    private void updateText(TextView view, String value) { if(!android.text.TextUtils.equals(view.getText(),value))view.setText(value); }
    private Button button(String label, Runnable action) {
        Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextColor(GREEN); b.setMinHeight(dp(48)); b.setMinimumWidth(0); b.setElevation(0); b.setStateListAnimator(null); b.setBackground(buttonSurface(Color.TRANSPARENT,24)); b.setPadding(dp(12),0,dp(12),0); b.setOnClickListener(v -> action.run()); return b;
    }
    private GradientDrawable shape(int color, int radius) {
        GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;
    }
    private android.graphics.drawable.Drawable buttonSurface(int color,int radius) {
        GradientDrawable fill=shape(color,radius);fill.setColor(new android.content.res.ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled},new int[]{}},new int[]{color==GREEN?Color.rgb(156,175,163):color,color}));
        return new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.argb(40,0,106,82)),fill,shape(Color.WHITE,radius));
    }
    private void categories() {
        HorizontalScrollView scroll=new HorizontalScrollView(this);scroll.setHorizontalScrollBarEnabled(false);
        LinearLayout tabs=new LinearLayout(this);tabs.setPadding(0,dp(10),0,dp(12));
        for(String label:new String[]{"Pucks","Automations","Subagents","Other chats"}) {
            Button tab=button(label,()->{category=label;search="";shell("sessions","");});
            tab.setTextSize(13);tab.setTypeface(null,Typeface.BOLD);tab.setBackground(buttonSurface(category.equals(label)?Color.rgb(216,243,227):Color.rgb(240,243,241),24));
            tab.setTextColor(category.equals(label)?GREEN:MUTED);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-2,dp(48));lp.setMargins(0,0,dp(8),0);tabs.addView(tab,lp);
        }
        scroll.addView(tabs);root.addView(scroll);
    }
    private EditText input(String hint, boolean secret) {
        EditText e = new EditText(this); e.setHint(hint); e.setTextColor(INK); e.setTextSize(16); e.setSaveEnabled(false);
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        if (secret) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return e;
    }
    private void base(String title, String subtitle) {
        main.removeCallbacks(poll); disposePage(); generation++; reading = false;
        root = column(); root.setBackgroundColor(screen.equals("chat")?Color.rgb(242,240,232):Color.WHITE); root.setPadding(dp(18), dp(12), dp(18), dp(8));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            root.setPadding(dp(18) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(),
                dp(18) + insets.getSystemWindowInsetRight(), dp(8) + insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        LinearLayout heading = new LinearLayout(this); heading.setGravity(Gravity.CENTER_VERTICAL);
        if(api != null) {Button nav=button(screen.equals("chat")?"‹":"☰", ()->{if(screen.equals("chat"))shell("sessions","");else showDrawer();});nav.setContentDescription(screen.equals("chat")?"Back to chats":"Open navigation menu");heading.addView(nav,new LinearLayout.LayoutParams(dp(48),dp(48)));}
        TextView brand = text(title, 22, GREEN); brand.setTypeface(null, Typeface.BOLD); heading.addView(brand,new LinearLayout.LayoutParams(0,-2,1)); root.addView(heading);
        connection = text(subtitle, 11, MUTED); connection.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(connection);
        setContentView(root);
    }
    private boolean hasScope(String scope) {
        JSONArray scopes = device == null ? null : device.optJSONArray("scopes");
        if (scopes != null) for (int i=0; i<scopes.length(); i++) if (scope.equals(scopes.optString(i))) return true;
        return false;
    }
    private boolean chatAllowed() { return hasScope("chat"); }
    private boolean canSend() { return api != null && chatAllowed() && ("safe".equals(permissionMode) || hasScope("existing-permissions")); }
    private void enrollment() {
        screen = "enroll"; base("Scoville Agents", "Private connection • Android preview");
        ScrollView scroll = new ScrollView(this); LinearLayout form = column(); scroll.addView(form); root.addView(scroll);
        form.addView(text("Your Pucks, wherever you are.", 22, INK));
        form.addView(text("Enter your server’s HTTPS origin and a single-use pairing code created on your trusted desktop. Codes expire in five minutes. Never enter an admin token.", 15, MUTED));
        EditText origin = input("https://your-server.example", false); origin.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); origin.setSingleLine(true); form.addView(origin);
        EditText code = input("Single-use pairing code", true); code.setSingleLine(true); form.addView(code);
        EditText name = input("Device name", false); name.setText("Scoville Agents Android"); name.setSingleLine(true); name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(100)}); form.addView(name);
        Button pair = button("Pair this device", () -> {}); form.addView(pair);
        pair.setOnClickListener(v -> {
            if (mutating) return;
            final String address;
            try { address = Policy.origin(origin.getText().toString()); } catch (Exception e) { connection.setText(e.getMessage()); return; }
            String pairingCode = code.getText().toString().trim();
            if (pairingCode.isEmpty()) { connection.setText("Enter a fresh single-use pairing code."); return; }
            JSONObject body = new JSONObject();
            try { body.put("code", pairingCode).put("deviceName", name.getText().toString().trim()); } catch (Exception ignored) {}
            code.setText(""); mutating = true; pair.setEnabled(false); connection.setText("Pairing securely…");
            int epoch = generation;
            io.execute(() -> {
                try {
                    JSONObject result = new Api(address, null).request("POST", "/enroll", body);
                    result.getString("deviceToken"); result.getString("deviceId"); result.getString("workspaceId");
                    JSONObject saved = new JSONObject().put("origin", address).put("deviceId", result.getString("deviceId"))
                        .put("deviceToken", result.getString("deviceToken")).put("workspaceId", result.getString("workspaceId"))
                        .put("scopes", result.optJSONArray("scopes"));
                    if (result.has("allSessions")) saved.put("allSessions", result.getBoolean("allSessions"));
                    if (result.optJSONArray("sessionIds") != null) saved.put("sessionIds", result.getJSONArray("sessionIds"));
                    if (result.has("consent")) saved.put("consent", result.getString("consent"));
                    store.save(saved);
                    main.post(() -> { mutating = false; if (epoch != generation || isDestroyed()) return;
                        clearCredentialViews(); device = saved; api = new Api(address, saved.optString("deviceToken")); shell("sessions", ""); });
                } catch (Exception e) { main.post(() -> { mutating = false; if (epoch != generation || isDestroyed()) return;
                    pair.setEnabled(true); connection.setText("Pairing failed. " + safeError(e) + " If the code was consumed, create a new one on desktop."); }); }
            });
        });
        form.addView(text("The revocable device credential and grant summary are saved encrypted with Android Keystore. No background sync, analytics, file access, or admin credential. Screenshots and backups are disabled.", 13, MUTED));
    }
    private void shell(String next, String id) {
        if (mutating) { connection.setText("Wait for the pending request before navigating."); return; }
        if (composer != null && screen.equals("chat")) drafts.put(selected, composer.getText().toString());
        screen = next; selected = id; transcriptKey = ""; listKey = ""; failures = 0; permissionMode = ""; send = null; composer = null;
        awaitingReply = false; wasProcessing = false; lastActivity = ""; acceptedAssistantKey = ""; activity = null; chatModel.rows.clear();
        base("Scoville Agents", "Connecting…");
        if (next.equals("chat")) {
            detailMeta = text("Loading session…", 20, INK); detailMeta.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL)); detailMeta.setMaxLines(2);detailMeta.setEllipsize(android.text.TextUtils.TruncateAt.END);
            LinearLayout actions = new LinearLayout(this); actions.setGravity(Gravity.CENTER_VERTICAL);actions.addView(detailMeta,new LinearLayout.LayoutParams(0,-2,1)); actions.addView(button("Subagents  ›", () -> shell("children", selected)), new LinearLayout.LayoutParams(-2,dp(48))); root.addView(actions);
            activity = text("Connecting…", 12, GREEN); activity.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(activity);
            historyNotice = text("",12,MUTED); root.addView(historyNotice); historyNotice.setPadding(0,dp(2),0,dp(2));
            history = new ListView(this); history.setDivider(null); history.setDividerHeight(0); history.setTranscriptMode(ListView.TRANSCRIPT_MODE_DISABLED);
            history.setCacheColorHint(Color.TRANSPARENT); history.setClipToPadding(false); history.setPadding(0,dp(8),0,dp(8));
            chatAdapter = new ChatAdapter(); history.setAdapter(chatAdapter); root.addView(history, new LinearLayout.LayoutParams(-1, 0, 1));
            TextView notice = text(chatAllowed() ? "Chat can invoke this Puck’s tools under its existing permissions. Mobile cannot approve requests." : "Read-only device • Chat was not granted at pairing.", 12, MUTED); root.addView(notice);
            composer = input("Message", false); composer.setBackground(shape(Color.WHITE,26)); composer.setPadding(dp(18),dp(12),dp(16),dp(12)); composer.setFilters(new InputFilter[]{new InputFilter.LengthFilter(12000)}); composer.setMinLines(1); composer.setMaxLines(4); composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES); composer.setText(drafts.containsKey(selected) ? drafts.get(selected) : "");
            LinearLayout composeRow = new LinearLayout(this); composeRow.setGravity(Gravity.BOTTOM); composeRow.addView(composer,new LinearLayout.LayoutParams(0,-2,1));
            send = button("↑", this::sendMessage); send.setContentDescription("Send message"); send.setTextSize(24); send.setTextColor(Color.WHITE); send.setBackground(buttonSurface(GREEN,26)); send.setEnabled(canSend() && !mutating); composer.setEnabled(chatAllowed()); LinearLayout.LayoutParams sendLayout=new LinearLayout.LayoutParams(dp(52),dp(52));sendLayout.setMargins(dp(8),0,0,0);composeRow.addView(send,sendLayout); composeRow.setPadding(0,dp(8),0,dp(4)); root.addView(composeRow);
        } else {
            if (next.equals("sessions")) {
                LinearLayout listHeading=new LinearLayout(this);listHeading.setGravity(Gravity.CENTER_VERTICAL);
                TextView section = text("Chats",32,INK); section.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));listHeading.addView(section,new LinearLayout.LayoutParams(0,-2,1));
                Button create=button("＋",this::createSession);create.setContentDescription("New safe session");create.setTextSize(28);create.setEnabled(hasScope("create")&&!mutating);listHeading.addView(create,new LinearLayout.LayoutParams(dp(48),dp(48)));root.addView(listHeading);
                EditText find=input("Search your chats",false);find.setBackground(shape(Color.rgb(241,244,242),26));find.setPadding(dp(20),dp(10),dp(16),dp(10));find.setSingleLine(true); find.setText(search);root.addView(find,new LinearLayout.LayoutParams(-1,dp(50)));
                find.addTextChangedListener(new TextWatcher(){ public void beforeTextChanged(CharSequence s,int st,int c,int a){} public void onTextChanged(CharSequence s,int st,int before,int count){search=s.toString();renderSessions();} public void afterTextChanged(Editable e){} });
                categories();
            }
            if (next.equals("pages") || next.equals("page")) root.addView(text("Static Pages preview • scripts, source actions, links and external resources disabled. Inline styles and embedded images only.", 12, MUTED));
            ScrollView scroll = new ScrollView(this); content = column(); scroll.addView(content); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
            LinearLayout footer=new LinearLayout(this);footer.setGravity(Gravity.CENTER_VERTICAL);TextView privacy=text(next.equals("sessions")?"Only chats granted to this device":"Private workspace",11,MUTED);footer.addView(privacy,new LinearLayout.LayoutParams(0,-2,1));footer.addView(button("Refresh",()->refresh(true)));root.addView(footer);
        }
        if (resumed) refresh(false);
    }
    private String path() {
        switch (screen) {
            case "sessions": return "/sessions";
            case "chat": return "/sessions/" + Policy.segment(selected);
            case "children": return "/sessions/" + Policy.segment(selected) + "/subagents";
            case "pages": return "/pages";
            case "page": return "/pages/" + Policy.segment(selected);
            default: return "";
        }
    }
    private void refresh(boolean manual) {
        main.removeCallbacks(poll);
        if (!resumed || api == null || screen.equals("enroll") || reading) return;
        reading = true; int epoch = generation; Api client = api; String requestedPath = path();
        if (manual) connection.setText("Refreshing…");
        io.execute(() -> {
            try {
                JSONObject data = client.request("GET", requestedPath, null);
                main.post(() -> { if (epoch != generation || isDestroyed()) return; reading = false; failures = 0;
                    connection.setText("Connected • " + (chatAllowed() ? "Chat enabled" : "Read-only") + " • " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date()));
                    render(data); schedule(); });
            } catch (Exception e) {
                main.post(() -> { if (epoch != generation || isDestroyed()) return; reading = false; failures++;
                    if (e instanceof Api.Failure && ((Api.Failure)e).status == 401) {
                        api = null; if(activity!=null)activity.setText("Authorization revoked or expired • re-pair from Device"); connection.setText("Device authorization expired or revoked. Re-pair from Device. Cached view is not current.");
                        if (send != null) send.setEnabled(false); return;
                    }
                    if(activity!=null && screen.equals("chat"))activity.setText("Reconnecting • " + safeError(e));
                    connection.setText("Not current • " + safeError(e) + " • Read retry in " + Policy.pollDelay(failures, processing)/1000 + "s"); schedule(); });
            }
        });
    }
    private void schedule() {
        if (resumed && api != null && !screen.equals("page")) main.postDelayed(poll, Policy.pollDelay(failures, processing));
        else if (resumed && api != null && failures > 0) main.postDelayed(poll, Policy.pollDelay(failures, false));
    }
    private String sessionLabel(JSONObject s) {
        String name = s.optString("name", ""); if (name.isEmpty()) name = s.optString("id", "Unnamed session");
        return name + "\n" + (s.optBoolean("isProcessing") ? "● Working" : "○ Idle")
            + (s.optString("sessionStatus").isEmpty() ? "" : " · " + s.optString("sessionStatus"));
    }
    private void render(JSONObject data) {
        processing = false;
        if (screen.equals("chat")) {
            JSONObject s = data.optJSONObject("session"); if (s == null) { connection.setText("Invalid session response"); return; }
            processing = s.optBoolean("isProcessing"); permissionMode = s.optString("permissionMode");
            send.setEnabled(canSend() && !mutating);
            updateText(detailMeta, s.optString("name",selected));
            detailMeta.setContentDescription(s.optString("name",selected)+". "+s.optString("permissionMode")+" mode");
            connection.setText("Connected · "+(permissionMode.isEmpty()?"Session":permissionMode)+" mode · "+(chatAllowed()?"Chat enabled":"Read-only"));
            if(chatAllowed()&&!canSend()) connection.setText("Messaging needs the existing-permissions grant on desktop.");
            JSONArray list = data.optJSONArray("messages"); if (list == null) list = new JSONArray();
            String assistantKey=""; for(int i=0;i<list.length();i++){JSONObject m=list.optJSONObject(i);if(m!=null&&"assistant".equals(m.optString("role")))assistantKey=m.optString("id")+":"+m.optString("content");}
            if (awaitingReply && !processing && !assistantKey.isEmpty() && !assistantKey.equals(acceptedAssistantKey)) { awaitingReply=false; lastActivity="Reply received"; }
            else if(wasProcessing && !processing && !awaitingReply) lastActivity="Work stopped • check latest reply";
            updateText(activity, mutating ? "Sending once…" : processing ? "● Working · snapshots every 2s, not streaming" : awaitingReply ? "Accepted • waiting for reply" : lastActivity.isEmpty() ? "Ready" : lastActivity);
            wasProcessing=processing;
            updateText(historyNotice, data.optBoolean("truncated") ? "Recent 100 messages • older history available on desktop" : list.length()==0 ? "No messages yet. Say hello below." : "");
            if(chatModel.update(list)) {
                int first=history.getFirstVisiblePosition(); View top=history.getChildAt(0); int offset=top==null?0:top.getTop();
                boolean bottom=history.getCount()==0 || (history.getLastVisiblePosition()>=history.getCount()-1 && (history.getChildCount()==0 || history.getChildAt(history.getChildCount()-1).getBottom()<=history.getHeight()+dp(64)));
                String anchor=first<chatAdapter.priorIds.size()?chatAdapter.priorIds.get(first):"";
                chatAdapter.notifyDataSetChanged(); chatAdapter.remember();
                if(bottom)history.setSelection(Math.max(0,chatModel.rows.size()-1));
                else {int index=first;for(int i=0;i<chatModel.rows.size();i++)if(chatModel.rows.get(i).key.equals(anchor)){index=i;break;}history.setSelectionFromTop(index,offset);}
            }
            return;
        }
        if(screen.equals("sessions")) { JSONArray incoming=data.optJSONArray("sessions"); if(incoming==null)return; String key=incoming.toString(); if(!key.equals(listKey)){listKey=key;sessionSnapshot=incoming;renderSessions();}return; }
        disposePage(); content.removeAllViews();
        if (screen.equals("page")) {
            JSONObject page = data.optJSONObject("page"); content.addView(text(page == null ? selected : page.optString("name", selected), 22, INK));
            TextView body = text(data.optString("contentText", "No text preview available."), 16, INK); body.setTextIsSelectable(true);
            String html = data.optString("contentHtml", "");
            if (!html.isEmpty() && html.length() <= 250000) {
                try {
                    pageView = new StaticPageView(this, html, () -> { disposePage(); body.setVisibility(View.VISIBLE); connection.setText("Page renderer stopped. Showing text fallback."); });
                    content.addView(pageView, new LinearLayout.LayoutParams(-1, dp(560)));
                    body.setVisibility(View.GONE);
                    content.addView(button("Show / hide text fallback", () -> body.setVisibility(body.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE)));
                } catch (RuntimeException unavailable) {
                    disposePage(); content.addView(text("Visual renderer unavailable. Showing text instead.", 13, MUTED));
                }
            }
            content.addView(body); return;
        }
        JSONArray list = data.optJSONArray(screen.equals("pages") ? "pages" : "sessions");
        if (list == null) { content.addView(text("Invalid list response.", 15, MUTED)); return; }
        if (data.optBoolean("truncated")) content.addView(text("Bounded result • more items exist on desktop.", 12, MUTED));
        if (screen.equals("children")) {
            content.addView(button("← Back to this Puck", () -> shell("chat", selected)));
            content.addView(text("Subagents • status reflects the latest server snapshot", 16, INK));
        }
        if (list.length() == 0) content.addView(text("Nothing here yet.", 17, MUTED));
        for (int i=0; i<list.length(); i++) {
            JSONObject item = list.optJSONObject(i); if (item == null) continue;
            final String id = item.optString(screen.equals("pages") ? "slug" : "id"); if (id.isEmpty()) continue;
            final boolean page = screen.equals("pages");
            Button row = button(page ? item.optString("name", id) + "\n" + item.optString("description") : sessionLabel(item), () -> shell(page ? "page" : "chat", id));
            row.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL); row.setPadding(dp(12), dp(12), dp(12), dp(12)); content.addView(row);
            String parent = item.optString("parentSessionId");
            if (!parent.isEmpty()) content.addView(button("↳ Parent: " + parent, () -> shell("chat", parent)));
        }
    }
    private void showDrawer() {
        android.app.Dialog drawer = new android.app.Dialog(this);
        LinearLayout panel=column();panel.setPadding(dp(20),dp(30),dp(20),dp(24));panel.setBackgroundColor(Color.rgb(244,247,246));
        TextView title=text("Scoville Agents",24,INK);title.setTypeface(null,Typeface.BOLD);panel.addView(title);panel.addView(text("Your private workspace",13,MUTED));
        String[] sections={"Pucks","Automations","Subagents","Other chats","Pages","Device & access"};
        for(int i=0;i<sections.length;i++){final int which=i;panel.addView(button(sections[i],()->{drawer.dismiss();
            if(which<4){category=sections[which];search="";shell("sessions","");}
            else if(which==4)shell("pages","");else deviceDialog();}));}
        panel.addView(text("Device grants stay unchanged. Only authorized conversations are shown.",13,MUTED));
        drawer.setContentView(panel); android.view.Window w=drawer.getWindow();if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setGravity(Gravity.LEFT);w.setLayout(dp(290),-1);}drawer.show();if(w!=null)w.setLayout(dp(290),-1);
    }

    private void renderSessions() {
        if(content==null||!screen.equals("sessions"))return;
        ArrayList<JSONObject> items=new ArrayList<>();
        for(int i=0;i<sessionSnapshot.length();i++){JSONObject item=sessionSnapshot.optJSONObject(i);if(item!=null&&category.equals(ChatModel.group(item)) && item.optString("name",item.optString("id")).toLowerCase(java.util.Locale.ROOT).contains(search.toLowerCase(java.util.Locale.ROOT)))items.add(item);}
        Collections.sort(items,(a,b)->{if(ChatModel.primary(a)!=ChatModel.primary(b))return ChatModel.primary(a)?-1:1;return Long.compare(b.optLong("lastMessageAt"),a.optLong("lastMessageAt"));});
        content.removeAllViews();
        if(items.isEmpty())content.addView(text(category.equals("Pucks")?"No Pucks visible in this grant. Check device access on desktop, or choose another section from ☰.":"No matching chats.",16,MUTED));
        if(category.equals("Pucks")&&!items.isEmpty()) {TextView label=text("YOUR PUCKS",11,GREEN);label.setLetterSpacing(.12f);label.setTypeface(null,Typeface.BOLD);content.addView(label);}
        for(JSONObject item:items){String id=item.optString("id");boolean primary=ChatModel.primary(item);boolean busy=item.optBoolean("isProcessing");
            LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(2),dp(14),dp(2),dp(14));row.setMinimumHeight(dp(92));
            String name=item.optString("name",id);
            TextView avatar=text(name.isEmpty()?"P":name.substring(0,1).toUpperCase(java.util.Locale.ROOT),23,primary?GREEN:MUTED);avatar.setGravity(Gravity.CENTER);avatar.setTypeface(null,Typeface.BOLD);avatar.setPadding(0,0,0,0);avatar.setBackground(shape(primary?Color.rgb(218,241,227):Color.rgb(236,240,237),30));row.addView(avatar,new LinearLayout.LayoutParams(dp(56),dp(56)));
            LinearLayout copy=column();copy.setPadding(dp(15),0,dp(8),0);TextView title=text(name,18,INK);title.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));title.setMaxLines(2);title.setEllipsize(android.text.TextUtils.TruncateAt.END);copy.addView(title);
            TextView summary=text(busy?"Working on your request…":primary?"Your Puck · open conversation":"Open conversation",14,busy?GREEN:MUTED);summary.setPadding(0,dp(2),0,dp(2));copy.addView(summary);row.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
            TextView trailing=text(busy?"●":primary?"Pinned":"›",primary?11:18,busy?GREEN:MUTED);row.addView(trailing);
            row.setContentDescription(name+". "+(primary?"Pinned primary Puck. ":"")+(busy?"Working":"Open chat"));row.setFocusable(true);row.setClickable(true);android.util.TypedValue ripple=new android.util.TypedValue();getTheme().resolveAttribute(android.R.attr.selectableItemBackground,ripple,true);row.setBackgroundResource(ripple.resourceId);row.setOnClickListener(v->shell("chat",id));content.addView(row,new LinearLayout.LayoutParams(-1,-2));
            View divider=new View(this);divider.setBackgroundColor(Color.rgb(237,241,238));LinearLayout.LayoutParams line=new LinearLayout.LayoutParams(-1,dp(1));line.setMargins(dp(72),0,0,0);content.addView(divider,line);
        }
    }
    private final class ChatAdapter extends BaseAdapter {
        final ArrayList<String> priorIds=new ArrayList<>();
        void remember(){priorIds.clear();for(ChatModel.Row r:chatModel.rows)priorIds.add(r.key);}
        public int getCount(){return chatModel.rows.size();} public Object getItem(int n){return chatModel.rows.get(n);} public long getItemId(int n){return chatModel.rows.get(n).stableId;} public boolean hasStableIds(){return true;}
        public View getView(int n,View recycled,ViewGroup parent){
            LinearLayout wrapper; LinearLayout bubble; TextView body,meta;
            if(recycled==null){wrapper=new LinearLayout(MainActivity.this); wrapper.setPadding(0,dp(4),0,dp(4));bubble=column();bubble.setPadding(dp(14),dp(6),dp(14),dp(8));body=text("",16,INK);body.setLineSpacing(dp(3),1f);body.setTextIsSelectable(true);meta=text("",11,MUTED);meta.setGravity(Gravity.RIGHT);meta.setPadding(0,dp(4),0,0);bubble.addView(body);bubble.addView(meta);wrapper.addView(bubble,new LinearLayout.LayoutParams(-2,-2));wrapper.setTag(new Object[]{bubble,body,meta,null});}
            else wrapper=(LinearLayout)recycled;
            Object[] holder=(Object[])wrapper.getTag();bubble=(LinearLayout)holder[0];body=(TextView)holder[1];meta=(TextView)holder[2];ChatModel.Row row=chatModel.rows.get(n);
            if(holder[3]!=row){boolean user="user".equals(row.role);wrapper.setGravity(user?Gravity.RIGHT:Gravity.LEFT);wrapper.setPadding(user?dp(34):0,dp(6),user?0:dp(24),dp(6));
                GradientDrawable bg=new GradientDrawable();bg.setColor(user?Color.rgb(216,247,220):Color.WHITE);bg.setCornerRadii(new float[]{dp(16),dp(16),dp(user?4:16),dp(user?4:16),dp(16),dp(16),dp(user?16:4),dp(user?16:4)});bubble.setBackground(bg);
                body.setText(row.content);meta.setText((user?"You":"Puck")+(row.timestamp>0?" · "+DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(row.timestamp)):""));holder[3]=row;}
            return wrapper;
        }
    }
    private void sendMessage() {
        if (mutating || !canSend()) return;
        String value = composer.getText().toString().trim(); if (value.isEmpty()) return;
        JSONObject body = new JSONObject(); try { body.put("text", value); } catch (Exception ignored) {}
        mutation("/sessions/" + Policy.segment(selected) + "/messages", body, false);
    }
    private void createSession() {
        if (mutating || api == null || !hasScope("create")) return;
        EditText name = input("Session name (optional)", false); name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(100)});
        new AlertDialog.Builder(this).setTitle("New safe session").setMessage("Starts in Explore mode with no enabled sources or working directory.").setView(name)
            .setNegativeButton("Cancel", null).setPositiveButton("Create", (d,w) -> {
                JSONObject body = new JSONObject(); try { body.put("name", name.getText().toString().trim()); } catch (Exception ignored) {}
                mutation("/sessions", body, true);
            }).show();
    }
    private void mutation(String path, JSONObject body, boolean creating) {
        if (mutating || api == null) return;
        mutating = true; if (send != null) send.setEnabled(false); if(activity!=null)activity.setText("Sending once…"); connection.setText(creating ? "Creating…" : "Sending once…");
        int epoch = generation; Api client = api;
        io.execute(() -> {
            try {
                JSONObject result = client.request("POST", path, body);
                main.post(() -> { mutating = false; if (epoch != generation || isDestroyed()) return;
                    if (creating) { JSONObject s = result.optJSONObject("session"); if (s != null) shell("chat", s.optString("id")); else connection.setText("Created. Refresh the session list."); }
                    else { acceptedAssistantKey=""; for(ChatModel.Row r:chatModel.rows)if("assistant".equals(r.role))acceptedAssistantKey=r.id+":"+r.content; awaitingReply=true; lastActivity="Accepted • waiting for reply"; activity.setText(lastActivity); composer.setText(""); drafts.remove(selected); send.setEnabled(canSend()); connection.setText("Accepted by server. Waiting for next snapshot…"); refresh(false); }
                });
            } catch (Exception e) { main.post(() -> { mutating = false; if (epoch != generation || isDestroyed()) return;
                if (send != null) send.setEnabled(canSend()); if(activity!=null)activity.setText("Send unconfirmed • check history before retrying");
                new AlertDialog.Builder(this).setTitle("Request not confirmed").setMessage(safeError(e) + "\n\nNot automatically retried. The server may have accepted this request before the connection failed. Refresh history/list before manually trying again.").setPositiveButton("OK", null).show(); refresh(true);
            }); }
        });
    }
    private String safeError(Exception e) {
        if (e instanceof Api.Failure) return "Server " + ((Api.Failure)e).status + " (" + ((Api.Failure)e).code + ").";
        return TransportError.describe(e); // sanitized cause category; never exception payloads

    }
    private void deviceDialog() {
        String info = device == null ? "Not paired" : apiOrigin() + "\nWorkspace: " + device.optString("workspaceId") + "\nDevice: " + device.optString("deviceId") + "\n\n" + GrantSummary.describe(device) + "\n\n" + (chatAllowed() ? "Chat can invoke the target Puck’s tools under its existing permissions." : "Chat is not granted.") + "\nDesktop consent: " + device.optString("consent", "Not recorded; verify on desktop.");
        new AlertDialog.Builder(this).setTitle("This device").setMessage(info + "\n\nDisconnect removes the local credential only. Revoke this device on your trusted desktop to invalidate it server-side.")
            .setNegativeButton("Close", null).setPositiveButton("Disconnect / re-pair", (d,w) -> {
                if (mutating) { connection.setText("Wait for the pending request before disconnecting."); return; }
                try { store.clear(); clearCredentialViews(); device = null; api = null; send = null; enrollment(); }
                catch (Exception e) { connection.setText("Could not erase local credential. Try again or clear app storage in Android Settings."); }
            }).show();
    }
    private void clearCredentialViews() {
        main.removeCallbacks(poll); generation++; reading=false;
        drafts.clear(); sessionSnapshot=new JSONArray(); listKey=""; search=""; category="Pucks";
        chatModel.rows.clear(); transcriptKey=""; awaitingReply=false; wasProcessing=false; processing=false; lastActivity=""; acceptedAssistantKey="";
        if(composer!=null)composer.setText(""); composer=null; activity=null; historyNotice=null;
        if(content!=null)content.removeAllViews(); content=null; if(history!=null)history.setAdapter(null); history=null; chatAdapter=null;
        disposePage(); if(root!=null)root.removeAllViews();
    }
    private void disposePage() {
        if (pageView != null) {
            pageView.stopLoading();
            if (pageView.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup)pageView.getParent()).removeView(pageView);
            pageView.destroy(); pageView = null;
        }
    }
    private String apiOrigin() { return device == null ? "" : device.optString("origin"); }
}
