"""Source/build guardrails only, not a substitute for real-device security testing."""
from pathlib import Path
import xml.etree.ElementTree as ET
root = Path(__file__).resolve().parents[1]
src = root / 'src/com/craftagents/companion'
manifest = ET.parse(root / 'AndroidManifest.xml').getroot()
a = '{http://schemas.android.com/apk/res/android}'
app = manifest.find('application')
assert app.get(a + 'usesCleartextTraffic') == 'false'
assert app.get(a + 'allowBackup') == 'false'
assert [p.get(a + 'name') for p in manifest.findall('uses-permission')] == ['android.permission.INTERNET']
assert len(manifest.findall('.//intent-filter')) == 1  # no enrollment URI handler leaking tokens
api = (src/'Api.java').read_text()
assert 'setInstanceFollowRedirects(false)' in api
assert 'setFixedLengthStreamingMode' in api
assert 'HttpsURLConnection' in api
for forbidden in ['setHostnameVerifier', 'setSSLSocketFactory', 'Log.', 'printStackTrace', 'addJavascriptInterface']:
    assert not any(forbidden in f.read_text() for f in src.glob('*.java')), forbidden
store = (src/'CredentialStore.java').read_text()
assert 'AndroidKeyStore' in store and 'AES/GCM/NoPadding' in store and 'updateAAD' in store
assert '.putString("ciphertext"' in store
ui = (src/'MainActivity.java').read_text()
assert 'FLAG_SECURE' in ui and 'IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS' in ui
assert 'hasScope("create")' in ui and 'hasScope("existing-permissions")' in ui
assert 'read retry' in ui.lower() and 'Not automatically retried' in ui
assert 'contentText' in ui and 'setTextIsSelectable(true)' in ui
assert 'InputFilter.LengthFilter(12000)' in ui
print('PASS Android manifest and source security guardrails')

page = (src/'StaticPageView.java').read_text()
for guard in ['setJavaScriptEnabled(false)', 'setAllowFileAccess(false)', 'setAllowContentAccess(false)', 'setBlockNetworkLoads(true)', 'setAcceptCookie(false)', 'setAcceptThirdPartyCookies(this, false)', "default-src 'none'", "script-src 'none'", "connect-src 'none'", 'handler.cancel()', 'shouldInterceptRequest', 'shouldOverrideUrlLoading', 'companion-preview.invalid']:
    assert guard in page, guard
assert 'Authorization' not in page and 'deviceToken' not in page
print('PASS static Page renderer source guardrails (runtime isolation unverified)')

assert 'GrantSummary.describe(device)' in ui
assert 'Chat can invoke this Puck' in ui
for field in ['allSessions', 'sessionIds', 'consent']:
    assert 'saved.put("' + field + '"' in ui
print('PASS visible tool-permission disclosure and persisted grant metadata guardrails')

assert app.get(a + 'label') == 'Scoville Agents'
assert manifest.get('package') == 'com.craftagents.companion'
assert 'base("Scoville Agents"' in ui
assert 'Craft Companion' not in ui and 'Scoville Companion' not in ui
print('PASS Scoville Agents display brand with unchanged internal package')
