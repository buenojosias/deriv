// deriv_trader.js
// Requer: npm install ws
// Assume: existe ./deriv_digits.js exportando getBestDigit(display)

const WebSocket = require("ws");
const readline = require("readline");
const { getBestDigit } = require("./deriv_digits"); // módulo anterior

// ---------------- CONFIGURAÇÕES ----------------
const CONFIG = {
  app_id: 1089,
  api_token: process.env.DERIV_API_TOKEN || "EdpMgnAcCpb4X1Y", // recomenda usar VAR DE AMBIENTE
  symbol: "R_25",
  initial_stake: 0.35,
  max_attempts: 20,
  wait_after_target: 6,
};

const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.app_id}`;
// ------------------------------------------------

class DerivTrader {
  constructor(target_digit) {
    if (target_digit < 0 || target_digit > 9) {
      throw new Error("target_digit must be 0-9");
    }
    this.ws = null;
    this.target_digit = Number(target_digit);
    this.is_authorized = false;
    this.balance = 0;
    this.currency = "USD";

    // Estado
    this.state = "ANALYZING"; // ANALYZING, WAITING, TRADING, STOPPED
    this.digits_after_target = 0;
    this.current_attempt = 0;
    this.total_invested = 0.0;
    this.current_stake = 0.0;
    this.contracts_history = [];
    this.final_payout = 0.0;

    // último tick conhecido
    this.last_tick_price = null;
    this.last_tick_digit = null;

    // fila simples para enviar (evita race naive)
    this.sendQueue = Promise.resolve();

    // controle de reinício
    this.awaiting_restart = false;

    console.log(`\n🎯 DÍGITO ALVO: ${this.target_digit}`);
    console.log("=".repeat(60));

    if (!CONFIG.api_token || CONFIG.api_token === "SEU_TOKEN_AQUI") {
      console.warn(
        "⚠️ Aviso: token da API não definido ou é o placeholder. Use DERIV_API_TOKEN ou ajuste CONFIG."
      );
    }
  }

  // envia payload de forma "sequencial" evitando possíveis races (sendQueue)
  safeSend(payload) {
    const raw = JSON.stringify(payload);
    // chain promise so sends happen in order
    this.sendQueue = this.sendQueue
      .then(() => {
        return new Promise((resolve) => {
          try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(raw, (err) => {
                if (err) console.warn("⚠️ Erro ao enviar payload:", err);
                resolve();
              });
            } else {
              // se ws não aberto, simplesmente resolve (não vamos bloquear)
              resolve();
            }
          } catch (e) {
            console.warn("⚠️ Erro ao enviar payload:", e);
            resolve();
          }
        });
      })
      .catch((_) => {}); // evitar rejection cascade
  }

  getLastDigit(price) {
    const priceStr = String(price).replace(".", "");
    if (!priceStr) return 0;
    return parseInt(priceStr.charAt(priceStr.length - 1), 10);
  }

  calculateStake(attempt) {
    // recursivo conforme original: attempt 1 -> initial_stake
    if (attempt === 1) return CONFIG.initial_stake;
    const prev = this.calculateStake(attempt - 1);
    // round to 2 decimals
    return Math.round((prev + attempt / 100) * 100) / 100;
  }

  connect() {
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log("✅ Conectado à Deriv API");
      const req = { authorize: CONFIG.api_token };
      this.safeSend(req);
    });

    this.ws.on("message", (message) => {
      let response;
      try {
        response = JSON.parse(message);
      } catch (e) {
        return;
      }
      const msg_type = response.msg_type;
      if (msg_type === "authorize") {
        const auth = response.authorize || {};
        this.is_authorized = true;
        this.balance = auth.balance !== undefined ? auth.balance : this.balance;
        this.currency = auth.currency || this.currency;
        console.log(
          `✅ Autorizado | Saldo: ${this.balance} ${this.currency}\n`
        );
        this.subscribeTicks();
        return;
      }

      if (msg_type === "tick") {
        const tick = response.tick;
        if (!tick) return;
        const price = tick.quote;
        const digit = this.getLastDigit(price);
        this.last_tick_price = price;
        this.last_tick_digit = digit;

        if (this.state === "TRADING" || this.state === "STOPPED") return;

        const epoch = tick.epoch || Math.floor(Date.now() / 1000);
        const timeStr = new Date(epoch * 1000).toTimeString().split(" ")[0];
        process.stdout.write(`🎲 ${timeStr} | Dígito: ${digit}`);

        if (this.state === "ANALYZING") {
          if (digit === this.target_digit) {
            console.log(" ← 🎯 Dígito alvo apareceu! Iniciando contagem...");
            this.state = "WAITING";
            this.digits_after_target = 0;
          } else {
            console.log();
          }
          return;
        }

        if (this.state === "WAITING") {
          if (digit !== this.target_digit) {
            this.digits_after_target += 1;
            console.log(
              ` | Contagem: ${this.digits_after_target}/${CONFIG.wait_after_target}`
            );
            if (this.digits_after_target >= CONFIG.wait_after_target) {
              console.log("\n" + "=".repeat(60));
              console.log("🚀 INICIANDO OPERAÇÕES!");
              console.log("=".repeat(60));
              this.state = "TRADING";
              this.current_attempt = 1;
              const stake = this.calculateStake(this.current_attempt);
              this.total_invested += stake;
              this.buyContract(this.target_digit, stake);
            }
          } else {
            console.log(
              " ← Dígito alvo apareceu novamente, reiniciando contagem"
            );
            this.digits_after_target = 0;
          }
          return;
        }
        return;
      }

      if (msg_type === "buy") {
        const buy_data = response.buy || {};
        const contract_id = buy_data.contract_id;
        const buy_price = parseFloat(buy_data.buy_price || 0) || 0.0;
        console.log(
          `\n✅ Contrato comprado! ID: ${contract_id} | Valor pago: $${buy_price.toFixed(
            2
          )}`
        );
        console.log("⏳ Aguardando resultado do contrato...\n");
        const req = {
          proposal_open_contract: 1,
          contract_id: contract_id,
          subscribe: 1,
        };
        this.safeSend(req);
        return;
      }

      if (msg_type === "proposal_open_contract") {
        const contract = response.proposal_open_contract || {};
        this.handleContractUpdate(contract);
        return;
      }

      if (response.error) {
        console.error(
          "❌ Erro:",
          response.error.message || JSON.stringify(response.error)
        );
      }

      // outras mensagens ignoradas silenciosamente
    });

    this.ws.on("error", (err) => {
      console.error(
        "❌ Erro no WebSocket:",
        err && err.message ? err.message : err
      );
    });

    this.ws.on("close", (code, reason) => {
      console.log(
        "\n🔌 Conexão encerrada",
        code ? `código: ${code}` : "",
        reason ? `motivo: ${reason}` : ""
      );
      // se necessário, aqui você poderia reconectar
    });
  }

  subscribeTicks() {
    const req = { ticks: CONFIG.symbol, subscribe: 1 };
    this.safeSend(req);
  }

  buyContract(digit, stake) {
    const request = {
      buy: 1,
      price: stake,
      parameters: {
        contract_type: "DIGITMATCH",
        symbol: CONFIG.symbol,
        duration: 1,
        duration_unit: "t",
        basis: "stake",
        amount: stake,
        barrier: String(digit),
        currency: this.currency,
      },
    };
    this.current_stake = stake;
    console.log(`\n💵 ENTRADA #${this.current_attempt}:`);
    console.log(`   Valor desta entrada: $${stake.toFixed(2)}`);
    console.log(
      `   Total investido até agora: $${this.total_invested.toFixed(2)}`
    );
    console.log(`📤 Enviando aposta no dígito ${digit}...`);
    this.safeSend(request);
  }

  handleContractUpdate(contract) {
    const status = contract.status;
    const contract_id = contract.contract_id || "N/A";

    if (status === "open") return;

    let profit = 0.0;
    let buy_price = 0.0;
    try {
      profit = parseFloat(contract.profit || 0) || 0.0;
    } catch (e) {
      profit = 0.0;
    }
    try {
      buy_price = parseFloat(contract.buy_price || 0) || 0.0;
    } catch (e) {
      buy_price = 0.0;
    }

    const payout_received = buy_price + profit;

    this.contracts_history.push({
      attempt: this.current_attempt,
      stake: this.current_stake,
      profit,
      payout: payout_received,
    });

    if (profit > 0) {
      this.final_payout = payout_received;
      console.log("\n" + "=".repeat(60));
      console.log(`✅ GANHOU! Prêmio: $${payout_received.toFixed(2)}`);
      console.log("=".repeat(60));
      // pede ao servidor "esquecer" streams ticks
      try {
        this.safeSend({ forget_all: "ticks" });
      } catch (e) {}
      this.generateFinalReport();
      this.state = "STOPPED";
      this.awaiting_restart = true;
      // pergunta se reiniciar (não bloqueia o ws)
      this.askRestart();
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`❌ PERDEU! Perda: $${Math.abs(profit).toFixed(2)}`);

    // tenta obter número sorteado via tick_stream
    let printed_number = null;
    const tick_stream =
      contract.tick_stream ||
      contract.tick_stream_raw ||
      contract.ticks ||
      null;
    if (tick_stream) {
      try {
        if (Array.isArray(tick_stream) && tick_stream.length > 0) {
          const last = tick_stream[tick_stream.length - 1];
          if (typeof last === "object" && last !== null && "tick" in last) {
            printed_number = String(last.tick);
          } else {
            printed_number = String(last);
          }
        } else {
          printed_number = String(tick_stream);
        }
      } catch (e) {
        printed_number = null;
      }
    }

    if (!printed_number && this.last_tick_price != null) {
      printed_number = String(this.last_tick_price);
    }

    if (printed_number) {
      const withoutDot = printed_number.replace(".", "");
      const last_digit = withoutDot.charAt(withoutDot.length - 1);
      console.log(`🎲 Número sorteado: ${withoutDot} | ${last_digit}`);
    } else {
      console.log("🎲 Número sorteado: (não informado)");
    }

    console.log(
      `📊 Total investido até agora: $${this.total_invested.toFixed(2)}`
    );

    if (this.current_attempt < CONFIG.max_attempts) {
      this.current_attempt += 1;
      const stake = this.calculateStake(this.current_attempt);
      this.total_invested += stake;
      console.log(
        `🔄 Próxima tentativa: ${this.current_attempt}/${CONFIG.max_attempts}`
      );
      console.log("=".repeat(60));
      this.buyContract(this.target_digit, stake);
    } else {
      console.log(`🛑 Limite de tentativas atingido (${CONFIG.max_attempts})`);
      console.log(`💸 Total perdido: $${this.total_invested.toFixed(2)}`);
      console.log("=".repeat(60));
      this.state = "STOPPED";
      try {
        if (this.ws) this.ws.close();
      } catch (e) {}
    }
  }

  generateFinalReport() {
    const total_payouts = this.contracts_history.reduce(
      (s, h) => s + (h.payout || 0),
      0
    );
    const net_profit = total_payouts - this.total_invested;

    console.log("\n" + "╔" + "=".repeat(58) + "╗");
    console.log(
      "║" + " ".repeat(15) + "📊 RELATÓRIO FINAL" + " ".repeat(24) + "║"
    );
    console.log("╠" + "=".repeat(58) + "╣");
    console.log(`║  🎯 Dígito Alvo: ${this.target_digit}`);
    console.log(`║  🔢 Tentativas: ${this.current_attempt}`);
    console.log("╠" + "=".repeat(58) + "╣");
    console.log(`║  💰 Total Investido: $${this.total_invested.toFixed(2)}`);
    console.log(`║  🏆 Payout Recebido: $${total_payouts.toFixed(2)}`);
    console.log("╠" + "=".repeat(58) + "╣");
    if (net_profit > 0) {
      console.log(`║  ✅ LUCRO FINAL: $${net_profit.toFixed(2)}`);
    } else {
      console.log(`║  ❌ PREJUÍZO FINAL: $${Math.abs(net_profit).toFixed(2)}`);
    }
    console.log("╚" + "=".repeat(58) + "╝\n");
  }

  async askRestart() {
    // pequena espera para não conflitar com prints
    await new Promise((r) => setTimeout(r, 1500));
    if (!this.awaiting_restart) return;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      "\n❓ Deseja iniciar uma nova operação? (s/n): ",
      async (answer) => {
        rl.close();
        const resp = String(answer || "")
          .trim()
          .toLowerCase();
        if (resp === "s") {
          console.log("\n🔄 Reiniciando análise...\n");
          this.state = "ANALYZING";
          this.digits_after_target = 0;
          this.current_attempt = 0;
          this.total_invested = 0.0;
          this.current_stake = 0.0;
          this.contracts_history = [];
          this.final_payout = 0.0;
          this.awaiting_restart = false;
          try {
            this.subscribeTicks();
          } catch (e) {}
          // obtém novo dígito via graph/getBestDigit
          try {
            const new_digit = await getBestDigit(true);
            if (new_digit !== null && new_digit !== undefined) {
              this.target_digit = new_digit;
              console.log(`\n🎯 NOVO DÍGITO ALVO: ${new_digit}`);
              console.log("=".repeat(60) + "\n");
            }
          } catch (e) {
            // mantém dígito atual se falhar
          }
        } else {
          console.log("\n👋 Encerrando operações...");
          try {
            if (this.ws) this.ws.close();
          } catch (e) {}
        }
      }
    );
  }
}

