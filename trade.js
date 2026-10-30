const WebSocket = require("ws");
const readline = require("node:readline/promises");
const path = require("node:path");
require("./load_env").loadEnv();
const { getDigitAnalysis } = require("./deriv_digits");
const { authenticatedWsUrl, lastDigit } = require("./deriv_api");
const { exitDigit, writeCycleReport } = require("./result_report");

const CONFIG = {
  app_id: process.env.DERIV_APP_ID,
  api_token: process.env.DERIV_API_TOKEN,
  account_id: process.env.DERIV_ACCOUNT_ID,
  symbol: process.env.DERIV_SYMBOL || "1HZ25V",
  initial_stake: 0.35,
  max_attempts: 20,
  wait_after_target: 6,
};

async function confirmAnalysis(initialAnalysis, question, analyze) {
  let analysis = initialAnalysis;
  while (true) {
    if (analysis.bestDigit == null) throw new Error("Histórico de ticks vazio");
    const answer = (await question(`Dígito sugerido: ${analysis.bestDigit}. Iniciar? (s/n): `)).trim().toLowerCase();
    if (answer === "s") return analysis;
    if (answer === "n") analysis = await analyze(true);
    else console.log("Responda s ou n.");
  }
}

class DerivTrader {
  constructor(targetDigit, analysis = null) {
    if (!Number.isInteger(Number(targetDigit)) || Number(targetDigit) < 0 || Number(targetDigit) > 9) {
      throw new Error("O dígito alvo deve ser um inteiro de 0 a 9");
    }
    if (!CONFIG.api_token || !CONFIG.app_id || !CONFIG.account_id) {
      throw new Error("Defina DERIV_API_TOKEN, DERIV_APP_ID e DERIV_ACCOUNT_ID");
    }

    this.target_digit = Number(targetDigit);
    this.analysis = analysis;
    this.digits_before_count = [];
    this.counting_ticks = [];
    this.ws = null;
    this.state = "ANALYZING"; // ANALYZING, WAITING, TRADING, DRAINING, STOPPED
    this.currency = null;
    this.balance = null;
    this.digits_after_target = 0;
    this.current_attempt = 0;
    this.total_invested = 0;
    this.contracts_history = [];
    this.pending_buys = new Map(); // req_id -> { attempt, stake }
    this.open_contracts = new Map(); // contract_id -> { attempt, stake, subscriptionId }
    this.settled_contracts = new Set();
    this.next_request_id = 1;
    this.tick_subscription_id = null;
    this.awaiting_next_tick = false;
    this.last_tick_key = null;
    this.sendQueue = Promise.resolve(); // acompanha envios pendentes nos testes
    this.awaiting_restart = false;
    this.results_directory = path.join(__dirname, "results");
    console.log(`\n🎯 DÍGITO ALVO: ${this.target_digit}`);
  }

  // ws.send é chamado no próprio evento do tick, sem aguardar outros envios.
  safeSend(payload, onSent) {
    const operation = new Promise((resolve) => {
      if (payload.buy && this.state !== "TRADING") {
        resolve(false);
        return;
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.error("WebSocket fechado; envio cancelado");
        resolve(false);
        return;
      }
      try {
        let failedSynchronously = false;
        this.ws.send(JSON.stringify(payload), (error) => {
          if (error) {
            failedSynchronously = true;
            console.error("Erro ao enviar mensagem:", error.message);
          }
          resolve(!error);
        });
        if (onSent && !failedSynchronously) onSent();
      } catch (error) {
        console.error("Erro ao enviar mensagem:", error.message);
        resolve(false);
      }
    });
    this.sendQueue = Promise.all([this.sendQueue, operation]).then(() => undefined);
    return operation;
  }

  calculateStake(attempt) {
    // Mesma progressão de valores usada anteriormente.
    return Math.round((CONFIG.initial_stake + ((attempt * (attempt + 1)) / 2 - 1) / 100) * 100) / 100;
  }

