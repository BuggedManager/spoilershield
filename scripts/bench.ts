/** Detection-engine micro-benchmarks (Node, V8). `npm run bench` */
import { createDetector } from '../src/detection';
import { normalize } from '../src/detection/normalize';
import { DEFAULT_SETTINGS } from '../src/storage/settings';

const time = (label: string, n: number, fn: (i: number) => void) => {
  for (let i = 0; i < Math.min(n, 200); i++) fn(i); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const per = (performance.now() - t0) / n;
  console.log(`${label.padEnd(46)} ${per < 0.1 ? (per * 1000).toFixed(1) + ' µs' : per.toFixed(3) + ' ms'}`);
};

let t0 = performance.now();
const det = createDetector(DEFAULT_SETTINGS);
console.log(`${'build detector (index + fuzzy, strict)'.padEnd(46)} ${(performance.now() - t0).toFixed(2)} ms  (${det.termCount} terms)`);
t0 = performance.now();
createDetector({ ...DEFAULT_SETTINGS, extendedDetection: false });
console.log(`${'build detector (extended off)'.padEnd(46)} ${(performance.now() - t0).toFixed(2)} ms`);

const card = (i: number) => `Video ${i}: speedrun world record attempt — Channel ${i} • ${i}K views • 2 days ago`;
const bad = (i: number) => `GTA 6 leaked gameplay part ${i} — Leaks ${i} • ${i}K views`;
const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ';

time('normalize, 100-char card', 20000, (i) => normalize(card(i)));
time('evaluate, 100-char safe card (uncached)', 20000, (i) => det.evaluate(card(i)));
time('evaluate, 100-char GTA card (uncached)', 20000, (i) => det.evaluate(bad(i)));
time('evaluate, cached repeat', 50000, () => det.evaluate(card(1)));
time('evaluate, 2 KB paragraph block (uncached)', 3000, (i) => det.evaluate(para.repeat(20) + i));
time('evaluate, 20 KB page section (uncached)', 300, (i) => det.evaluate(para.repeat(200) + i));
time('evaluate, obfuscated "G.T.Λ VI" title', 20000, (i) => det.evaluate(`G.T.Λ VI map ${i}`));

// diverse vocabulary (defeats the per-word miss cache): pseudo-random words
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const word = () => Array.from({ length: 3 + Math.floor(rnd() * 9) }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join('');
const diverse = Array.from({ length: 300 }, () => Array.from({ length: 330 }, word).join(' '));
time('evaluate, 2 KB block, all-new random words', 300, (i) => det.evaluate(diverse[i].slice(0, 2048)));
