package com.craftagents.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Device credential only; never stores the pairing code or server admin token. */
final class CredentialStore {
    private static final String ALIAS = "craft-companion-device-v1";
    private final SharedPreferences prefs;
    CredentialStore(Context context) { prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }
    void save(JSONObject data) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key());
        c.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        String ciphertext = Base64.encodeToString(c.doFinal(data.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP)).putString("ciphertext", ciphertext).commit())
            throw new Exception("Could not save encrypted device credential");
    }
    JSONObject load() throws Exception {
        String ciphertext = prefs.getString("ciphertext", null);
        if (ciphertext == null) return null;
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)));
        c.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(c.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }
    void clear() throws Exception {
        if (!prefs.edit().clear().commit()) throw new Exception("Could not clear device credential");
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null); ks.deleteEntry(ALIAS);
    }
}