  async connect() {
    const wsUrl = await authenticatedWsUrl({
      token: CONFIG.api_token,
      appId: CONFIG.app_id,
      accountId: CONFIG.account_id,
    });
    this.ws = new WebSocket(wsUrl);
    this.ws.on("open", () => {
      console.log("✅ Conectado à conta Options da Deriv");
      this.safeSend({ balance: 1 }).then((sent) => {
        if (!sent) this.stopWithError("Não foi possível consultar o saldo");
      });
    });
    this.ws.on("message", (raw) => {
      let response;
      try {
        response = JSON.parse(raw);
      } catch (error) {
        this.stopWithError(`Resposta inválida: ${error.message}`);
        return;
      }
      this.handleMessage(response);
    });
    this.ws.on("error", (error) => this.stopWithError(`WebSocket: ${error.message}`));
    this.ws.on("close", () => {
      if (this.state !== "STOPPED") {
        this.stopWithError("Conexão encerrada antes da conclusão do ciclo");
      }
      console.log("🔌 Conexão encerrada");
    });
  }

  handleMessage(response) {
    if (response.error) {
      this.handleApiError(response);
      return;
    }
    if (response.msg_type === "balance") {
      const { balance, currency } = response.balance || {};
      if (!Number.isFinite(Number(balance)) || !currency) {
        this.stopWithError("Resposta de saldo incompleta");
        return;
      }
      this.balance = Number(balance);
      this.currency = currency;
      console.log(`✅ Conta conectada | Saldo: ${this.balance} ${this.currency}`);
      if (this.state === "ANALYZING" && !this.tick_subscription_id) this.subscribeTicks();
      return;
    }
    if (response.msg_type === "tick") {
      this.handleTick(response);
      return;
    }
    if (response.msg_type === "buy") {
      this.handleBuy(response);
      return;
    }
    if (response.msg_type === "proposal_open_contract") {
      this.handleContractUpdate(response.proposal_open_contract, response.subscription?.id);
    }
  }

  handleApiError(response) {
    const message = response.error?.message || JSON.stringify(response.error);
    console.error(`❌ Erro da Deriv (${response.msg_type || "desconhecido"}): ${message}`);
    if (response.msg_type === "buy") {
      if (response.req_id != null) this.pending_buys.delete(response.req_id);
      this.stopCycle("compra recusada");
      return;
    }
    if (response.msg_type === "proposal_open_contract") {
      this.stopWithError("Não foi possível acompanhar um contrato comprado");
      return;
    }
    if (response.msg_type === "forget") return;
    this.stopWithError("Falha na comunicação com a Deriv");
  }

  subscribeTicks() {
    this.safeSend({ ticks: CONFIG.symbol, subscribe: 1 }).then((sent) => {
      if (!sent) this.stopWithError("Não foi possível assinar os ticks");
    });
  }

  handleTick(response) {
    const tick = response.tick;
    if (tick?.quote == null) return;
    let digit;
    try {
      digit = lastDigit(tick.quote, tick.pip_size);
    } catch (error) {
      this.stopWithError(error.message);
      return;
    }
    if (response.subscription?.id) this.tick_subscription_id = response.subscription.id;
    const key = tick.epoch == null ? null : `${tick.epoch}:${tick.quote}`;
    if (key && key === this.last_tick_key) return;
    this.last_tick_key = key;

    if (this.state === "TRADING") {
      if (!this.awaiting_next_tick) return;
      this.awaiting_next_tick = false;
      console.log(`🎲 Próximo dígito: ${digit}`);
      if (digit === this.target_digit) {
        this.stopCycle("dígito alvo observado");
      } else if (this.current_attempt >= CONFIG.max_attempts) {
        this.stopCycle("limite de tentativas atingido");
      } else {
        this.buyContract();
      }
      return;
    }

    if (this.state === "ANALYZING") {
      this.digits_before_count.push({
        time: new Date(tick.epoch * 1000).toTimeString().split(" ")[0],
        price: String(tick.quote),
        digit,
      });
      if (digit === this.target_digit) {
        this.state = "WAITING";
        this.digits_after_target = 0;
        console.log("🎯 Dígito alvo apareceu; iniciando contagem");
      }
      return;
    }
    if (this.state === "WAITING") {
      this.digits_after_target = digit === this.target_digit ? 0 : this.digits_after_target + 1;
      this.counting_ticks.push({ digit, count: this.digits_after_target });
      console.log(`🎲 Dígito: ${digit} | Contagem: ${this.digits_after_target}/${CONFIG.wait_after_target}`);
      if (this.digits_after_target >= CONFIG.wait_after_target) {
        this.state = "TRADING";
        console.log("🚀 Iniciando operações");
        this.buyContract();
      }
    }
  }

