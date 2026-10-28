package qa.fitx.attendance;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Fake-GPS check. Right after the app takes a GPS fix, look at the phone's recent locations
 * and report whether any came from a mock-location ("Fake GPS") app.
 */
@CapacitorPlugin(name = "FitxGuard")
public class GuardPlugin extends Plugin {

    @PluginMethod
    public void check(PluginCall call) {
        boolean mock = false;
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm != null) {
                List<String> providers = lm.getProviders(true);
                long nowNs = SystemClock.elapsedRealtimeNanos();
                for (String p : providers) {
                    Location l;
                    try {
                        l = lm.getLastKnownLocation(p);
                    } catch (SecurityException se) {
                        continue;
                    }
                    if (l == null) continue;
                    // only fixes from the last 2 minutes
                    if (nowNs - l.getElapsedRealtimeNanos() > 120_000_000_000L) continue;
                    if (isMock(l)) {
                        mock = true;
                        break;
                    }
                }
            }
        } catch (Exception e) {
            // never block a punch because the check itself failed
        }
        JSObject ret = new JSObject();
        ret.put("mock", mock);
        call.resolve(ret);
    }

    /** Start watching the office zone (after a check-in). cfg = JSON string with office, slot, tokens. */
    @PluginMethod
    public void officeWatch(PluginCall call) {
        String cfg = call.getString("cfg");
        if (cfg == null) { call.reject("no cfg"); return; }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33
                    && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                    && getActivity() != null) {
                ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7301);
            }
            Intent i = new Intent(getContext(), OfficeWatchService.class).putExtra("cfg", cfg);
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void officeStop(PluginCall call) {
        try {
            getContext().getSharedPreferences(OfficeWatchService.PREFS, Context.MODE_PRIVATE).edit().putBoolean("active", false).apply();
            getContext().stopService(new Intent(getContext(), OfficeWatchService.class));
        } catch (Exception ignored) { }
        call.resolve();
    }

    /** Is the app free from battery limits (so phones like Xiaomi/Oppo don't stop the office watch)? */
    @PluginMethod
    public void battery(PluginCall call) {
        boolean free = true;
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            free = pm == null || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception ignored) { }
        JSObject r = new JSObject();
        r.put("unrestricted", free);
        r.put("maker", android.os.Build.MANUFACTURER);
        call.resolve(r);
    }

    @PluginMethod
    public void openBattery(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            try {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @SuppressWarnings("deprecation")
    private static boolean isMock(Location l) {
        if (Build.VERSION.SDK_INT >= 31) return l.isMock();
        return l.isFromMockProvider();
    }
}
