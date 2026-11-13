#!/usr/bin/env node
/**
 * water.mjs — ставит океан/небо/мир Ultra-Water (Humpalumps, MIT) в трехмерный
 * проект на three.js одной командой.
 *
 *   node ~/.agent-harness/tools/water.mjs [projectDir] [--force] [--dry]
 *
 * Что делает:
 *   1) копирует эталонные модули движка в <project>/src/uw/ (с LICENSE и
 *      THIRD_PARTY_NOTICES — атрибуция обязательна по MIT);
 *   2) кладёт интеграционный слой <project>/src/world/world.ts и страницу
 *      проверки uw-check.html + src/uwcheck.ts;
 *   3) правит package.json (three r186), tsconfig.json (allowJs/checkJs)
 *      и vite.config (алиас three/addons → three/examples/jsm).
 *
 * Ничего не перезаписывает без --force. Печатает каждый шаг.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ассеты лежат рядом с инструментом: install.mjs кладёт дерево tools целиком,
// поэтому payload переезжает в любой рантайм вместе с инструментом
const ASSETS = path.join(HERE, 'water-assets');
const THREE_VERSION = '^0.186.1';
const TYPES_VERSION = '^0.186.0';
const ALIAS_LINE =
  "    alias: { 'three/addons': fileURLToPath(new URL('./node_modules/three/examples/jsm', import.meta.url)) },";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const root = path.resolve(positional[0] ?? process.cwd());
const FORCE = flags.has('--force');
const DRY = flags.has('--dry');

const log = (msg) => console.log(`  ${msg}`);
const head = (msg) => console.log(`\n${msg}`);

let failed = false;
const warn = (msg) => {
  failed = true;
  console.log(`  ! ${msg}`);
};

function copyFile(rel, destRel) {
  const src = path.join(ASSETS, rel);
  const dest = path.join(root, destRel);
  if (fs.existsSync(dest) && !FORCE) {
    log(`есть, оставляю: ${destRel}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  log(`скопировал: ${destRel}`);
}

function copyTree(rel, destRel) {
  const src = path.join(ASSETS, rel);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = `${rel}/${entry.name}`;
    const to = `${destRel}/${entry.name}`;
    if (entry.isDirectory()) copyTree(from, to);
    else copyFile(from, to);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// --- проверки -------------------------------------------------------------

if (!fs.existsSync(root)) {
  console.error(`Каталог проекта не найден: ${root}`);
  process.exit(1);
}
if (!fs.existsSync(ASSETS)) {
  console.error(`Нет эталонных ассетов: ${ASSETS}`);
  process.exit(1);
}
const pkgPath = path.join(root, 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error(`Это не проект Node: нет package.json в ${root}`);
  process.exit(1);
}

console.log(`Ultra-Water → ${root}${DRY ? '  (пробный прогон)' : ''}`);

if (DRY) {
  head('Что будет сделано:');
  log('src/uw/** (движок), src/world/world.ts, uw-check.html, src/uwcheck.ts');
  log(`package.json: three → ${THREE_VERSION}`);
  log('tsconfig.json: allowJs + checkJs=false');
  log('vite.config: алиас three/addons');
  process.exit(0);
}

// --- 1. код движка --------------------------------------------------------

head('1. Движок (src/uw)');
copyTree('uw', 'src/uw');

// --- 2. интеграция и проверка --------------------------------------------

head('2. Интеграция');
copyFile('world.ts', 'src/world/world.ts');
copyFile('uwcheck.ts', 'src/uwcheck.ts');
copyFile('uw-check.html', 'uw-check.html');

// --- 3. package.json -----------------------------------------------------

head('3. package.json');
const pkg = readJson(pkgPath);
if (!pkg) {
  warn('package.json не разобрался как JSON — пропишите зависимость вручную');
} else {
  pkg.dependencies = pkg.dependencies ?? {};
  if (pkg.dependencies.three === THREE_VERSION) log(`three уже ${THREE_VERSION}`);
  else {
    pkg.dependencies.three = THREE_VERSION;
    log(`three → ${THREE_VERSION}`);
  }
  if (pkg.devDependencies && pkg.devDependencies['@types/three']) {
    pkg.devDependencies['@types/three'] = TYPES_VERSION;
    log(`@types/three → ${TYPES_VERSION}`);
  }
  const nextPkg = JSON.stringify(pkg, null, 2) + '\n';
  if (nextPkg === fs.readFileSync(pkgPath, 'utf8')) log('package.json уже в порядке');
  else fs.writeFileSync(pkgPath, nextPkg);
}

// --- 4. tsconfig.json ----------------------------------------------------

head('4. tsconfig.json');
const tsPath = ['tsconfig.json', 'tsconfig.app.json']
  .map((f) => path.join(root, f))
  .find((f) => fs.existsSync(f));
if (!tsPath) {
  warn('tsconfig не найден — если проект на TypeScript, добавьте allowJs и checkJs=false');
} else {
  const raw = fs.readFileSync(tsPath, 'utf8');
  if (/"allowJs"\s*:\s*true/.test(raw) && /"checkJs"\s*:\s*false/.test(raw)) {
    log(`уже настроен: ${path.basename(tsPath)}`);
  } else {
    let next = raw;
    if (/"compilerOptions"\s*:\s*\{/.test(next)) {
      next = next.replace(
        /"compilerOptions"\s*:\s*\{/,
        '"compilerOptions": {\n    "allowJs": true,\n    "checkJs": false,',
      );
      fs.writeFileSync(tsPath, next);
      log(`allowJs + checkJs=false → ${path.basename(tsPath)}`);
    } else {
      warn(`${path.basename(tsPath)}: не нашёл compilerOptions — добавьте allowJs/checkJs вручную`);
    }
  }
}

// --- 5. vite.config ------------------------------------------------------

head('5. vite.config');
const vitePath = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
  .map((f) => path.join(root, f))
  .find((f) => fs.existsSync(f));

if (!vitePath) {
  const file = path.join(root, 'vite.config.ts');
  fs.writeFileSync(
    file,
    `import { defineConfig } from 'vite';\nimport { fileURLToPath } from 'node:url';\n\nexport default defineConfig({\n  resolve: {\n${ALIAS_LINE}\n  },\n});\n`,
  );
  log('создал vite.config.ts с алиасом three/addons');
} else {
  const raw = fs.readFileSync(vitePath, 'utf8');
  if (raw.includes('three/addons')) {
    log(`алиас уже есть: ${path.basename(vitePath)}`);
  } else if (/resolve\s*:\s*\{/.test(raw)) {
    let next = raw.replace(/resolve\s*:\s*\{/, `resolve: {\n${ALIAS_LINE}`);
    if (!/from 'node:url'/.test(next)) {
      next = `import { fileURLToPath } from 'node:url';\n` + next;
    }
    fs.writeFileSync(vitePath, next);
    log(`алиас three/addons → ${path.basename(vitePath)}`);
  } else {
    // Нет блока resolve — вставляем его в объект конфига.
    const cfgMatch = /defineConfig\(\s*\{/.exec(raw) ?? /export\s+default\s*\{/.exec(raw);
    if (cfgMatch) {
      const at = cfgMatch.index + cfgMatch[0].length;
      let next = `${raw.slice(0, at)}\n  resolve: {\n${ALIAS_LINE}\n  },${raw.slice(at)}`;
      if (!/from 'node:url'/.test(next)) {
        next = `import { fileURLToPath } from 'node:url';\n` + next;
      }
      fs.writeFileSync(vitePath, next);
      log(`добавил resolve + алиас three/addons → ${path.basename(vitePath)}`);
    } else {
      warn(
        `${path.basename(vitePath)}: не разобрал конфиг — добавьте вручную:\n` +
          `      resolve: {\n${ALIAS_LINE}\n      },`,
      );
    }
  }
}

// --- итог ----------------------------------------------------------------

head('Дальше:');
log(`cd ${root} && npm install`);
log('npm run dev  →  откройте /uw-check.html (изолированная проверка движка)');
log('затем подключите свой слой: import { World } from "./world/world"');
console.log(`
  Лицензия: MIT. В src/uw/ уже лежат LICENSE и THIRD_PARTY_NOTICES.md —
  не удаляйте их: внутри credit'ы three.js (AgX), D. Hoskins (hash),
  S. Hillaire (атмосфера).`);

process.exit(failed ? 2 : 0);
