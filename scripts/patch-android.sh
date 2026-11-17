#!/usr/bin/env bash
# Ergänzt das von Capacitor erzeugte Android-Projekt um das eigene Plugin,
# Berechtigungen und eine fortlaufende Versionsnummer.
set -euo pipefail

PKG=android/app/src/main/java/de/kraftkost/app
cp native/MainActivity.java native/KraftPlugin.java "$PKG/"

MAN=android/app/src/main/AndroidManifest.xml
perl -0pi -e 's#</manifest>#    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <uses-permission android:name="com.android.alarm.permission.SET_ALARM" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />\n    <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" android:maxSdkVersion="32" />\n    <queries>\n        <intent><action android:name="android.speech.RecognitionService" /></intent>\n        <intent><action android:name="android.intent.action.INSERT" /><data android:mimeType="vnd.android.cursor.dir/event" /></intent>\n        <intent><action android:name="android.intent.action.SENDTO" /><data android:scheme="mailto" /></intent>\n    </queries>\n</manifest>#' "$MAN"

# Health Connect (Schritte und Sport-Kalorien von der Uhr): Begründungsseite für die
# Berechtigung und der Eintrag, über den Android 14+ die Nutzung anzeigt. Health Connect gibt es ab Android 8.
perl -0pi -e 's#(\s*<intent-filter>\s*<action android:name="android.intent.action.MAIN" />)#\n            <intent-filter>\n                <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />\n            </intent-filter>\1#' "$MAN"
perl -0pi -e 's#(\s*</application>)#\n        <activity-alias android:name="ViewPermissionUsageActivity" android:exported="true" android:targetActivity=".MainActivity" android:permission="android.permission.START_VIEW_PERMISSION_USAGE">\n            <intent-filter>\n                <action android:name="android.intent.action.VIEW_PERMISSION_USAGE" />\n                <category android:name="android.intent.category.HEALTH_PERMISSIONS" />\n            </intent-filter>\n        </activity-alias>\1#' "$MAN"
perl -0pi -e 's#</queries>#    <package android:name="com.google.android.apps.healthdata" />\n    </queries>#' "$MAN"
sed -i -E "s/minSdkVersion = [0-9]+/minSdkVersion = 26/" android/variables.gradle

RUN="${BUILD_NUMBER:-1}"
GRADLE=android/app/build.gradle
sed -i -E "s/versionCode [0-9]+/versionCode ${RUN}/; s/versionName \"[^\"]*\"/versionName \"1.0.${RUN}\"/" "$GRADLE"

echo "Android-Projekt angepasst (Version 1.0.${RUN})"
