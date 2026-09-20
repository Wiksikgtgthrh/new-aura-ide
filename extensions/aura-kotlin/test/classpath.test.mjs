/**
 * Тест парсеров classpath (Этап 3). Запуск: node test/classpath.test.mjs
 * Модуль vscode подменяется стабом через hook на Module._resolveFilename.
 */
const Module = (await import('node:module')).default;
const path = (await import('node:path')).default;
const { fileURLToPath } = await import('node:url');
const here = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.join(here, 'node_modules', 'vscode');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'vscode') { request = stubPath; }
	return origResolve.call(this, request, ...args);
};
const { parseGradle, parsePom, resolveJars, parseSettingsIncludes, extractGradleVariables, compileSdkOf, parseGradleClasspathOutput } = (await import(new URL('../out/classpath.js', import.meta.url))).default ?? await import(new URL('../out/classpath.js', import.meta.url));

const gradleKts = `
dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    testImplementation("junit:junit:4.13.2")
    compileOnly("org.projectlombok:lombok:1.18.30")
}
`;
const gradleGroovy = `
dependencies {
    implementation 'com.google.code.gson:gson:2.10.1'
    api group: 'org.apache.commons', name: 'commons-lang3', version: '3.14.0'
}
`;
const pom = `<project>
  <properties><kotlin.version>2.1.0</kotlin.version></properties>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-bom</artifactId><version>2.17.0</version></dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>\${kotlin.version}</version></dependency>
    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
  </dependencies>
</project>`;

console.log('gradle.kts:', parseGradle(gradleKts).map(d => `${d.group}:${d.artifact}:${d.version}[${d.scope}]`));
console.log('gradle groovy:', parseGradle(gradleGroovy).map(d => `${d.group}:${d.artifact}:${d.version}[${d.scope}]`));
console.log('pom:', parsePom(pom).map(d => `${d.group}:${d.artifact}:${d.version}[${d.scope}]`));
const res = resolveJars([{ group: 'junit', artifact: 'junit', version: '4.13.2', scope: 'test' }]);
console.log('junit:', res.jars.length ? 'RESOLVED ' + res.jars[0] : 'not in local caches (ok)');

// ---------- Этап 1 ТЗ: version catalogs, variables, settings, init-script output ----------

// Version catalog: libs.core.ktx → координаты из gradle/libs.versions.toml.
const catalog = new Map([
	['core-ktx', { module: 'androidx.core:core-ktx', version: '1.15.0' }],
	['core.ktx', { module: 'androidx.core:core-ktx', version: '1.15.0' }],
]);
const catalogDeps = parseGradle('dependencies {\n    implementation(libs.core.ktx)\n}', { catalog });
console.log('catalog:', catalogDeps.map(d => `${d.group}:${d.artifact}:${d.version}[${d.scope}]`));
if (catalogDeps[0]?.group !== 'androidx.core' || catalogDeps[0]?.version !== '1.15.0') { throw new Error('catalog resolution failed'); }

// Переменные версий: ext-блок и def.
const vars = extractGradleVariables('ext {\n    kotlinVersion = "2.1.0"\n}\ndef appcompatVer = "1.7.0"');
const varDeps = parseGradle(`dependencies {\n    implementation("org.jetbrains.kotlin:kotlin-stdlib:\${kotlinVersion}")\n    implementation("androidx.appcompat:appcompat:\$appcompatVer")\n}`, { localVariables: vars });
console.log('variables:', varDeps.map(d => `${d.group}:${d.artifact}:${d.version}[${d.scope}]`));
if (varDeps[0]?.version !== '2.1.0' || varDeps[1]?.version !== '1.7.0') { throw new Error('variable resolution failed'); }

// settings.gradle(.kts): include ':app', include(":feature:login").
const includes = parseSettingsIncludes('include ":app", ":feature:login"\ninclude(":core")');
console.log('settings:', includes);
if (includes.join(',') !== ':app,:feature:login,:core') { throw new Error('settings parse failed'); }

// compileSdk из build-файла.
if (compileSdkOf('android { compileSdk = 35 }') !== 35 || compileSdkOf('compileSdkVersion 33') !== 33) { throw new Error('compileSdk parse failed'); }
console.log('compileSdk: ok');

// Разбор вывода init-скрипта Gradle: jar по модулям + applicationId + android.jar.
const fs = (await import('node:fs')).default;
const os = (await import('node:os')).default;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cp-test-'));
fs.mkdirSync(path.join(root, 'app'));
fs.writeFileSync(path.join(root, 'root1.jar'), 'x');
fs.writeFileSync(path.join(root, 'app', 'app1.jar'), 'x');
const modules = [
	{ dir: root, buildFile: path.join(root, 'build.gradle.kts'), gradle: true },
	{ dir: path.join(root, 'app'), buildFile: path.join(root, 'app', 'build.gradle.kts'), gradle: true },
];
const parsed = parseGradleClasspathOutput(
	[
		'===AURA-CP :', path.join(root, 'root1.jar'), 'AURA-APPID : com.example.root',
		'===AURA-CP :app', path.join(root, 'app', 'app1.jar'), 'AURA-APPID :app com.example.app',
		'not-a-jar.txt',
	].join('\n'),
	modules,
	root,
);
console.log('gradle output:', parsed.jars.length, 'jars, appIds:', parsed.modules.map(m => m.applicationId));
if (parsed.jars.length !== 2 || parsed.modules[1]?.applicationId !== 'com.example.app') { throw new Error('init-script output parse failed'); }
fs.rmSync(root, { recursive: true, force: true });
console.log('init-script output: ok');
