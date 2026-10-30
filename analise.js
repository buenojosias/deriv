const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const WebSocket = require("ws");
require("./load_env").loadEnv();
const { getDigitAnalysis } = require("./deriv_digits");
const { PUBLIC_WS_URL, lastDigit } = require("./deriv_api");

const SYMBOL = process.env.DERIV_SYMBOL || "1HZ25V";
const TICK_COUNT = 50;
const MIN_FREQUENCY = 18;
const RETRY_DELAY_MS = 30_000;
const REPEAT_DELAY_MS = 60_000;

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptMode(createInterface = readline.createInterface) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const choice = (await rl.question("Executar uma vez (1) ou repetidamente (2)? ")).trim();
      if (choice === "1" || choice === "2") return choice;
      console.log("Digite 1 ou 2.");
    }
  } finally {
    rl.close();
  }
}

function collectNextDigits(symbol = SYMBOL, afterEpoch = null, targetDigit = null, WebSocketImpl = WebSocket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(PUBLIC_WS_URL);
    const digits = [];
    let lastTickKey = null;
    let settled = false;

    function finish(error) {
      if (settled) return;
      settled = true;
      if (ws.readyState === WebSocketImpl.OPEN) ws.close();
      if (error) reject(error);
      else resolve(digits);
    }

    ws.on("open", () => ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 })));
    ws.on("message", (raw) => {
      if (settled) return;
      let response;
      try {
        response = JSON.parse(raw);
      } catch (error) {
        finish(new Error(`Resposta inválida: ${error.message}`));
        return;
      }
      if (response.error) {
        finish(new Error(response.error.message || "Erro da Deriv ao receber ticks"));
        return;
      }
      if (response.msg_type !== "tick" || response.tick?.quote == null) return;
      const tick = response.tick;
      if (afterEpoch != null && tick.epoch != null && tick.epoch <= afterEpoch) return;
      const key = tick.epoch == null ? null : `${tick.epoch}:${tick.quote}`;
      if (key && key === lastTickKey) return;
      let digit;
      try {
        digit = lastDigit(tick.quote, tick.pip_size);
      } catch (error) {
        finish(error);
        return;
      }
      lastTickKey = key;
      digits.push(digit);
      console.log(`${String(digits.length).padStart(2)} / ${TICK_COUNT} | Dígito: ${digit}${digit === targetDigit ? " ★" : ""}`);
      if (digits.length === TICK_COUNT) finish();
    });
    ws.on("error", (error) => finish(error));
    ws.on("close", () => {
      if (!settled) finish(new Error(`Conexão encerrada após ${digits.length} de ${TICK_COUNT} ticks`));
    });
  });
}

function writeAnalysisReport({ directory, startedAt, symbol, analysis, digits }) {
  if (digits.length !== TICK_COUNT) throw new Error(`Esperados ${TICK_COUNT} dígitos`);
  const best = analysis.frequency[0];
  const formatTick = (tick) => `${tick.time} | Preço: ${String(tick.price).padStart(10)} | Dígito: ${tick.digit}`;
  const lines = [
    `ANÁLISE INICIADA EM ${timestamp(startedAt)}`,
    `Deriv symbol: ${symbol}`,
    `Dígito mais frequente: ${best.digit} (${best.count}x, ${best.percentage.toFixed(1)}%)`,
    "",
    `ANÁLISE DOS ÚLTIMOS ${analysis.count} TICKS`,
    "Últimos 10 ticks:",
    ...analysis.last10.map(formatTick),
    "",
    "Frequência dos dígitos:",
    ...analysis.frequency.map((stat) =>
      `Dígito ${stat.digit}: ${String(stat.count).padStart(2)}x (${stat.percentage.toFixed(1)}%) ${"█".repeat(Math.floor(stat.percentage / 2))}`),
    "",
    `PRÓXIMOS ${TICK_COUNT} DÍGITOS (★ = dígito mais frequente)`,
    ...digits.map((digit, index) => `${String(index + 1).padStart(2, "0")}: ${digit}${digit === best.digit ? " ★" : ""}`),
    "",
    `Sequência exata: ${digits.join(" ")}`,
  ];
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${timestamp(startedAt)}.txt`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

async function main({ analyze = getDigitAnalysis, collect = collectNextDigits, wait = sleep,
  askMode = promptMode,
  directory = path.join(__dirname, "analises"), now = () => new Date() } = {}) {
  const mode = await askMode();
  if (mode !== "1" && mode !== "2") throw new Error("Modo inválido: escolha 1 ou 2");
  while (true) {
    const startedAt = now();
    const analysis = await analyze(true);
    if (analysis.count !== TICK_COUNT || !analysis.frequency?.length) {
      throw new Error(`A análise deve conter exatamente ${TICK_COUNT} ticks`);
    }
    const best = analysis.frequency[0];
    if (best.percentage < MIN_FREQUENCY) {
      console.log(`Maior frequência: ${best.percentage.toFixed(1)}%. Nova análise em 30 segundos.`);
      await wait(RETRY_DELAY_MS);
      continue;
    }
    console.log(`Dígito ${best.digit} atingiu ${best.percentage.toFixed(1)}%. Registrando os próximos ${TICK_COUNT} ticks.`);
    const digits = await collect(SYMBOL, analysis.lastTickEpoch, best.digit);
    if (digits.length !== TICK_COUNT) throw new Error(`Recebidos ${digits.length} de ${TICK_COUNT} ticks`);
    const reportPath = writeAnalysisReport({ directory, startedAt, symbol: SYMBOL, analysis, digits });
    console.log(`Relatório salvo em: ${reportPath}`);
    if (mode === "1") return reportPath;
    console.log("Nova análise em 1 minuto.");
    await wait(REPEAT_DELAY_MS);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Erro na análise:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, promptMode, collectNextDigits, writeAnalysisReport, timestamp };
