package com.aura.testapp;

import android.widget.TextView;

/** Проверка автодополнения: запрос в позиции сразу после `view.`. */
public class CompletionProbe {
	void probe(TextView view) {
		view.setText("x");
	}
}
