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

test("compra no formato atual e ignora liquidação repetida", async () => {
  process.env.DERIV_API_TOKEN = "teste";
  process.env.DERIV_APP_ID = "123";
  process.env.DERIV_ACCOUNT_ID = "DOT123";
  const { DerivTrader } = require("../trade");
  const trader = new DerivTrader(7);
  const sent = [];
  trader.ws = { readyState: 1, send: (payload, callback) => { sent.push(JSON.parse(payload)); callback(); } };
  trader.state = "TRADING";
  trader.current_attempt = 1;
  trader.buyContract(7, 0.35);
  await trader.sendQueue;
  assert.equal(sent[0].buy, "1");
  assert.equal(sent[0].parameters.underlying_symbol, "1HZ25V");
  assert.equal(sent[0].parameters.symbol, undefined);

  trader.pending_buy = false;
  trader.active_contract_id = 42;
  trader.total_invested = 0.35;
  const loss = { contract_id: 42, status: "lost", is_sold: 1, buy_price: "0.35", profit: "-0.35" };
  trader.handleContractUpdate(loss);
  trader.handleContractUpdate(loss);
  await trader.sendQueue;
  assert.equal(trader.contracts_history.length, 1);
  assert.equal(sent.filter((item) => item.buy === "1").length, 2);
});
