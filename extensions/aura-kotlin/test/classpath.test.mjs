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
const { parseGradle, parsePom, resolveJars } = (await import(new URL('../out/classpath.js', import.meta.url))).default ?? await import(new URL('../out/classpath.js', import.meta.url));

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
