package de.kraftkost.app;

import android.content.Intent;
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
    public void setTimer(PluginCall call) {
        Intent i = new Intent(AlarmClock.ACTION_SET_TIMER);
        i.putExtra(AlarmClock.EXTRA_LENGTH, call.getInt("seconds", 90));
        i.putExtra(AlarmClock.EXTRA_MESSAGE, call.getString("message", "Satzpause"));
        i.putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        launch(call, i);
    }
}
