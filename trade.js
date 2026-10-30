const WebSocket = require("ws");
const readline = require("readline");
require("./load_env").loadEnv();
const { getBestDigit } = require("./deriv_digits"); // módulo anterior
const { authenticatedWsUrl, lastDigit } = require("./deriv_api");

// ---------------- CONFIGURAÇÕES ----------------
const CONFIG = {
  app_id: process.env.DERIV_APP_ID,
  api_token: process.env.DERIV_API_TOKEN,
  account_id: process.env.DERIV_ACCOUNT_ID,
  symbol: process.env.DERIV_SYMBOL || "1HZ25V",
  initial_stake: 0.35,
  max_attempts: 20,
  wait_after_target: 6,
};

// ------------------------------------------------

class DerivTrader {
  constructor(target_digit) {
    if (!Number.isInteger(Number(target_digit)) || Number(target_digit) < 0 || Number(target_digit) > 9) {
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
    this.active_contract_id = null;
    this.settled_contracts = new Set();
    this.contract_subscription_id = null;
    this.tick_subscription_id = null;
    this.pending_buy = false;

    // último tick conhecido
    this.last_tick_price = null;
    this.last_tick_digit = null;

    // fila simples para enviar (evita race naive)
    this.sendQueue = Promise.resolve();

    // controle de reinício
    this.awaiting_restart = false;

    console.log(`\n🎯 DÍGITO ALVO: ${this.target_digit}`);
    console.log("=".repeat(60));

    if (!CONFIG.api_token || !CONFIG.app_id || !CONFIG.account_id) {
      throw new Error("Defina DERIV_API_TOKEN, DERIV_APP_ID e DERIV_ACCOUNT_ID");
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
                if (err) {
                  console.error("⚠️ Erro ao enviar payload:", err);
                  this.state = "STOPPED";
                }
                resolve();
              });
            } else {
              console.error("⚠️ WebSocket fechado; operação interrompida");
              this.state = "STOPPED";
              resolve();
            }
          } catch (e) {
            console.error("⚠️ Erro ao enviar payload:", e);
            this.state = "STOPPED";
            resolve();
          }
        });
      })
      .catch((_) => {}); // evitar rejection cascade
  }

  getLastDigit(price, pipSize) {
    return lastDigit(price, pipSize);
  }

  calculateStake(attempt) {
    // recursivo conforme original: attempt 1 -> initial_stake
    if (attempt === 1) return CONFIG.initial_stake;
    const prev = this.calculateStake(attempt - 1);
    // round to 2 decimals
    return Math.round((prev + attempt / 100) * 100) / 100;
  }

  async connect() {
    const wsUrl = await authenticatedWsUrl({
      token: CONFIG.api_token,
      appId: CONFIG.app_id,
      accountId: CONFIG.account_id,
    });
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log("✅ Conectado à Deriv API");
      this.safeSend({ balance: 1 });
    });

    this.ws.on("message", (message) => {
      let response;
      try {
        response = JSON.parse(message);
      } catch (e) {
        console.error("Resposta WebSocket inválida:", e.message);
        return;
      }
      if (response.error) {
        console.error("❌ Erro da Deriv:", response.error.message || JSON.stringify(response.error));
        if (response.msg_type === "buy" || response.msg_type === "proposal_open_contract" || response.msg_type === "balance" || response.msg_type === "tick") {
          this.pending_buy = false;
          this.state = "STOPPED";
          this.ws.close();
        }
        return;
      }
      const msg_type = response.msg_type;
      if (msg_type === "balance") {
        const balance = response.balance || {};
        if (balance.balance == null || !balance.currency) {
          console.error("Resposta de saldo incompleta");
          this.state = "STOPPED";
          return;
        }
        this.balance = balance.balance !== undefined ? Number(balance.balance) : this.balance;
        this.currency = balance.currency || this.currency;
        this.is_authorized = true;
        console.log(
          `✅ Conta conectada | Saldo: ${this.balance} ${this.currency}\n`
        );
        this.subscribeTicks();
        return;
      }

      if (msg_type === "tick") {
        const tick = response.tick;
        if (!tick) return;
        const price = tick.quote;
        if (price == null) return;
        let digit;
        try { digit = this.getLastDigit(price, tick.pip_size); } catch (error) {
          console.error(error.message);
          this.state = "STOPPED";
          return;
        }
        if (response.subscription?.id) this.tick_subscription_id = response.subscription.id;
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
        const buy_data = response.buy;
        if (!this.pending_buy) return;
        if (!buy_data?.contract_id) {
          console.error("Resposta de compra incompleta; operações interrompidas");
          this.state = "STOPPED";
          this.pending_buy = false;
          return;
        }
        this.pending_buy = false;
        const contract_id = buy_data.contract_id;
        this.active_contract_id = contract_id;
        const buy_price = buy_data.buy_price != null && Number.isFinite(Number(buy_data.buy_price))
          ? Number(buy_data.buy_price) : this.current_stake;
        this.current_stake = buy_price;
        this.total_invested += buy_price;
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
        const contract = response.proposal_open_contract;
        if (!contract || String(contract.contract_id) !== String(this.active_contract_id)) return;
        if (response.subscription?.id) this.contract_subscription_id = response.subscription.id;
        this.handleContractUpdate(contract);
        return;
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
    if (this.pending_buy || this.active_contract_id || this.state !== "TRADING") return;
    const request = {
      buy: "1",
      price: stake,
      parameters: {
        contract_type: "DIGITMATCH",
        underlying_symbol: CONFIG.symbol,
        duration: 1,
        duration_unit: "t",
        basis: "stake",
        amount: stake,
        barrier: String(digit),
        currency: this.currency,
      },
    };
    this.pending_buy = true;
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
    const contract_id = String(contract.contract_id);

    if (status === "open" || (!contract.is_sold && status !== "won" && status !== "lost") || this.settled_contracts.has(contract_id)) return;
    this.settled_contracts.add(contract_id);
    this.active_contract_id = null;
    if (this.contract_subscription_id) {
      this.safeSend({ forget: this.contract_subscription_id });
      this.contract_subscription_id = null;
    }

    const profit = Number(contract.profit);
    const buy_price = Number(contract.buy_price);
    if (contract.profit == null || contract.buy_price == null ||
        !Number.isFinite(profit) || !Number.isFinite(buy_price)) {
      console.error("Resultado de contrato incompleto; operações interrompidas");
      this.state = "STOPPED";
      return;
    }
    this.total_invested += buy_price - this.current_stake;
    this.current_stake = buy_price;

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
      if (this.tick_subscription_id) this.safeSend({ forget: this.tick_subscription_id });
      this.tick_subscription_id = null;
      this.generateFinalReport();
      this.state = "STOPPED";
      this.awaiting_restart = true;
      // pergunta se reiniciar (não bloqueia o ws)
      this.askRestart();
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`❌ PERDEU! Perda: $${Math.abs(profit).toFixed(2)}`);

    console.log(`🎲 Cotação de saída: ${contract.exit_spot ?? "(não informada)"}`);

    console.log(
      `📊 Total investido até agora: $${this.total_invested.toFixed(2)}`
    );

    if (this.current_attempt < CONFIG.max_attempts) {
      this.current_attempt += 1;
      const stake = this.calculateStake(this.current_attempt);
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
          this.settled_contracts.clear();
          this.awaiting_restart = false;
          // Atualiza o alvo antes de voltar a contar ticks.
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
          this.subscribeTicks();
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
  const best_digit = await getBestDigit(true);
  if (best_digit == null) throw new Error("Histórico de ticks vazio");
  return best_digit;
}

// se executado diretamente
if (require.main === module) {
  (async () => {
    if (!CONFIG.api_token || !CONFIG.app_id || !CONFIG.account_id) {
      console.error("Defina DERIV_API_TOKEN, DERIV_APP_ID e DERIV_ACCOUNT_ID");
      process.exitCode = 1;
      return;
    }
    console.log("\n" + "=".repeat(60));
    console.log("🤖 DERIV TRADING BOT - DÍGITO COMBINA");
    console.log("=".repeat(60));

    let best_digit;
    try { best_digit = await get_best_digit(); } catch (error) {
      console.error("Erro na análise:", error.message);
      process.exitCode = 1;
      return;
    }

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
          rl.close();
          try {
            const trader = new DerivTrader(best_digit);
            await trader.connect();
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
                rl.question("Digite o dígito desejado (0-9): ", async (d) => {
                  const manual_digit = Number(d);
                  rl.close();
                  if (
                    Number.isInteger(manual_digit) &&
                    manual_digit >= 0 &&
                    manual_digit <= 9
                  ) {
                    try {
                      const trader = new DerivTrader(manual_digit);
                      await trader.connect();
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
