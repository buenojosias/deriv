const test = require("node:test");
const assert = require("node:assert/strict");
const { lastDigit, authenticatedWsUrl } = require("../deriv_api");
const { DigitAnalyzer } = require("../deriv_digits");
const { loadEnv } = require("../load_env");

test("carrega o arquivo de variáveis sem sobrescrever o ambiente", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
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

test("analisa histórico com pip_size e rejeita histórico vazio", () => {
  const analyzer = new DigitAnalyzer();
  assert.equal(analyzer.getBestDigitInfo(), null);
  analyzer.analyzeTicks([{ quote: 123.4, epoch: 100, pip_size: 2 }]);
  assert.equal(analyzer.getBestDigitInfo().digit, 0);
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

test("o próximo tick dispara outra compra antes da resposta da anterior", async () => {
  process.env.DERIV_API_TOKEN = "teste";
  process.env.DERIV_APP_ID = "123";
  process.env.DERIV_ACCOUNT_ID = "DOT123";
  const { DerivTrader, CONFIG } = require("../trade");
  const trader = new DerivTrader(7);
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
  trader.handleMessage({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 101, status: "lost", is_sold: 1, buy_price: "0.35", profit: "-0.35" } });
  trader.handleMessage({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 102, status: "won", is_sold: 1, buy_price: "0.37", profit: "2.00" } });
  assert.equal(trader.state, "STOPPED");
  assert.equal(trader.contracts_history.length, 2);
  assert.deepEqual(trader.contracts_history.map((item) => item.attempt), [1, 2]);
  assert.equal(trader.total_invested, 0.72);
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
