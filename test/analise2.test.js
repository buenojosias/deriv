const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main } = require("../analise2");

test("aguarda quando o primeiro e o terceiro dígitos aparecem mais de uma vez", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "analise2-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const frequency = [
    { digit: 7, count: 5, percentage: 10 },
    { digit: 2, count: 5, percentage: 10 },
    { digit: 3, count: 5, percentage: 10 },
  ];
  const analyses = [
    { count: 50, frequency, last10: [7, 7, 3, 3, 2, 2, 2, 2, 2, 2].map((digit) => ({ digit })), lastTickEpoch: 100 },
    { count: 50, frequency, last10: [7, 3, 3, 2, 2, 2, 2, 2, 2, 2].map((digit) => ({ digit })), lastTickEpoch: 101 },
  ];
  const waits = [];
  const calls = [];
  const file = await main({
    askMode: async () => "1",
    analyze: async () => analyses.shift(),
    collect: async (...args) => { calls.push(args); return Array(30).fill(7); },
    wait: async (ms) => waits.push(ms),
    directory,
    now: () => new Date(2026, 9, 30, 14, 5, 6),
  });

  assert.deepEqual(waits, [30_000]);
  assert.deepEqual(calls, [[process.env.DERIV_SYMBOL || "1HZ25V", 101]]);
  const report = fs.readFileSync(file, "utf8");
  assert.match(report, /PRÓXIMOS 30 DÍGITOS/);
  assert.doesNotMatch(report, /★/);
});

test("no modo repetido espera 30 segundos depois do relatório", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "analise2-repeat-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stop = new Error("parar");
  const waits = [];
  let analyses = 0;
  await assert.rejects(main({
    askMode: async () => "2",
    analyze: async () => {
      if (++analyses === 2) throw stop;
      return {
        count: 50,
        frequency: [
          { digit: 7, count: 5, percentage: 10 },
          { digit: 2, count: 5, percentage: 10 },
          { digit: 3, count: 5, percentage: 10 },
        ],
        last10: Array(10).fill({ digit: 2 }),
        lastTickEpoch: 100,
      };
    },
    collect: async () => Array(30).fill(2),
    wait: async (ms) => waits.push(ms),
    directory,
    now: () => new Date(2026, 9, 30, 14, 5, analyses),
  }), (error) => error === stop);
  assert.deepEqual(waits, [30_000]);
});