// função auxiliar para obter melhor dígito (chama módulo graph)
async function get_best_digit() {
  console.log("=".repeat(60));
  console.log("📊 ANALISANDO MERCADO...");
  console.log("=".repeat(60));
  try {
    const best_digit = await getBestDigit(true);
    return best_digit != null ? best_digit : 0;
  } catch (e) {
    return 0;
  }
}

// se executado diretamente
if (require.main === module) {
  (async () => {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 DERIV TRADING BOT - DÍGITO COMBINA");
    console.log("=".repeat(60));

    const best_digit = await get_best_digit();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      `\n✅ Dígito sugerido: ${best_digit} | Iniciar operação? (s/n): `,
      async (answer) => {
        const resp = String(answer || "")
          .trim()
          .toLowerCase();
        if (resp === "s") {
          const trader = new DerivTrader(best_digit);
          try {
            trader.connect();
          } catch (err) {
            console.error("Erro ao conectar:", err);
          }
        } else {
          rl.question(
            "\nDeseja escolher outro dígito manualmente? (s/n): ",
            async (ans2) => {
              const r2 = String(ans2 || "")
                .trim()
                .toLowerCase();
              if (r2 === "s") {
                rl.question("Digite o dígito desejado (0-9): ", (d) => {
                  const manual_digit = Number(d);
                  rl.close();
                  if (
                    Number.isInteger(manual_digit) &&
                    manual_digit >= 0 &&
                    manual_digit <= 9
                  ) {
                    const trader = new DerivTrader(manual_digit);
                    try {
                      trader.connect();
                    } catch (err) {
                      console.error("Erro ao conectar:", err);
                    }
                  } else {
                    console.log("Dígito inválido. Encerrando...");
                  }
                });
              } else {
                rl.close();
                console.log("\n👋 Encerrando...");
              }
            }
          );
        }
      }
    );
  })();
}

// exporta a classe caso queira usar programaticamente
module.exports = { DerivTrader };