  buyContract() {
    if (this.state !== "TRADING" || this.current_attempt >= CONFIG.max_attempts) return;
    const attempt = ++this.current_attempt;
    const stake = this.calculateStake(attempt);
    const reqId = this.next_request_id++;
    this.pending_buys.set(reqId, { attempt, stake });
    this.awaiting_next_tick = false;
    console.log(`💵 Entrada #${attempt}/${CONFIG.max_attempts}: ${stake.toFixed(2)} ${this.currency}`);
    const request = {
      buy: "1",
      price: stake,
      req_id: reqId,
      parameters: {
        contract_type: "DIGITMATCH",
        underlying_symbol: CONFIG.symbol,
        duration: 1,
        duration_unit: "t",
        basis: "stake",
        amount: stake,
        barrier: String(this.target_digit),
        currency: this.currency,
      },
    };
    this.safeSend(request, () => {
      if (this.state === "TRADING") this.awaiting_next_tick = true;
    }).then((sent) => {
      if (!sent) {
        this.pending_buys.delete(reqId);
        this.stopCycle("falha ao enviar compra");
      }
    });
  }

  handleBuy(response) {
    const pending = this.pending_buys.get(response.req_id);
    if (!pending) {
      this.stopWithError("Resposta de compra sem req_id conhecido");
      return;
    }
    this.pending_buys.delete(response.req_id);
    const buy = response.buy;
    if (!buy?.contract_id) {
      this.stopWithError("Resposta de compra sem ID do contrato");
      return;
    }
    const price = buy.buy_price != null && Number.isFinite(Number(buy.buy_price))
      ? Number(buy.buy_price) : pending.stake;
    const id = String(buy.contract_id);
    this.total_invested += price;
    this.open_contracts.set(id, { ...pending, stake: price, subscriptionId: null });
    console.log(`✅ Compra #${pending.attempt} confirmada | Contrato ${id} | Pago: ${price.toFixed(2)} ${this.currency}`);
    this.safeSend({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 }).then((sent) => {
      if (!sent) this.stopWithError(`Não foi possível acompanhar o contrato ${id}`);
    });
    this.maybeFinalize();
  }

  handleContractUpdate(contract, subscriptionId) {
    if (!contract?.contract_id) return;
    const id = String(contract.contract_id);
    const record = this.open_contracts.get(id);
    if (!record || this.settled_contracts.has(id)) return;
    if (subscriptionId) record.subscriptionId = subscriptionId;
    if (contract.status === "open" || (!contract.is_sold && !["won", "lost"].includes(contract.status))) return;
    const profit = Number(contract.profit);
    const buyPrice = Number(contract.buy_price);
    if (contract.profit == null || contract.buy_price == null ||
        !Number.isFinite(profit) || !Number.isFinite(buyPrice)) {
      this.stopWithError(`Resultado incompleto do contrato ${id}`);
      return;
    }
    this.settled_contracts.add(id);
    this.open_contracts.delete(id);
    this.total_invested += buyPrice - record.stake;
    const payout = buyPrice + profit;
    this.contracts_history.push({
      attempt: record.attempt,
      contractId: id,
      stake: buyPrice,
      returnedDigit: exitDigit(contract.exit_spot),
      profit,
      payout,
    });
    console.log(`${profit > 0 ? "✅" : "❌"} Contrato #${record.attempt} ${contract.status}: ${profit.toFixed(2)} ${this.currency}`);
    if (record.subscriptionId) this.safeSend({ forget: record.subscriptionId });
    this.maybeFinalize();
  }

