package de.kraftkost.app;

import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import android.net.Uri;
import android.provider.AlarmClock;
import android.provider.CalendarContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;

/** Kalender-Termine, Wecker und Timer über die Standard-Apps von Android. */
@CapacitorPlugin(name = "Kraft")
public class KraftPlugin extends Plugin {

    private void launch(PluginCall call, Intent intent) {
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Keine passende App auf dem Handy gefunden.", "no_app");
        }
    }

    @PluginMethod
    public void addCalendarEvent(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI);
        i.putExtra(CalendarContract.Events.TITLE, call.getString("title", "Kraftkost"));
        String desc = call.getString("description");
        if (desc != null) i.putExtra(CalendarContract.Events.DESCRIPTION, desc);
        String loc = call.getString("location");
        if (loc != null) i.putExtra(CalendarContract.Events.EVENT_LOCATION, loc);
        Double begin = call.getDouble("begin");
        Double end = call.getDouble("end");
        if (begin != null) i.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin.longValue());
        if (end != null) i.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.longValue());
        String rrule = call.getString("rrule");
        if (rrule != null && !rrule.isEmpty()) i.putExtra(CalendarContract.Events.RRULE, rrule);
        launch(call, i);
    }

    @PluginMethod
    public void setAlarm(PluginCall call) {
        Intent i = new Intent(AlarmClock.ACTION_SET_ALARM);
        i.putExtra(AlarmClock.EXTRA_HOUR, call.getInt("hour", 7));
        i.putExtra(AlarmClock.EXTRA_MINUTES, call.getInt("minute", 0));
        i.putExtra(AlarmClock.EXTRA_MESSAGE, call.getString("message", "Kraftkost"));
        JSArray days = call.getArray("days");
        if (days != null && days.length() > 0) {
            ArrayList<Integer> list = new ArrayList<>();
            for (int k = 0; k < days.length(); k++) {
                try { list.add(days.getInt(k)); } catch (Exception ignored) { }
            }
            i.putExtra(AlarmClock.EXTRA_DAYS, list);
        }
        launch(call, i);
    }

    @PluginMethod
    public void sendMail(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"));
        String to = call.getString("to", "");
        if (to != null && !to.trim().isEmpty()) i.putExtra(Intent.EXTRA_EMAIL, to.trim().split("\\s*[,;]\\s*"));
        i.putExtra(Intent.EXTRA_SUBJECT, call.getString("subject", ""));
        i.putExtra(Intent.EXTRA_TEXT, call.getString("body", ""));
        launch(call, i);
    }

    @PluginMethod
    public void setTimer(PluginCall call) {
        Intent i = new Intent(AlarmClock.ACTION_SET_TIMER);
        i.putExtra(AlarmClock.EXTRA_LENGTH, call.getInt("seconds", 90));
        i.putExtra(AlarmClock.EXTRA_MESSAGE, call.getString("message", "Satzpause"));
        i.putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        launch(call, i);
    }

    /** Heruntergeladene APK dem Android-Installer übergeben. */
    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            String path = call.getString("path", "");
            File f = new File(Uri.parse(path).getPath());
            if (!f.exists()) { call.reject("APK nicht gefunden", "missing"); return; }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(s);
                call.reject("Installation nicht erlaubt", "permission");
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Installation konnte nicht starten: " + e.getMessage(), "failed");
        }
    }
}
