const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function exitDigit(exitSpot) {
  if (exitSpot == null) return null;
  const value = String(exitSpot).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  return Number(value.at(-1));
}

function writeCycleReport({ directory, symbol, targetDigit, contracts, ordersSent, totalInvested, currency,
  analysis, digitsBeforeCount = [], countingTicks = [], waitAfterTarget = 6 }) {
  const settled = [...contracts].sort((a, b) => a.attempt - b.attempt);
  const totalReceived = settled.reduce((sum, item) => sum + item.payout, 0);
  const money = (value) => `${value.toFixed(2)} ${currency}`;
  const formatTick = (tick) => `${tick.time} | Preço: ${String(tick.price).padStart(10)} | Dígito: ${tick.digit}`;
  const lines = [
    "RELATÓRIO DO CICLO DERIV",
    `Deriv symbol: ${symbol}`,
    `Dígito alvo: ${targetDigit}`,
    "",
    "Ordens do ciclo:",
    ...settled.map((item) =>
      `Ordem #${item.attempt} | Contrato: ${item.contractId} | Valor da entrada: ${money(item.stake)} | Dígito retornado: ${item.returnedDigit ?? "indisponível"}`
    ),
    "",
    `Ordens enviadas: ${ordersSent}`,
    `Contratos liquidados: ${settled.length}`,
    `Total investido: ${money(totalInvested)}`,
    `Total recebido: ${money(totalReceived)}`,
    `Resultado líquido: ${money(totalReceived - totalInvested)}`,
    "",
    `ANÁLISE DOS ÚLTIMOS ${analysis?.count ?? 0} TICKS`,
    "Últimos 10 ticks:",
    ...(analysis?.last10?.length
      ? analysis.last10.map(formatTick)
      : ["Indisponível"]),
    "",
    "Frequência dos dígitos:",
    ...(analysis?.frequency?.length
      ? analysis.frequency.map((stat) =>
        `Dígito ${stat.digit}: ${String(stat.count).padStart(2)}x (${stat.percentage.toFixed(1)}%) ${"█".repeat(Math.floor(stat.percentage / 2))}`)
      : ["Indisponível"]),
    "",
    "Dígitos antes de iniciar a contagem (inclui o dígito alvo que a iniciou):",
    ...(digitsBeforeCount.length ? digitsBeforeCount.map(formatTick) : ["Nenhum"]),
    "",
    "Contagem dos dígitos antes de iniciar as compras:",
    ...(countingTicks.length
      ? countingTicks.map(({ digit, count }) => `Dígito: ${digit} | Contagem: ${count}/${waitAfterTarget}`)
      : ["Nenhum"]),
  ];

  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `ciclo-${timestamp}-${randomUUID()}.txt`;
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

module.exports = { exitDigit, writeCycleReport };
