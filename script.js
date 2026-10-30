const WebSocket = require('ws');
const { PUBLIC_WS_URL, lastDigit } = require('./deriv_api');

// CONFIGURAÇÕES
const CONFIG = {
  symbol: process.env.DERIV_SYMBOL || '1HZ25V',
};

// Conecta ao WebSocket da Deriv
const ws = new WebSocket(PUBLIC_WS_URL);

ws.on('open', () => {
  console.log('✅ Conectado à Deriv API\n');
  
  // Solicita o último tick do símbolo
  ws.send(JSON.stringify({
    ticks: CONFIG.symbol,
  }));
});

ws.on('message', (data) => {
  let response;
  try { response = JSON.parse(data); } catch (error) {
    console.error('Resposta inválida:', error.message);
    ws.close();
    return;
  }
  
  // Verifica se há erro
  if (response.error) {
    console.error('❌ Erro:', response.error.message);
    ws.close();
    return;
  }
  
  // Processa o tick recebido
  if (response.msg_type === 'tick') {
    const tick = response.tick;
    if (tick?.quote == null) return;
    let digit;
    try { digit = lastDigit(tick.quote, tick.pip_size); } catch (error) {
      console.error(error.message);
      ws.close();
      return;
    }
    const time = new Date(tick.epoch * 1000);
    
    console.log('📊 ÚLTIMA MOVIMENTAÇÃO:');
    console.log('─────────────────────────────────');
    console.log(`⏰ Horário: ${time.toLocaleString('pt-BR')}`);
    console.log(`💰 Preço: ${Number(tick.quote).toFixed(tick.pip_size)}`);
    console.log(`🎲 Último Dígito: ${digit}`);
    console.log(`📍 Símbolo: ${tick.symbol}`);
    console.log('─────────────────────────────────\n');
    
    // Fecha a conexão após obter o tick
    ws.close();
  }
});

ws.on('error', (error) => {
  console.error('❌ Erro no WebSocket:', error.message);
});

ws.on('close', () => {
  console.log('🔌 Conexão encerrada');
});
