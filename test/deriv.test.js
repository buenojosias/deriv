const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { lastDigit, authenticatedWsUrl } = require("../deriv_api");
const { DigitAnalyzer } = require("../deriv_digits");
const { loadEnv } = require("../load_env");
const { exitDigit } = require("../result_report");

test("carrega o arquivo de variáveis sem sobrescrever o ambiente", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deriv-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "DERIV_TEST_FROM_FILE=valor\nDERIV_TEST_EXISTING=arquivo\n");
  process.env.DERIV_TEST_EXISTING = "sistema";
  try {
    loadEnv(file);
    assert.equal(process.env.DERIV_TEST_FROM_FILE, "valor");
    assert.equal(process.env.DERIV_TEST_EXISTING, "sistema");
  } finally {
    delete process.env.DERIV_TEST_FROM_FILE;
    delete process.env.DERIV_TEST_EXISTING;
    fs.rmSync(dir, { recursive: true });
  }
});

test("extrai o último dígito respeitando zeros finais", () => {
  assert.equal(lastDigit(123.4, 2), 0);
  assert.equal(lastDigit(123.4, 3), 0);
  assert.equal(lastDigit(123.45, 2), 5);
  assert.throws(() => lastDigit(123.4, undefined));
});

test("extrai o dígito de saída do contrato sem perder zeros finais", () => {
  assert.equal(exitDigit("123.40"), 0);
  assert.equal(exitDigit("123.47"), 7);
  assert.equal(exitDigit(null), null);
  assert.equal(exitDigit("valor inválido"), null);
});

test("analisa histórico com pip_size e rejeita histórico vazio", () => {
  const analyzer = new DigitAnalyzer();
  assert.equal(analyzer.getBestDigitInfo(), null);
  analyzer.analyzeTicks([{ quote: 123.4, epoch: 100, pip_size: 2 }]);
  assert.equal(analyzer.getBestDigitInfo().digit, 0);
  assert.equal(analyzer.getAnalysis().count, 1);
  assert.deepEqual(analyzer.getAnalysis().last10.map((tick) => tick.digit), [0]);
});

test("salva no relatório a análise e as fases anteriores às compras", async (t) => {
  process.env.DERIV_API_TOKEN = "teste";
  process.env.DERIV_APP_ID = "123";
  process.env.DERIV_ACCOUNT_ID = "DOT123";
  const { DerivTrader, CONFIG } = require("../trade");
  const analyzer = new DigitAnalyzer();
  analyzer.analyzeTicks(Array.from({ length: 50 }, (_, index) => ({
    quote: 100 + (index % 10), epoch: 1000 + index, pip_size: 0,
  })));
  const trader = new DerivTrader(7, analyzer.getAnalysis());
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "deriv-results-"));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));
  trader.results_directory = resultsDir;
  trader.ws = { readyState: 1, send: (_payload, callback) => callback() };
  trader.currency = "USD";
  trader.askRestart = () => {};
  let epoch = 1;
  const tick = (digit, quote = 100 + digit) => trader.handleMessage({ msg_type: "tick", tick: {
    quote, pip_size: String(quote).split(".")[1]?.length ?? 0, epoch: epoch++,
  } });
  tick(2);
  tick(5, "2935.655");
  tick(4);
  tick(7);
  for (const digit of [1, 7, 3, 3, 3, 3, 3, 3]) tick(digit);
  assert.equal(trader.state, "TRADING");
  assert.equal(trader.current_attempt, 1);
  tick(7);
  trader.handleMessage({ msg_type: "buy", req_id: 1, buy: { contract_id: 77, buy_price: 0.35 } });
  trader.handleMessage({ msg_type: "proposal_open_contract", proposal_open_contract: {
    contract_id: 77, status: "won", is_sold: 1, buy_price: "0.35", profit: "1.00", exit_spot: "123.47",
  } });
  const report = fs.readFileSync(path.join(resultsDir, fs.readdirSync(resultsDir)[0]), "utf8");
  assert.match(report, /ANÁLISE DOS ÚLTIMOS 50 TICKS/);
  assert.match(report, /Últimos 10 ticks:\n(?:[^\n]+\n){10}/);
  assert.match(report, /Frequência dos dígitos:\n(?:Dígito \d: +5x \(10\.0%\)[^\n]*\n){10}/);
  const beforeCount = report.split("Dígitos antes de iniciar a contagem (inclui o dígito alvo que a iniciou):\n")[1].split("\n\n")[0];
  const beforeCountLines = beforeCount.split("\n");
  assert.equal(beforeCountLines.length, 4);
  for (const [index, [price, digit]] of [["102", 2], ["2935.655", 5], ["104", 4], ["107", 7]].entries()) {
    const time = new Date((index + 1) * 1000).toTimeString().split(" ")[0];
    assert.equal(beforeCountLines[index], `${time} | Preço: ${price.padStart(10)} | Dígito: ${digit}`);
  }
  assert.match(report, /Contagem dos dígitos antes de iniciar as compras:\nDígito: 1 \| Contagem: 1\/6\nDígito: 7 \| Contagem: 0\/6\n(?:Dígito: 3 \| Contagem: [1-6]\/6\n){6}/);
  assert.match(report, new RegExp(`Deriv symbol: ${CONFIG.symbol}`));
});

