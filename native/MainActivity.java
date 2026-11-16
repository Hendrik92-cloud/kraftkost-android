package de.kraftkost.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KraftPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
