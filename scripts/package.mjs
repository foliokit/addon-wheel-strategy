#!/usr/bin/env node
// Packages the addon into an installable zip.
//
// The original `package` script shelled out to `find` and `zip`, which do not
// exist on a stock Windows box. This writes the archive directly with zlib, so
// it needs no dependencies and no Git Bash.
//
// Two things the host is strict about (crates/core/src/addons/service.rs):
//   - the manifest's `main` path must exist in the archive, or extraction
//     fails before permissions are ever analyzed;
//   - archive paths must use forward slashes — backslashes are rejected as
//     unsafe, which is exactly what PowerShell's Compress-Archive emits.
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows path separator, spelled by code point so no escaping games.
const SEP = String.fromCharCode(92);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const dosTime = (d) =>
  ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
const dosDate = (d) =>
  (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function collect() {
  const files = [];
  const add = async (abs) => {
    // Archive paths are always forward-slashed and relative to the package root.
    files.push({ name: relative(root, abs).split(SEP).join('/'), abs });
  };

  await add(join(root, 'manifest.json'));
  for await (const f of walk(join(root, 'dist'))) {
    if (f.endsWith('.map') || f.endsWith('.zip')) continue;
    await add(f);
  }
  for (const optional of ['README.md', 'LICENSE']) {
    try {
      await stat(join(root, optional));
      await add(join(root, optional));
    } catch {
      /* optional */
    }
  }
  return files;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const compressed = deflateRawSync(e.data, { level: 9 });
    const sum = crc32(e.data);
    const when = new Date();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime(when), 10);
    local.writeUInt16LE(dosDate(when), 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime(when), 12);
    central.writeUInt16LE(dosDate(when), 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // Unix mode 0644 in the high 16 bits. Multiply rather than shift: `<<`
    // coerces to int32 and this value overflows into the negatives.
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + compressed.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));

const files = await collect();
const entries = await Promise.all(
  files.map(async (f) => ({ name: f.name, data: await readFile(f.abs) })),
);

// Fail loudly here rather than letting the host report a generic error.
const main = manifest.main.replace(/^\.?\//, '');
if (!entries.some((e) => e.name === main)) {
  console.error(
    `Manifest 'main' is '${manifest.main}' but the archive has no such file.\n` +
      `Run the build first. Files collected:\n  ${entries.map((e) => e.name).join('\n  ')}`,
  );
  process.exit(1);
}

await mkdir(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `${pkg.name}-${pkg.version}.zip`);
await writeFile(out, buildZip(entries));

console.log(`${out}`);
for (const e of entries) console.log(`  ${e.name}  (${e.data.length} bytes)`);
