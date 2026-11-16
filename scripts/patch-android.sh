#!/usr/bin/env bash
# Ergänzt das von Capacitor erzeugte Android-Projekt um das eigene Plugin,
# Berechtigungen und eine fortlaufende Versionsnummer.
set -euo pipefail

PKG=android/app/src/main/java/de/kraftkost/app
cp native/MainActivity.java native/KraftPlugin.java "$PKG/"

MAN=android/app/src/main/AndroidManifest.xml
perl -0pi -e 's#</manifest>#    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <uses-permission android:name="com.android.alarm.permission.SET_ALARM" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    <queries>\n        <intent><action android:name="android.speech.RecognitionService" /></intent>\n        <intent><action android:name="android.intent.action.INSERT" /><data android:mimeType="vnd.android.cursor.dir/event" /></intent>\n        <intent><action android:name="android.intent.action.SENDTO" /><data android:scheme="mailto" /></intent>\n    </queries>\n</manifest>#' "$MAN"

RUN="${BUILD_NUMBER:-1}"
GRADLE=android/app/build.gradle
sed -i -E "s/versionCode [0-9]+/versionCode ${RUN}/; s/versionName \"[^\"]*\"/versionName \"1.0.${RUN}\"/" "$GRADLE"

echo "Android-Projekt angepasst (Version 1.0.${RUN})"
