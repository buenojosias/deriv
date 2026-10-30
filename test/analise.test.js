const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { main, promptMode, collectNextDigits } = require("../analise");

test("aguarda 30 segundos se a maior frequência for menor que 18% e salva 50 dígitos", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "analise-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const frequency = (count) => [
    { digit: 7, count, percentage: count * 2 },
    ...Array.from({ length: 9 }, (_, digit) => ({ digit, count: 0, percentage: 0 })),
  ];
  const base = { count: 50, last10: [], lastTickEpoch: 100 };
  const analyses = [8, 9].map((count) => ({ ...base, frequency: frequency(count) }));
  const waits = [];
  const calls = [];
  const digits = Array.from({ length: 50 }, (_, index) => index % 10);
  const startedAt = new Date(2026, 9, 30, 14, 5, 6);
  const file = await main({
    askMode: async () => "1",
    analyze: async () => analyses.shift(),
    collect: async (symbol, afterEpoch, targetDigit) => { calls.push({ symbol, afterEpoch, targetDigit }); return digits; },
    wait: async (ms) => waits.push(ms),
    directory,
    now: () => startedAt,
  });
  assert.deepEqual(waits, [30_000]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].afterEpoch, 100);
  assert.equal(calls[0].targetDigit, 7);
  assert.equal(path.basename(file), "2026-10-30 14:05:06.txt");
  const report = fs.readFileSync(file, "utf8");
  assert.match(report, /ANÁLISE DOS ÚLTIMOS 50 TICKS/);
  assert.match(report, /Dígito 7:  9x \(18\.0%\) █████████/);
  assert.match(report, /08: 7 ★/);
  assert.match(report, new RegExp(`Sequência exata: ${digits.join(" ")}`));
  assert.equal(report.split(" ★\n").length - 1, 5);
});

test("modo repetido espera um minuto após cada relatório e inicia nova análise", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "analise-repeat-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stop = new Error("interromper teste");
  const waits = [];
  let analyses = 0;
  let prompts = 0;
  await assert.rejects(main({
    askMode: async () => { prompts++; return "2"; },
    analyze: async () => {
      analyses++;
      if (analyses === 3) throw stop;
      return { count: 50, last10: [], lastTickEpoch: analyses,
        frequency: [{ digit: 7, count: 9, percentage: 18 }] };
    },
    collect: async () => Array(50).fill(7),
    wait: async (ms) => waits.push(ms),
    directory,
    now: () => new Date(2026, 9, 30, 14, 5, analyses),
  }), (error) => error === stop);
  assert.equal(prompts, 1);
  assert.deepEqual(waits, [60_000, 60_000]);
  assert.equal(fs.readdirSync(directory).length, 2);
});

test("pergunta o modo novamente quando a escolha é inválida", async () => {
  const answers = ["0", " 2 "];
  let closed = false;
  const choice = await promptMode(() => ({
    question: async () => answers.shift(),
    close: () => { closed = true; },
  }));
  assert.equal(choice, "2");
  assert.equal(answers.length, 0);
  assert.equal(closed, true);
});

test("coleta exatamente os 50 ticks posteriores ao histórico sem enviar compras", async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    constructor() {
      super();
      socket = this;
      this.readyState = 1;
      this.sent = [];
      queueMicrotask(() => this.emit("open"));
    }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; this.emit("close"); }
  }
  const collecting = collectNextDigits("1HZ25V", 100, 7, FakeSocket);
  await Promise.resolve();
  const emitTick = (quote, epoch) => socket.emit("message", JSON.stringify({
    msg_type: "tick", tick: { quote, epoch, pip_size: 2 },
  }));
  emitTick(123.47, 100);
  for (let index = 0; index < 50; index++) emitTick(123.4 + index / 100, 101 + index);
  emitTick(123.49, 151);
  const digits = await collecting;
  assert.equal(digits.length, 50);
  assert.equal(digits[0], 0);
  assert.equal(digits.at(-1), 9);
  assert.deepEqual(socket.sent, [{ ticks: "1HZ25V", subscribe: 1 }]);
});