test("obtém URL OTP usando token e app ID no REST", async () => {
  const url = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc";
  const fakeFetch = async (requestUrl, options) => {
    assert.match(requestUrl, /accounts\/DOT123\/otp$/);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer segredo");
    assert.equal(options.headers["Deriv-App-ID"], "123");
    return { ok: true, json: async () => ({ data: { url } }) };
  };
  assert.equal(await authenticatedWsUrl({ token: "segredo", appId: "123", accountId: "DOT123", fetchImpl: fakeFetch }), url);
});

test("interrompe a autenticação quando a Deriv recusa o OTP", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ message: "Token inválido" }] }) });
  await assert.rejects(authenticatedWsUrl({ token: "x", appId: "123", accountId: "DOT123", fetchImpl: fakeFetch }), /Token inválido/);
});

test("o próximo tick dispara outra compra antes da resposta da anterior", async (t) => {
  process.env.DERIV_API_TOKEN = "teste";
  process.env.DERIV_APP_ID = "123";
  process.env.DERIV_ACCOUNT_ID = "DOT123";
  const { DerivTrader, CONFIG } = require("../trade");
  const trader = new DerivTrader(7);
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "deriv-results-"));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));
  trader.results_directory = resultsDir;
  const sent = [];
  trader.ws = { readyState: 1, send: (payload, callback) => { sent.push(JSON.parse(payload)); callback(); } };
  trader.askRestart = () => {};
  trader.state = "TRADING";
  trader.currency = "USD";
  trader.buyContract();
  await trader.sendQueue;
  await Promise.resolve();
  assert.equal(sent[0].buy, "1");
  assert.equal(sent[0].parameters.underlying_symbol, CONFIG.symbol);
  assert.equal(sent[0].parameters.symbol, undefined);
  assert.equal(trader.pending_buys.size, 1);

  trader.handleMessage({ msg_type: "tick", tick: { quote: 100.03, pip_size: 2, epoch: 1 } });
  await trader.sendQueue;
  await Promise.resolve();
  assert.equal(sent.filter((item) => item.buy === "1").length, 2);
  assert.equal(trader.pending_buys.size, 2);
  assert.equal(sent[1].req_id, 2);

  trader.handleMessage({ msg_type: "tick", tick: { quote: 100.07, pip_size: 2, epoch: 2 } });
  assert.equal(trader.state, "DRAINING");
  assert.equal(sent.filter((item) => item.buy === "1").length, 2);

  trader.handleMessage({ msg_type: "buy", req_id: 2, buy: { contract_id: 102, buy_price: 0.37 } });
  trader.handleMessage({ msg_type: "buy", req_id: 1, buy: { contract_id: 101, buy_price: 0.35 } });
  await trader.sendQueue;
  trader.handleMessage({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 101, status: "lost", is_sold: 1, buy_price: "0.35", profit: "-0.35", exit_spot: "123.40" } });
  assert.equal(fs.readdirSync(resultsDir).length, 0);
  trader.handleMessage({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 102, status: "won", is_sold: 1, buy_price: "0.37", profit: "2.00", exit_spot: "123.47" } });
  assert.equal(trader.state, "STOPPED");
  assert.equal(trader.contracts_history.length, 2);
  assert.deepEqual(trader.contracts_history.map((item) => item.attempt), [1, 2]);
  assert.equal(trader.total_invested, 0.72);
  const files = fs.readdirSync(resultsDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^ciclo-.*\.txt$/);
  const report = fs.readFileSync(path.join(resultsDir, files[0]), "utf8");
  assert.match(report, new RegExp(`Deriv symbol: ${CONFIG.symbol}`));
  assert.match(report, /Dígito alvo: 7/);
  assert.match(report, /Ordem #1 \| Contrato: 101 \| Valor da entrada: 0\.35 USD \| Dígito retornado: 0/);
  assert.match(report, /Ordem #2 \| Contrato: 102 \| Valor da entrada: 0\.37 USD \| Dígito retornado: 7/);
  assert.ok(report.indexOf("Ordem #1") < report.indexOf("Ordem #2"));
  assert.match(report, /Ordens enviadas: 2/);
  assert.match(report, /Contratos liquidados: 2/);
  assert.match(report, /Total investido: 0\.72 USD/);
  assert.match(report, /Total recebido: 2\.37 USD/);
  assert.match(report, /Resultado líquido: 1\.65 USD/);
});

