'use strict';
// Tiny archive writers for tests: a stored (uncompressed) zip, as a wheel or Go module zip is
// read, and a gzipped ustar tarball, as `npm pack` writes. Plus a fake package index: a fetch
// command (FACTORY_DEPS_FETCH_<ECO>) that copies a prepared archive into {dest}, or fails like a
// machine without network.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function zip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, content, opts = {}] of entries) {
    const data = Buffer.from(content);
    const n = Buffer.from(name);
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(((opts.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function tgz(entries) {
  const blocks = [];
  for (const [name, content, opts = {}] of entries) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(opts.type || '0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

// A directory of archives and the fetch commands that serve them: a package is served when
// <dir>/<eco>/<name>-<version>.<ext> exists, else the command fails like pip/npm do offline.
function fakeIndex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const serve = (eco, ext) => `f='${dir}/${eco}/{name}-{version}.${ext}'; if [ -f "$f" ]; then cp "$f" {dest}/; else echo "ERROR: Could not find a version that satisfies the requirement {name}=={version} (network is unreachable)" >&2; exit 1; fi`;
  return {
    dir,
    env: { NODE_ENV: 'test', FACTORY_DEPS_FETCH_PYPI: serve('pypi', 'whl'), FACTORY_DEPS_FETCH_NPM: serve('npm', 'tgz') },
    add(eco, name, version, files) {
      fs.mkdirSync(path.join(dir, eco), { recursive: true });
      const f = path.join(dir, eco, `${name}-${version}.${eco === 'pypi' ? 'whl' : 'tgz'}`);
      fs.writeFileSync(f, eco === 'pypi' ? zip(Object.entries(files)) : tgz(Object.entries(files).map(([n, c]) => [`package/${n}`, c])));
      return f;
    },
  };
}

module.exports = { zip, tgz, fakeIndex };
