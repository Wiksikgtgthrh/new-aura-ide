/*---------------------------------------------------------------------------------------------
 *  Aura Kotlin — мастера создания проектов и файлов.
 *  New Project: Kotlin CLI (kotlinc), Java (Gradle), Android (Gradle-структура с
 *  pluginManagement/repositories — собирается сразу, без правок). New File: шаблоны
 *  Kotlin-класса, main-файла, Activity (+ layout), Fragment (+ layout), layout/values XML.
 *  Пакет и папки Android-проекта определяются из app/build.gradle.kts (namespace).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tr } from './l10n';

export function registerProjectWizard(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('auraKotlin.newProject', (folder?: vscode.Uri) => newProject(folder)),
		vscode.commands.registerCommand('auraKotlin.newFile', (target?: vscode.Uri) => newFile(target)),
	);
}

// ---------- New Project ----------

async function newProject(folder?: vscode.Uri): Promise<void> {
	const target = folder ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: tr('Create project here') }))?.[0];
	if (!target) { return; }
	const namePick = await vscode.window.showInputBox({ prompt: tr('Project name'), value: 'MyApp' });
	if (!namePick) { return; }
	const kind = await vscode.window.showQuickPick([
		{ label: '$(rocket) Kotlin CLI (kotlinc + JVM)', id: 'cli' },
		{ label: '$(coffee) Java (Gradle)', id: 'java' },
		{ label: '$(device-mobile) Android (Gradle)', id: 'android' },
	], { placeHolder: tr('Project type') });
	if (!kind) { return; }
	const root = vscode.Uri.joinPath(target, namePick);
	const pkg = namePick.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';

	if (kind.id === 'cli') {
		// Простой CLI-проект: src/Main.kt, компилируется kotlinc без Gradle.
		const src = vscode.Uri.joinPath(root, 'src');
		await vscode.workspace.fs.createDirectory(src);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(src, 'Main.kt'), Buffer.from(`fun main() {\n\tprintln("Hello, ${namePick}!")\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'README.md'), Buffer.from(`# ${namePick}\n\nBuild: kotlinc src/Main.kt -include-runtime -d app.jar && java -jar app.jar\n`, 'utf8'));
	} else if (kind.id === 'java') {
		// Java + Gradle: минимальный application-проект.
		const javaDir = vscode.Uri.joinPath(root, 'src', 'main', 'java', 'com', 'example', pkg);
		await vscode.workspace.fs.createDirectory(javaDir);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'settings.gradle.kts'), Buffer.from(`rootProject.name = "${namePick}"\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'build.gradle.kts'), Buffer.from(`plugins {\n\tjava\n\tapplication\n}\n\nrepositories {\n\tmavenCentral()\n}\n\napplication {\n\tmainClass.set("com.example.${pkg}.Main")\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(javaDir, 'Main.java'), Buffer.from(`package com.example.${pkg};\n\npublic class Main {\n\tpublic static void main(String[] args) {\n\t\tSystem.out.println("Hello, ${namePick}!");\n\t}\n}\n`, 'utf8'));
	} else {
		// Android-структура как в IntelliJ: pluginManagement + repositories, чтобы Gradle нашёл AGP сразу.
		const mainDir = vscode.Uri.joinPath(root, 'app', 'src', 'main', 'kotlin', 'com', 'example', pkg);
		const resDir = vscode.Uri.joinPath(root, 'app', 'src', 'main', 'res', 'values');
		await vscode.workspace.fs.createDirectory(mainDir);
		await vscode.workspace.fs.createDirectory(resDir);
		const activity = namePick.replace(/[^A-Za-z0-9]/g, '').replace(/^./, c => c.toUpperCase()) || 'Main';
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'settings.gradle.kts'), Buffer.from(
			`pluginManagement {\n\trepositories {\n\t\tgoogle()\n\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}\n}\n\ndependencyResolutionManagement {\n\trepositories {\n\t\tgoogle()\n\t\tmavenCentral()\n\t}\n}\n\nrootProject.name = "${namePick}"\ninclude(":app")\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'build.gradle.kts'), Buffer.from(
			`plugins {\n\tid("com.android.application") version "8.7.2" apply false\n\tid("org.jetbrains.kotlin.android") version "2.1.0" apply false\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'gradle.properties'), Buffer.from(
			`org.gradle.jvmargs=-Xmx2g\nandroid.useAndroidX=true\nkotlin.code.style=official\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'app', 'build.gradle.kts'), Buffer.from(
			`plugins {\n\tid("com.android.application")\n\tid("org.jetbrains.kotlin.android")\n}\n\nandroid {\n\tnamespace = "com.example.${pkg}"\n\tcompileSdk = 35\n\tdefaultConfig {\n\t\tapplicationId = "com.example.${pkg}"\n\t\tminSdk = 24\n\t\ttargetSdk = 35\n\t}\n}\n\ndependencies {\n\timplementation("androidx.core:core-ktx:1.15.0")\n\timplementation("androidx.appcompat:appcompat:1.7.0")\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'app', 'src', 'main', 'AndroidManifest.xml'), Buffer.from(
			`<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n\t<application android:label="${namePick}" android:theme="@style/Theme.AppCompat">\n\t\t<activity android:name=".${activity}Activity" android:exported="true">\n\t\t\t<intent-filter>\n\t\t\t\t<action android:name="android.intent.action.MAIN" />\n\t\t\t\t<category android:name="android.intent.category.LAUNCHER" />\n\t\t\t</intent-filter>\n\t\t</activity>\n\t</application>\n</manifest>\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(mainDir, `${activity}Activity.kt`), Buffer.from(
			`package com.example.${pkg}\n\nimport android.os.Bundle\nimport androidx.appcompat.app.AppCompatActivity\n\nclass ${activity}Activity : AppCompatActivity() {\n\toverride fun onCreate(savedInstanceState: Bundle?) {\n\t\tsuper.onCreate(savedInstanceState)\n\t}\n}\n`, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(resDir, 'strings.xml'), Buffer.from(
			`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n\t<string name="app_name">${namePick}</string>\n</resources>\n`, 'utf8'));
	}

	const open = await vscode.window.showInformationMessage(tr('Project \'{0}\' created.', namePick), tr('Open folder'));
	if (open) { await vscode.commands.executeCommand('vscode.openFolder', root); }
}

// ---------- New File ----------

interface AndroidDirs { kotlinDir: vscode.Uri; resDir: vscode.Uri; pkg: string; }

/** Папки и пакет Android-модуля: namespace из app/build.gradle.kts, иначе manifest, иначе дефолт. */
async function detectAndroidModule(root: vscode.Uri): Promise<AndroidDirs | undefined> {
	const read = async (uri: vscode.Uri) => { try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { return undefined; } };
	for (const moduleDir of ['app', '']) {
		const mainDir = moduleDir ? vscode.Uri.joinPath(root, moduleDir, 'src', 'main') : vscode.Uri.joinPath(root, 'src', 'main');
		try { await vscode.workspace.fs.stat(mainDir); } catch { continue; }
		const moduleRoot = moduleDir ? vscode.Uri.joinPath(root, moduleDir) : root;
		const gradle = await read(vscode.Uri.joinPath(moduleRoot, 'build.gradle.kts')) ?? await read(vscode.Uri.joinPath(moduleRoot, 'build.gradle')) ?? '';
		const manifest = await read(vscode.Uri.joinPath(mainDir, 'AndroidManifest.xml')) ?? '';
		const pkg = /namespace\s*=?\s*"([\w.]+)"/.exec(gradle)?.[1]
			?? /package\s*=\s*"([\w.]+)"/.exec(manifest)?.[1]
			?? 'com.example.app';
		return {
			kotlinDir: vscode.Uri.joinPath(mainDir, 'kotlin', ...pkg.split('.')),
			resDir: vscode.Uri.joinPath(mainDir, 'res'),
			pkg,
		};
	}
	return undefined;
}

