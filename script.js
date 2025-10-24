const WebSocket = require('ws');

// CONFIGURAÇÕES
const CONFIG = {
  appId: 1089, // App ID público da Deriv
  symbol: 'R_25', // Volatility 25 Index
};

// Conecta ao WebSocket da Deriv
const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.appId}`;
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('✅ Conectado à Deriv API\n');
  
  // Solicita o último tick do símbolo
  ws.send(JSON.stringify({
    ticks: CONFIG.symbol,
  }));
});

ws.on('message', (data) => {
  const response = JSON.parse(data);
  
  // Verifica se há erro
  if (response.error) {
    console.error('❌ Erro:', response.error.message);
    ws.close();
    return;
  }
  
  // Processa o tick recebido
  if (response.msg_type === 'tick') {
    const tick = response.tick;
    const lastDigit = getLastDigit(tick.quote);
    const time = new Date(tick.epoch * 1000);
    
    console.log('📊 ÚLTIMA MOVIMENTAÇÃO:');
    console.log('─────────────────────────────────');
    console.log(`⏰ Horário: ${time.toLocaleString('pt-BR')}`);
    console.log(`💰 Preço: ${tick.quote}`);
    console.log(`🎲 Último Dígito: ${lastDigit}`);
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
  process.exit(0);
});

// Função para extrair o último dígito
function getLastDigit(price) {
  const priceStr = price.toString().replace('.', '');
  return parseInt(priceStr[priceStr.length - 1]);
}