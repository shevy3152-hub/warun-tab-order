package jp.co.warun.androidkiosk;

import android.content.SharedPreferences;
import android.util.Base64;

import java.security.GeneralSecurityException;

final class PinSettings {
    static final String PREFS = "staff_pin_state";
    static final String KEY_SALT = "salt_b64";
    static final String KEY_HASH = "hash_b64";
    static final String KEY_ITERATIONS = "iterations";
    static final String KEY_FAILURES = "failures";
    static final String KEY_LOCKOUT_UNTIL = "lockout_until_ms";

    private PinSettings() {}

    static boolean isConfigured(SharedPreferences prefs) {
        return prefs.getString(KEY_SALT, null) != null
                && prefs.getString(KEY_HASH, null) != null
                && prefs.getInt(KEY_ITERATIONS, 0) == PinSecurity.ITERATIONS;
    }

    static boolean saveNewPin(SharedPreferences prefs, char[] pin) {
        try {
            byte[] salt = PinSecurity.newSalt();
            byte[] hash = PinSecurity.derive(pin, salt, PinSecurity.ITERATIONS);
            return prefs.edit()
                    .putString(KEY_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
                    .putString(KEY_HASH, Base64.encodeToString(hash, Base64.NO_WRAP))
                    .putInt(KEY_ITERATIONS, PinSecurity.ITERATIONS)
                    .putInt(KEY_FAILURES, 0)
                    .putLong(KEY_LOCKOUT_UNTIL, 0L)
                    .commit();
        } catch (GeneralSecurityException error) {
            return false;
        }
    }
}
