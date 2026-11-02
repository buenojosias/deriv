const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DERIV_API_TOKEN = "teste";
process.env.DERIV_APP_ID = "123";
process.env.DERIV_ACCOUNT_ID = "DOT123";
const { DerivTrader, CONFIG, selectTargetDigit, waitForTarget, formatReportFilename } = require("../trade2");

function analysis(firstCount, thirdCount) {
  const last10 = [
    ...Array(firstCount).fill({ digit: 1 }),
    ...Array(thirdCount).fill({ digit: 3 }),
  ];
  while (last10.length < 10) last10.push({ digit: 8 });
  return { count: 50, frequency: [
    { digit: 1, count: 10, percentage: 20 },
    { digit: 2, count: 8, percentage: 16 },
    { digit: 3, count: 7, percentage: 14 },
  ], last10 };
}

test("seleciona a terceira posição se algum candidato estiver ausente", () => {
  assert.equal(selectTargetDigit(analysis(0, 1)), 3);
  assert.equal(selectTargetDigit(analysis(1, 0)), 3);
  assert.equal(selectTargetDigit(analysis(0, 0)), 3);
});

test("seleciona a primeira posição quando ambos aparecem uma vez", () => {
  assert.equal(selectTargetDigit(analysis(1, 1)), 1);
});

test("anula e reanalisa após 30 segundos quando um candidato aparece mais de uma vez", async () => {
  assert.equal(selectTargetDigit(analysis(2, 0)), null);
  assert.equal(selectTargetDigit(analysis(0, 2)), null);
  const analyses = [analysis(2, 1), analysis(1, 1)];
  const delays = [];
  const selected = await waitForTarget(async () => analyses.shift(), async (ms) => delays.push(ms));
  assert.equal(selected.targetDigit, 1);
  assert.deepEqual(delays, [30_000]);
});

test("inicia a primeira compra assim que recebe o saldo", async () => {
  const trader = new DerivTrader(3, analysis(0, 1));
  const sent = [];
  trader.ws = { readyState: 1, send: (message, callback) => { sent.push(JSON.parse(message)); callback(); } };
  trader.handleMessage({ msg_type: "balance", balance: { balance: 100, currency: "USD" } });
  await trader.sendQueue;
  assert.equal(trader.state, "TRADING");
  assert.equal(trader.current_attempt, 1);
  assert.equal(sent[0].buy, "1");
  assert.equal(sent[0].parameters.barrier, "3");
  assert.equal(sent[1].ticks, CONFIG.symbol);
});

test("reinicia automaticamente após nova análise elegível", async () => {
  const trader = new DerivTrader(3, analysis(0, 1));
  const sent = [];
  trader.ws = { readyState: 1, send: (message, callback) => { sent.push(JSON.parse(message)); callback(); } };
  trader.currency = "USD";
  trader.state = "STOPPED";
  trader.awaiting_restart = true;
  await trader.askRestart({ analyze: async () => analysis(1, 1) });
  await trader.sendQueue;
  assert.equal(trader.target_digit, 1);
  assert.equal(trader.state, "TRADING");
  assert.equal(sent[0].parameters.barrier, "1");
  assert.equal(trader.awaiting_restart, false);
});

test("salva relatório sem contagem com o nome da data local", (t) => {
  const trader = new DerivTrader(3, analysis(0, 1));
  trader.results_directory = fs.mkdtempSync(path.join(os.tmpdir(), "trade2-results-"));
  t.after(() => fs.rmSync(trader.results_directory, { recursive: true, force: true }));
  trader.currency = "USD";
  trader.generateFinalReport();
  const files = fs.readdirSync(trader.results_directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.txt$/);
  assert.equal(formatReportFilename(new Date(2026, 10, 2, 13, 4, 5)), "2026-11-02 13:04:05.txt");
  const report = fs.readFileSync(path.join(trader.results_directory, files[0]), "utf8");
  assert.match(report, /RELATÓRIO DO CICLO DERIV/);
  assert.ok(report.indexOf("ANÁLISE DOS ÚLTIMOS 50 TICKS") < report.indexOf("Últimos 10 ticks:"));
  assert.ok(report.indexOf("Últimos 10 ticks:") < report.indexOf("Frequência dos dígitos:"));
  assert.ok(report.indexOf("Frequência dos dígitos:") < report.indexOf("Ordens do ciclo:"));
  assert.ok(report.indexOf("Ordens do ciclo:") < report.indexOf("Resultado líquido:"));
  assert.doesNotMatch(report, /Contagem dos dígitos/);
});