/** MainActivity → activity_main (snake_case без суффикса). */
function layoutName(className: string, suffix: 'activity' | 'fragment'): string {
	const base = className.replace(new RegExp(`${suffix}$`, 'i'), '') || 'main';
	return `${suffix}_` + base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

async function writeNew(uri: vscode.Uri, content: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		void vscode.window.showErrorMessage(tr('File {0} already exists.', uri.fsPath.split(/[\\/]/).pop() ?? ''));
		return false;
	} catch { /* файла нет — создаём */ }
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc);
	return true;
}

async function newFile(target?: vscode.Uri): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		void vscode.window.showWarningMessage(tr('Open a workspace first.'));
		return;
	}
	const android = await detectAndroidModule(root);

	const kinds = [
		{ label: '$(symbol-class) Kotlin class', id: 'kt-class' },
		{ label: '$(play) Kotlin file with main()', id: 'kt-main' },
		...(android ? [
			{ label: '$(device-mobile) Android Activity (+ layout)', id: 'activity' },
			{ label: '$(symbol-snippet) Android Fragment (+ layout)', id: 'fragment' },
			{ label: '$(layout) Layout XML', id: 'layout' },
			{ label: '$(symbol-string) values/strings.xml', id: 'values' },
		] : []),
	];
	const kind = await vscode.window.showQuickPick(kinds, { placeHolder: tr('File template') });
	if (!kind) { return; }

	const kotlinBase = target ?? android?.kotlinDir ?? vscode.Uri.joinPath(root, 'src');

	if (kind.id === 'values' && android) {
		const valuesDir = vscode.Uri.joinPath(android.resDir, 'values');
		await vscode.workspace.fs.createDirectory(valuesDir);
		await writeNew(vscode.Uri.joinPath(valuesDir, 'strings.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n\t<string name="app_name">App</string>\n</resources>\n`);
		return;
	}

	const isLayout = kind.id === 'layout';
	const name = await vscode.window.showInputBox({
		prompt: isLayout ? tr('Layout name (e.g. activity_main)') : tr('Class / file name'),
		value: isLayout ? 'activity_main' : 'MyClass',
		validateInput: value => (isLayout ? /^[a-z][a-z0-9_]*$/ : /^[A-Za-z_]\w*$/).test(value.trim()) ? undefined : tr('Invalid name'),
	});
	if (!name) { return; }
	const clean = name.trim();

	switch (kind.id) {
		case 'kt-class': {
			const pkg = android ? `package ${android.pkg}\n\n` : '';
			await writeNew(vscode.Uri.joinPath(kotlinBase, `${clean}.kt`), `${pkg}class ${clean} {\n\t\n}\n`);
			break;
		}
		case 'kt-main': {
			const pkg = android ? `package ${android.pkg}\n\n` : '';
			await writeNew(vscode.Uri.joinPath(kotlinBase, `${clean}.kt`), `${pkg}fun main() {\n\tprintln("Hello from ${clean}")\n}\n`);
			break;
		}
		case 'activity': case 'fragment': {
			if (!android) { return; }
			const layout = layoutName(clean, kind.id);
			const layoutDir = vscode.Uri.joinPath(android.resDir, 'layout');
			await vscode.workspace.fs.createDirectory(layoutDir);
			await writeNew(vscode.Uri.joinPath(layoutDir, `${layout}.xml`),
				`<?xml version="1.0" encoding="utf-8"?>\n<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\n\tandroid:layout_width="match_parent"\n\tandroid:layout_height="match_parent"\n\tandroid:orientation="vertical">\n\n</LinearLayout>\n`);
			const body = kind.id === 'activity'
				? `package ${android.pkg}\n\nimport android.os.Bundle\nimport androidx.appcompat.app.AppCompatActivity\n\nclass ${clean} : AppCompatActivity() {\n\toverride fun onCreate(savedInstanceState: Bundle?) {\n\t\tsuper.onCreate(savedInstanceState)\n\t\tsetContentView(R.layout.${layout})\n\t}\n}\n`
				: `package ${android.pkg}\n\nimport android.os.Bundle\nimport android.view.View\nimport androidx.fragment.app.Fragment\n\nclass ${clean} : Fragment(R.layout.${layout}) {\n\toverride fun onViewCreated(view: View, savedInstanceState: Bundle?) {\n\t\tsuper.onViewCreated(view, savedInstanceState)\n\t}\n}\n`;
			await writeNew(vscode.Uri.joinPath(kotlinBase, `${clean}.kt`), body);
			void vscode.window.showInformationMessage(tr('Created {0}.kt and res/layout/{1}.xml', clean, layout));
			break;
		}
		case 'layout': {
			if (!android) { return; }
			const layoutDir = vscode.Uri.joinPath(android.resDir, 'layout');
			await vscode.workspace.fs.createDirectory(layoutDir);
			await writeNew(vscode.Uri.joinPath(layoutDir, `${clean}.xml`),
				`<?xml version="1.0" encoding="utf-8"?>\n<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\n\tandroid:layout_width="match_parent"\n\tandroid:layout_height="match_parent"\n\tandroid:orientation="vertical">\n\n</LinearLayout>\n`);
			break;
		}
	}
}
