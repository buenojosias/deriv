# Bot Deriv Digit Match

Scripts Node.js para consultar ticks, analisar a frequência dos últimos dígitos e operar contratos Digit Match. A análise usa 50 ticks; essa frequência não comprova vantagem para o próximo tick.

## Instalação

Requer Node.js 18 ou superior. Execute `npm ci`.

Para consultas públicas, use `npm run tick` ou `npm run analyze`. O símbolo padrão é `1HZ25V` (Volatility 25 (1s) Index); configure `DERIV_SYMBOL` para usar outro. O bot compra contratos Matches (`DIGITMATCH`); o mercado também oferece Differs (`DIGITDIFF`), que ainda não faz parte da estratégia.

## Operação

Registre um aplicativo PAT na Deriv e obtenha uma conta Options. Preencha o arquivo `.env` (modelo em `.env.example`) com `DERIV_API_TOKEN` (token com escopo `trade`), `DERIV_APP_ID` (ID do aplicativo atual) e `DERIV_ACCOUNT_ID` (ID da conta demo ou real, como `DOT90004580`). Depois execute `npm run trade`. Variáveis definidas no sistema têm prioridade sobre o arquivo. O bot solicita um OTP via REST e usa a URL WebSocket autenticada retornada pela Deriv. A conta indicada determina se as compras usam saldo demo ou real.

O App ID é individual: entre no [Dashboard de desenvolvedores da Deriv](https://developers.deriv.com/dashboard/), abra os aplicativos registrados e copie o App ID de um aplicativo do tipo PAT. O ID legado `1089` não funciona na API atual. O ID da conta Options é um valor separado, obtido na lista de contas da Deriv.

O script pede confirmação antes de operar. Cada sequência pode fazer até 20 compras; os valores configurados somam US$ 22,20 se todas forem executadas. Revogue qualquer token que tenha sido salvo no código ou no histórico Git.

## Validação

Execute `npm test`. Os testes usam respostas locais e não enviam compras.

Referências: [autenticação e OTP](https://developers.deriv.com/docs/options/websocket/), [compra](https://developers.deriv.com/docs/trading/buy/), [ticks](https://developers.deriv.com/comparison/ticks/).
