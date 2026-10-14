'use strict';
// Simulated clock for the console sample (dev only). Preload it in every process that
// should share the sample's time:
//
//   FACTORY_SAMPLE_CLOCK=/path/offset  NODE_OPTIONS="--require /abs/clock.js"  node …
//
// The file holds one integer: milliseconds to add to the real time. Date.now(), new Date()
// with no arguments and Date() called as a function return real time + that offset, read
// fresh on every call so child processes see the driver's advances at once. Dates built
// from explicit arguments, performance.now() and timers are untouched.
//
// The driver also uses the exported helpers to move the clock (only forward).

const fs = require('fs');

const FILE = process.env.FACTORY_SAMPLE_CLOCK || null;
const RealDate = global.__factorySampleRealDate || Date;
const realNow = () => RealDate.now();

function readOffset() {
  if (!FILE) return 0;
  try {
    const n = parseInt(fs.readFileSync(FILE, 'utf8'), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const now = () => realNow() + readOffset();

if (FILE && !global.__factorySampleRealDate) {
  global.__factorySampleRealDate = RealDate;
  function SimDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length ? args : [now()], new.target);
  }
  SimDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(SimDate, RealDate);
  SimDate.now = now;
  SimDate.parse = RealDate.parse;
  SimDate.UTC = RealDate.UTC;
  Object.defineProperty(SimDate, 'name', { value: 'Date' });
  global.Date = SimDate;
}

// ---- driver helpers ------------------------------------------------------------
function writeOffset(off) {
  if (!FILE) throw new Error('FACTORY_SAMPLE_CLOCK is not set');
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, String(Math.round(off)));
  fs.renameSync(tmp, FILE); // atomic: a reader never sees a half-written number
}

// Never past real now (minus a margin), never backwards.
function setTo(ms, { margin = 60 * 1000 } = {}) {
  const cap = realNow() - margin;
  const target = Math.min(Math.max(ms, now()), cap);
  writeOffset(target - realNow());
  return target;
}

const advance = (ms, opts) => setTo(now() + ms, opts);

module.exports = { now, realNow, setTo, advance, writeOffset, RealDate };