  stopCycle(reason) {
    if (this.state !== "TRADING" && this.state !== "DRAINING") return;
    if (this.state === "TRADING") {
      this.state = "DRAINING";
      this.awaiting_next_tick = false;
      console.log(`🛑 Ciclo encerrado: ${reason}`);
      if (this.tick_subscription_id) this.safeSend({ forget: this.tick_subscription_id });
      this.tick_subscription_id = null;
    }
    this.maybeFinalize();
  }

  maybeFinalize() {
    if (this.state !== "DRAINING" || this.pending_buys.size || this.open_contracts.size) return;
    this.state = "STOPPED";
    this.generateFinalReport();
    this.awaiting_restart = true;
    this.askRestart();
  }

  stopWithError(message) {
    if (this.state === "STOPPED") return;
    console.error(`❌ ${message}`);
    this.state = "STOPPED";
    this.awaiting_next_tick = false;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
  }

  generateFinalReport() {
    const payouts = this.contracts_history.reduce((sum, item) => sum + item.payout, 0);
    const profit = payouts - this.total_invested;
    console.log("\n📊 RELATÓRIO FINAL");
    console.log(`Dígito alvo: ${this.target_digit}`);
    console.log(`Ordens enviadas: ${this.current_attempt}`);
    console.log(`Contratos liquidados: ${this.contracts_history.length}`);
    console.log(`Total investido: ${this.total_invested.toFixed(2)} ${this.currency}`);
    console.log(`Total recebido: ${payouts.toFixed(2)} ${this.currency}`);
    console.log(`Resultado líquido: ${profit.toFixed(2)} ${this.currency}\n`);
    try {
      const reportPath = writeCycleReport({
        directory: this.results_directory,
        symbol: CONFIG.symbol,
        targetDigit: this.target_digit,
        contracts: this.contracts_history,
        ordersSent: this.current_attempt,
        totalInvested: this.total_invested,
        currency: this.currency,
        analysis: this.analysis,
        digitsBeforeCount: this.digits_before_count,
        countingTicks: this.counting_ticks,
        waitAfterTarget: CONFIG.wait_after_target,
      });
      console.log(`📄 Relatório salvo em: ${reportPath}`);
    } catch (error) {
      console.error(`❌ Não foi possível salvar o relatório: ${error.message}`);
    }
  }

  async askRestart({ analyze = getDigitAnalysis, createInterface = readline.createInterface } = {}) {
    if (!this.awaiting_restart) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Iniciar novo ciclo? (s/n): ")).trim().toLowerCase();
      if (answer !== "s") {
        this.ws?.close();
        return;
      }
      const analysis = await analyze(true);
      const confirmed = await confirmAnalysis(analysis, (prompt) => rl.question(prompt), analyze);
      this.target_digit = confirmed.bestDigit;
      this.analysis = confirmed;
      this.state = "ANALYZING";
      this.digits_after_target = 0;
      this.digits_before_count = [];
      this.counting_ticks = [];
      this.current_attempt = 0;
      this.total_invested = 0;
      this.contracts_history = [];
      this.pending_buys.clear();
      this.open_contracts.clear();
      this.settled_contracts.clear();
      this.last_tick_key = null;
      this.subscribeTicks();
      console.log(`🎯 Novo dígito alvo: ${this.target_digit}`);
    } catch (error) {
      console.error(`❌ Falha ao iniciar novo ciclo: ${error.message}`);
      this.ws?.close();
    } finally {
      this.awaiting_restart = false;
      rl.close();
    }
  }
}

async function main() {
  if (!CONFIG.api_token || !CONFIG.app_id || !CONFIG.account_id) {
    throw new Error("Defina DERIV_API_TOKEN, DERIV_APP_ID e DERIV_ACCOUNT_ID");
  }
  console.log("🤖 DERIV TRADING BOT - DÍGITO COMBINA");
  const analysis = await getDigitAnalysis(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let confirmed;
  try {
    confirmed = await confirmAnalysis(analysis, (prompt) => rl.question(prompt), getDigitAnalysis);
  } finally {
    rl.close();
  }
  const trader = new DerivTrader(confirmed.bestDigit, confirmed);
  await trader.connect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Erro:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { DerivTrader, CONFIG, confirmAnalysis };