test("a liquidação não dispara compra e mensagens repetidas não duplicam o resultado", async () => {
  const { DerivTrader } = require("../trade");
  const trader = new DerivTrader(7);
  const sent = [];
  trader.ws = { readyState: 1, send: (payload, callback) => { sent.push(JSON.parse(payload)); callback(); } };
  trader.askRestart = () => {};
  trader.state = "TRADING";
  trader.currency = "USD";
  trader.buyContract();
  await trader.sendQueue;
  await Promise.resolve();
  trader.handleMessage({ msg_type: "buy", req_id: 1, buy: { contract_id: 42, buy_price: 0.35 } });
  await trader.sendQueue;
  const loss = { contract_id: 42, status: "lost", is_sold: 1, buy_price: "0.35", profit: "-0.35" };
  trader.handleContractUpdate(loss);
  trader.handleContractUpdate(loss);
  assert.equal(trader.contracts_history.length, 1);
  assert.equal(sent.filter((item) => item.buy === "1").length, 1);
  assert.equal(trader.state, "TRADING");
});

test("considera o tick que chega antes do callback de envio", async () => {
  const { DerivTrader } = require("../trade");
  const trader = new DerivTrader(7);
  const sent = [];
  let finishFirstSend;
  trader.ws = { readyState: 1, send: (payload, callback) => {
    sent.push(JSON.parse(payload));
    if (sent.length === 1) finishFirstSend = callback;
    else callback();
  } };
  trader.state = "TRADING";
  trader.currency = "USD";
  trader.buyContract();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(trader.awaiting_next_tick, true);

  trader.handleMessage({ msg_type: "tick", tick: { quote: 100.03, pip_size: 2, epoch: 1 } });
  assert.equal(trader.current_attempt, 2);
  assert.equal(trader.pending_buys.size, 2);
  assert.equal(sent.filter((item) => item.buy === "1").length, 2);
  finishFirstSend();
  await trader.sendQueue;
  assert.equal(sent.filter((item) => item.buy === "1").length, 2);
});

test("a contagem inicial leva ao ciclo guiado pelos ticks", async () => {
  const { DerivTrader } = require("../trade");
  const trader = new DerivTrader(7);
  const sent = [];
  trader.ws = { readyState: 1, send: (payload, callback) => { sent.push(JSON.parse(payload)); callback(); } };
  trader.currency = "USD";
  const tick = (digit, epoch) => trader.handleMessage({
    msg_type: "tick",
    tick: { quote: 100 + digit, pip_size: 0, epoch },
  });
  tick(7, 1);
  for (let epoch = 2; epoch <= 7; epoch++) tick(3, epoch);
  await trader.sendQueue;
  assert.equal(trader.state, "TRADING");
  assert.equal(sent.filter((item) => item.buy === "1").length, 1);
  tick(3, 8);
  await trader.sendQueue;
  assert.equal(sent.filter((item) => item.buy === "1").length, 2);
});
