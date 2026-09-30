package com.aura.testapp;

import android.os.Bundle;
import android.widget.TextView;

/** Java-активность: проверка диагностики и автоимпорта в Android-проекте. */
public class JavaActivity extends android.app.Activity {

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		TextView view = new TextView(this);
		view.setText("hello");
		view.setTextSize(20f);
		// ContextCompat намеренно без импорта: должен появиться quick fix «Import …».
		int color = ContextCompat.getColor(this, android.R.color.black);
		view.setTextColor(color);
	}
}
