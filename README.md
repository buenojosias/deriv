# Bot Deriv Digit Match

Scripts Node.js para consultar ticks, analisar a frequência dos últimos dígitos e operar contratos Digit Match. A análise usa 50 ticks; essa frequência não comprova vantagem para o próximo tick.

## Instalação

Requer Node.js 18 ou superior. Execute `npm ci`.

Para consultas públicas, use `npm run tick` ou `npm run analyze`. O símbolo padrão é `1HZ25V` (Volatility 25 (1s) Index); configure `DERIV_SYMBOL` para usar outro. O bot compra contratos Matches (`DIGITMATCH`); o mercado também oferece Differs (`DIGITDIFF`), que ainda não faz parte da estratégia.

## Operação

Registre um aplicativo PAT na Deriv e obtenha uma conta Options. Preencha o arquivo `.env` (modelo em `.env.example`) com `DERIV_API_TOKEN` (token com escopo `trade`), `DERIV_APP_ID` (ID do aplicativo atual) e `DERIV_ACCOUNT_ID` (ID da conta demo ou real, como `DOT90004580`). Depois execute `npm run trade`. Variáveis definidas no sistema têm prioridade sobre o arquivo. O bot solicita um OTP via REST e usa a URL WebSocket autenticada retornada pela Deriv. A conta indicada determina se as compras usam saldo demo ou real.

O App ID é individual: entre no [Dashboard de desenvolvedores da Deriv](https://developers.deriv.com/dashboard/), abra os aplicativos registrados e copie o App ID de um aplicativo do tipo PAT. O ID legado `1089` não funciona na API atual. O ID da conta Options é um valor separado, obtido na lista de contas da Deriv.

O script pede confirmação antes de operar. Cada sequência pode fazer até 20 compras; os valores configurados somam US$ 22,20 se todas forem executadas. Revogue qualquer token que tenha sido salvo no código ou no histórico Git.

Depois da primeira compra, cada tick seguinte decide o ciclo: se o dígito for diferente do alvo, o bot envia outra compra imediatamente, sem aguardar a resposta da anterior. Se for igual, para de enviar compras e espera a liquidação das ordens pendentes para montar o relatório. O limite de 20 compras também interrompe novos envios.

Ao escolher iniciar outro ciclo, o bot analisa novamente os 50 ticks e mostra o dígito sugerido. Ele aguarda sua confirmação para operar com esse dígito ou permite escolher outro manualmente, como no primeiro ciclo. A contagem só recomeça depois dessa escolha.

Ao fim de cada ciclo, o bot salva um arquivo `.txt` na pasta `results/` com símbolo, dígito alvo, contrato, valor da entrada e dígito de saída de cada ordem, além dos totais. Se a Deriv não informar `exit_spot` em um contrato, o dígito aparece como `indisponível`.
O final do arquivo contém a análise dos 50 ticks (últimos 10 e frequência dos dígitos), a sequência observada até aparecer o dígito alvo que inicia a contagem (hora, preço e dígito em cada linha) e cada tick da contagem antes da primeira compra. Se o alvo reaparecer durante a contagem, o valor registrado volta a zero.

## Validação

Execute `npm test`. Os testes usam respostas locais e não enviam compras.

Referências: [autenticação e OTP](https://developers.deriv.com/docs/options/websocket/), [compra](https://developers.deriv.com/docs/trading/buy/), [ticks](https://developers.deriv.com/comparison/ticks/).
