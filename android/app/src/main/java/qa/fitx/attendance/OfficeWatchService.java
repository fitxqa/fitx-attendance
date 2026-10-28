package qa.fitx.attendance;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Office watch: runs only while a technician is checked in at the office.
 * If the phone stays outside the office zone for "away" minutes, it records the
 * matching check-out (leave for visits / night check-out) with the time they walked out,
 * then stops. Talks to Firebase over plain REST (no Firebase Android SDK needed).
 */
public class OfficeWatchService extends Service implements LocationListener {

    static final String ACTION_STOP = "qa.fitx.attendance.STOP_WATCH";
    static final String PREFS = "office_watch";
    static final String CH_WATCH = "office_watch";
    static final String CH_EVENT = "office_events";
    static final int NID_WATCH = 7101;
    static final int NID_EVENT = 7102;

    private LocationManager lm;
    private HandlerThread netThread;
    private Handler net;
    private SharedPreferences prefs;
    private long firstOutAt = 0;       // wall-clock (server-corrected) ms when first seen outside
    private double outLat, outLng, outDist;
    private int outAcc;
    private boolean writing = false;
    private long lastTry = 0;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        netThread = new HandlerThread("office-watch-net");
        netThread.start();
        net = new Handler(netThread.getLooper());
        channels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            prefs.edit().putBoolean("active", false).apply();
            stopNow();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra("cfg")) {
            String nc = intent.getStringExtra("cfg");
            JSONObject old = cfg();
            boolean same = false;
            try {
                JSONObject n = new JSONObject(nc);
                same = old != null && prefs.getBoolean("active", false)
                        && old.optString("slot").equals(n.optString("slot")) && old.optLong("date") == n.optLong("date");
            } catch (Exception ignored) { }
            prefs.edit().putString("cfg", nc).putBoolean("active", true).apply();
            if (!same) { firstOutAt = 0; prefs.edit().remove("rt").apply(); } // same day & punch: keep the "outside since" timer
        }
        JSONObject c = cfg();
        if (c == null || !prefs.getBoolean("active", false)) { stopNow(); return START_NOT_STICKY; }
        // Stale config (another day) → stop.
        long until = c.optLong("until", 0);
        if (until > 0 && wallNow() > until) { prefs.edit().putBoolean("active", false).apply(); stopNow(); return START_NOT_STICKY; }

        try {
            Notification n = new NotificationCompat.Builder(this, CH_WATCH)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("FitX Attendance")
                    .setContentText("At " + c.optString("officeName", "the office") + " · leaving is recorded automatically")
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(openApp())
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(NID_WATCH, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NID_WATCH, n);
        } catch (Exception e) {
            // Android may refuse a location service started from the background: try again next time the app opens.
            stopSelf();
            return START_NOT_STICKY;
        }
        startUpdates();
        return START_STICKY;
    }

    private void startUpdates() {
        try {
            if (lm == null) lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            lm.removeUpdates(this);
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 30000, 0, this, Looper.getMainLooper());
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 30000, 0, this, Looper.getMainLooper());
        } catch (SecurityException e) {
            stopNow();
        } catch (Exception ignored) { }
    }

    @Override
    public void onLocationChanged(Location l) {
        JSONObject c = cfg();
        if (c == null) return;
        if (Build.VERSION.SDK_INT >= 18 && l.isFromMockProvider()) return; // ignore fake GPS
        float acc = l.hasAccuracy() ? l.getAccuracy() : 999;
        if (acc > 150) return;
        double d = distance(l.getLatitude(), l.getLongitude(), c.optDouble("lat"), c.optDouble("lng"));
        double radius = c.optDouble("radius", 100);
        boolean outside = d > radius + Math.max(30, acc);
        boolean inside = d <= radius;
        long now = wallNow();
        if (inside) { firstOutAt = 0; return; }
        if (!outside) return; // edge of the zone: wait for a clearer reading
        if (firstOutAt == 0) {
            firstOutAt = now;
            outLat = l.getLatitude(); outLng = l.getLongitude(); outDist = d; outAcc = Math.round(acc);
        }
        long awayMs = c.optLong("awayMin", 10) * 60000L;
        if (now - firstOutAt >= awayMs && !writing && now - lastTry > 60000) record(c);
    }

    private void record(final JSONObject c) {
        writing = true;
        lastTry = wallNow();
        final long leftAt = firstOutAt;
        final double lat = outLat, lng = outLng, dist = outDist;
        final int acc = outAcc;
        net.post(() -> {
            String result;
            try { result = writePunch(c, leftAt, lat, lng, dist, acc); } catch (Exception e) { result = "retry"; }
            final String r = result;
            new Handler(Looper.getMainLooper()).post(() -> {
                writing = false;
                if ("ok".equals(r) || "exists".equals(r)) {
                    if ("ok".equals(r)) notifyEvent(c.optString("label", "Check-out") + " recorded at " + hhmm(leftAt),
                            "You left " + c.optString("officeName", "the office") + ". Saved automatically.");
                    prefs.edit().putBoolean("active", false).apply();
                    stopNow();
                } else if ("auth".equals(r)) {
                    prefs.edit().putBoolean("active", false).apply();
                    stopNow();
                }
                // "retry": try again on a later location update (no internet etc.)
            });
        });
    }

    /** @return ok | exists | auth | retry */
    private String writePunch(JSONObject c, long leftAt, double lat, double lng, double dist, int acc) throws Exception {
        String key = c.getString("apiKey"), project = c.getString("projectId");
        // 1) fresh ID token from the refresh token the app handed over
        String body = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(prefs.getString("rt", c.getString("refreshToken")), "UTF-8");
        Resp t = http("POST", "https://securetoken.googleapis.com/v1/token?key=" + key, body, "application/x-www-form-urlencoded", null);
        if (t.code == 400 || t.code == 401 || t.code == 403) return "auth";
        if (t.code != 200) return "retry";
        JSONObject tj = new JSONObject(t.body);
        String idToken = tj.getString("id_token");
        if (tj.has("refresh_token")) prefs.edit().putString("rt", tj.getString("refresh_token")).apply();

        // 2) create the punch (fails if it already exists → punched by hand meanwhile)
        String emp = c.getString("emp"), slot = c.getString("slot");
        long date = c.getLong("date");
        String docPath = "projects/" + project + "/databases/(default)/documents/punches/" + emp + "_" + date + "_" + slot;
        JSONObject f = new JSONObject();
        f.put("emp", sv(emp));
        f.put("name", sv(c.optString("name", emp)));
        f.put("slot", sv(slot));
        f.put("date", iv(date));
        f.put("month", iv(date / 100));
        f.put("t", new JSONObject().put("timestampValue", rfc3339(leftAt)));
        f.put("lat", dv(lat));
        f.put("lng", dv(lng));
        f.put("acc", iv(acc));
        f.put("dist", iv(Math.round(dist)));
        f.put("device", sv(c.getString("device")));
        f.put("manual", new JSONObject().put("booleanValue", false));
        f.put("auto", new JSONObject().put("booleanValue", true));
        JSONObject write = new JSONObject()
                .put("update", new JSONObject().put("name", docPath).put("fields", f))
                .put("currentDocument", new JSONObject().put("exists", false));
        JSONObject req = new JSONObject().put("writes", new JSONArray().put(write));
        Resp w = http("POST", "https://firestore.googleapis.com/v1/projects/" + project + "/databases/(default)/documents:commit",
                req.toString(), "application/json", idToken);
        if (w.code == 200) return "ok";
        if (w.body != null && (w.body.contains("ALREADY_EXISTS") || w.body.contains("FAILED_PRECONDITION"))) return "exists";
        if (w.code == 403) return "exists"; // refused by the rules (e.g. order) → nothing more to do
        return "retry";
    }

    // ---------- helpers ----------
    static class Resp { int code; String body; }

    private static Resp http(String method, String url, String body, String type, String bearer) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setRequestMethod(method);
        h.setConnectTimeout(15000);
        h.setReadTimeout(20000);
        h.setRequestProperty("Content-Type", type);
        if (bearer != null) h.setRequestProperty("Authorization", "Bearer " + bearer);
        if (body != null) {
            h.setDoOutput(true);
            try (OutputStream o = h.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        Resp r = new Resp();
        r.code = h.getResponseCode();
        InputStream in = r.code >= 400 ? h.getErrorStream() : h.getInputStream();
        if (in != null) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            r.body = b.toString("UTF-8");
            in.close();
        }
        h.disconnect();
        return r;
    }

    private static JSONObject sv(String v) throws Exception { return new JSONObject().put("stringValue", v); }
    private static JSONObject iv(long v) throws Exception { return new JSONObject().put("integerValue", String.valueOf(v)); }
    private static JSONObject dv(double v) throws Exception { return new JSONObject().put("doubleValue", v); }

    private static String rfc3339(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    private static String hhmm(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("HH:mm", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("Asia/Qatar"));
        return f.format(new Date(ms));
    }

    private static double distance(double lat1, double lng1, double lat2, double lng2) {
        double R = 6371000, dLat = Math.toRadians(lat2 - lat1), dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    private JSONObject cfg() {
        try { String s = prefs.getString("cfg", null); return s == null ? null : new JSONObject(s); } catch (Exception e) { return null; }
    }

    /** phone clock corrected by the server offset measured in the app */
    private long wallNow() {
        JSONObject c = cfg();
        return System.currentTimeMillis() + (c == null ? 0 : c.optLong("skew", 0));
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CH_WATCH, "At the office", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CH_EVENT, "Attendance updates", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private void notifyEvent(String title, String text) {
        try {
            Notification n = new NotificationCompat.Builder(this, CH_EVENT)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setAutoCancel(true)
                    .setContentIntent(openApp())
                    .build();
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NID_EVENT, n);
        } catch (Exception ignored) { }
    }

    private void stopNow() {
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) { }
        try { stopForeground(true); } catch (Exception ignored) { }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) { }
        if (netThread != null) netThread.quitSafely();
        super.onDestroy();
    }

    // Older Android versions call these; nothing to do.
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onProviderDisabled(String provider) { }
}
