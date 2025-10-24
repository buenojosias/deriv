// Salve como deriv_digits.js
// Requer: npm install ws

const WebSocket = require("ws");

const CONFIG = {
  app_id: 1089, // App ID público da Deriv
  symbol: "R_25", // Volatility 25 Index
  count: 50, // Quantidade de ticks para análise
};

const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.app_id}`;

class DigitAnalyzer {
  constructor() {
    this.ticksData = []; // { time: Date, price: number, digit: number }
    this.digits = []; // lista de dígitos
    this.bestDigit = null;
  }

  getLastDigit(price) {
    // Extrai o último dígito do preço (remove ponto decimal)
    const priceStr = String(price).replace(".", "");
    return parseInt(priceStr.charAt(priceStr.length - 1), 10);
  }

  analyzeTicks(ticksHistory) {
    // ticksHistory: [{ quote, epoch }, ...]
    for (const tick of ticksHistory) {
      const price = tick.quote;
      const epoch = tick.epoch;
      const lastDigit = this.getLastDigit(price);

      this.ticksData.push({
        time: new Date(epoch * 1000),
        price,
        digit: lastDigit,
      });
      this.digits.push(lastDigit);
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
    const stats = this.getStatistics();
    return stats.length > 0 ? stats[0] : null;
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
 * getBestDigit(display = true) -> Promise<number|null>
 * Conecta na Deriv, solicita ticks_history e analisa os dígitos.
 */
function getBestDigit(display = true) {
  return new Promise((resolve, reject) => {
    const analyzer = new DigitAnalyzer();
    let ws;

    function cleanup() {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      } catch (e) {
        /* ignore */
      }
    }

    try {
      ws = new WebSocket(wsUrl);

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
            });
          }

          analyzer.analyzeTicks(ticksHistory);

          if (display) analyzer.displayAnalysis();

          // resolve com o melhor dígito (ou null)
          const best = analyzer.getBestDigitInfo();
          cleanup();
          resolve(best ? best.digit : null);
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
        // Caso a conexão feche sem termos resolvido ainda, resolvemos com o que tivermos
        const best = analyzer.getBestDigitInfo();
        resolve(best ? best.digit : null);
      });
    } catch (ex) {
      cleanup();
      reject(ex);
    }
  });
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
module.exports = { getBestDigit, DigitAnalyzer, CONFIG };
