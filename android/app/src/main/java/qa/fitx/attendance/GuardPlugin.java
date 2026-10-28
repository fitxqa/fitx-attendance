package qa.fitx.attendance;

import android.content.Context;
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

    @SuppressWarnings("deprecation")
    private static boolean isMock(Location l) {
        if (Build.VERSION.SDK_INT >= 31) return l.isMock();
        return l.isFromMockProvider();
    }
}
