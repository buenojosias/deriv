const WebSocket = require("ws");
const { PUBLIC_WS_URL, lastDigit } = require("./deriv_api");
require("./load_env").loadEnv();

const CONFIG = {
  symbol: process.env.DERIV_SYMBOL || "1HZ25V",
  count: 50, // Quantidade de ticks para análise
};

class DigitAnalyzer {
  constructor() {
    this.ticksData = []; // { time: Date, price: number, digit: number }
    this.digits = []; // lista de dígitos
    this.bestDigit = null;
  }

  getLastDigit(price, pipSize) {
    return lastDigit(price, pipSize);
  }

  analyzeTicks(ticksHistory) {
    // ticksHistory: [{ quote, epoch }, ...]
    for (const tick of ticksHistory) {
      const price = tick.quote;
      const epoch = tick.epoch;
      const digit = this.getLastDigit(price, tick.pip_size);

      this.ticksData.push({
        time: new Date(epoch * 1000),
        price,
        digit,
      });
      this.digits.push(digit);
    }
  }

  getStatistics() {
    // Conta frequência de cada dígito e monta estatísticas
    const counts = new Array(10).fill(0);
    for (const d of this.digits) {
      if (d >= 0 && d <= 9) counts[d] += 1;
    }
    const total = this.digits.length;
    const stats = [];
    for (let digit = 0; digit < 10; digit++) {
      const count = counts[digit];
      const percentage = total > 0 ? (count / total) * 100 : 0;
      stats.push({ digit, count, percentage });
    }
    // Ordena por frequência (maior -> menor)
    stats.sort((a, b) => b.count - a.count);
    return stats;
  }

  getBestDigitInfo() {
    if (this.digits.length === 0) return null;
    const stats = this.getStatistics();
    return stats.length > 0 ? stats[0] : null;
  }

  getAnalysis() {
    return {
      symbol: CONFIG.symbol,
      count: this.ticksData.length,
      last10: this.ticksData.slice(-10).map((tick) => ({
        time: tick.time.toTimeString().split(" ")[0],
        price: String(tick.price),
        digit: tick.digit,
      })),
      frequency: this.getStatistics(),
      bestDigit: this.getBestDigitInfo()?.digit ?? null,
    };
  }

  displayAnalysis() {
    console.log("\n" + "=".repeat(60));
    console.log(`📊 ANÁLISE DOS ÚLTIMOS ${this.ticksData.length} TICKS`);
    console.log("=".repeat(60));

    console.log("\n📈 ÚLTIMOS 10 TICKS:");
    console.log("-".repeat(60));
    const last10 = this.ticksData.slice(-10);
    for (const tick of last10) {
      const hhmmss = tick.time.toTimeString().split(" ")[0]; // HH:MM:SS
      // formata preço alinhado à direita (simples)
      console.log(
        `${hhmmss} | Preço: ${String(tick.price).padStart(10)} | Dígito: ${
          tick.digit
        }`
      );
    }

    console.log("\n📊 FREQUÊNCIA DOS DÍGITOS:");
    console.log("-".repeat(60));
    const stats = this.getStatistics();
    for (const stat of stats) {
      const bar = "█".repeat(Math.floor(stat.percentage / 2)); // barra visual
      console.log(
        `Dígito ${stat.digit}: ${String(stat.count).padStart(
          2
        )}x (${stat.percentage.toFixed(1)}%) ${bar}`
      );
    }

    const best = this.getBestDigitInfo();
    if (best) {
      this.bestDigit = best.digit;
      console.log("\n" + "=".repeat(60));
      console.log(`🎯 MELHOR DÍGITO: ${best.digit}`);
      console.log(
        `   Frequência: ${best.count}x (${best.percentage.toFixed(1)}%)`
      );
      console.log("=".repeat(60) + "\n");
    }
  }
}

/**
 * getDigitAnalysis(display = true) -> Promise<object>
 * Conecta na Deriv, solicita ticks_history e analisa os dígitos.
 */
function getDigitAnalysis(display = true) {
  return new Promise((resolve, reject) => {
    const analyzer = new DigitAnalyzer();
    let ws;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tempo esgotado ao buscar histórico de ticks"));
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      } catch (e) {
        /* ignore */
      }
    }

    try {
      ws = new WebSocket(PUBLIC_WS_URL);

      ws.on("open", () => {
        if (display) {
          console.log("✅ Conectado à Deriv API");
          console.log(`📥 Buscando últimos ${CONFIG.count} ticks...\n`);
        }

        const request = {
          ticks_history: CONFIG.symbol,
          count: CONFIG.count,
          end: "latest",
          style: "ticks",
        };
        ws.send(JSON.stringify(request));
      });

      ws.on("message", (message) => {
        let response;
        try {
          response = JSON.parse(message);
        } catch (err) {
          if (display) console.error("❌ Erro ao parsear mensagem:", err);
          return;
        }

        if (response.error) {
          if (display)
            console.error(
              `❌ Erro: ${
                response.error.message || JSON.stringify(response.error)
              }`
            );
          cleanup();
          return reject(new Error(response.error.message || "Deriv error"));
        }

        // A resposta do histórico pode vir com msg_type == 'history'
        if (response.msg_type === "history" && response.history) {
          const historyData = response.history;
          const prices = historyData.prices || [];
          const times = historyData.times || [];

          // Monta ticks_history no formato esperado
          const ticksHistory = [];
          for (let i = 0; i < Math.min(prices.length, times.length); i++) {
            ticksHistory.push({
              quote: prices[i],
              epoch: times[i],
              pip_size: response.pip_size,
            });
          }

          try {
            analyzer.analyzeTicks(ticksHistory);
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }

          if (display) analyzer.displayAnalysis();

          const analysis = analyzer.getAnalysis();
          cleanup();
          resolve(analysis);
        }
      });

      ws.on("error", (err) => {
        if (display) console.error("❌ Erro no WebSocket:", err.message || err);
        cleanup();
        reject(err);
      });

      ws.on("close", (code, reason) => {
        if (display)
          console.log(
            "🔌 Conexão fechada (código:",
            code,
            "motivo:",
            reason ? reason.toString() : "none",
            ")"
          );
        clearTimeout(timeout);
        if (!analyzer.digits.length) reject(new Error("Conexão encerrada sem histórico"));
      });
    } catch (ex) {
      cleanup();
      reject(ex);
    }
  });
}

async function getBestDigit(display = true) {
  return (await getDigitAnalysis(display)).bestDigit;
}

// Se executado diretamente: mostra a análise completa
if (require.main === module) {
  (async () => {
    try {
      const best = await getBestDigit(true);
      console.log(`\n✅ Retornando dígito: ${best}`);
    } catch (err) {
      console.error("Erro na análise:", err);
    }
  })();
}

// Export para uso em outros módulos
module.exports = { getBestDigit, getDigitAnalysis, DigitAnalyzer, CONFIG };
