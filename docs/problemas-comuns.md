# Problemas comuns

Cada linha aqui aconteceu de verdade.

## Painel

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| A TV mostra "Servidor fora do ar" | Servidor parado, IP mudou, ou (Chromebook) encaminhamento de portas desligado | Veja se `http://<ip>:8080/config` abre num PC. No Chromebook: abra o Terminal (sobe o painel) e confira as portas |
| A TV carrega infinitamente | A TV está em outra rede Wi-Fi | Coloque TV e servidor na mesma rede |
| Ninguém acha o servidor depois de reiniciar | O IP mudou | Reserve o IP no roteador. Pra achar o novo: abra `http://<faixa>.N:8080/config` pra cada N, ou veja o IP nas configurações de rede |
| (Chromebook) As portas estão "ligadas", mas nada responde | O IP ou a rede mudou depois que elas foram ligadas | Desligue e ligue cada porta de novo |
| (Chromebook) Responde por um IP que ninguém alcança | Cabo e Wi-Fi conectados: as portas vão pela rede do cabo | Deixe uma rede só |
| (Chromebook) O painel cai sozinho de vez em quando | O Chromebook suspendeu e o Linux parou | Desligue "Suspender ao fechar a tampa" |
| Um painel fica em branco com "Este site não carregou" | O site proíbe ser exibido em quadro | Use o botão "Abrir o site direto", ou o modo intermediário |
| Site abre deslogado no painel, logado em tela cheia | Cookie de terceiros bloqueado | Modo intermediário — ver [sites com login](sites-com-login.md) |
| Site abre logado, mas sem dados | Os dados vêm de outro servidor, que recusa o endereço do intermediário (CORS) | Acrescente esse servidor em `apis` do intermediário |
| A TV entra em proteção de tela | Nenhum vídeo tocando e ninguém mexendo no controle | Já tratado pelo `acordada.mp4`; recarregue a página da TV se ela for antiga |
| Painel com `localhost` não abre na TV | `localhost` na TV é a própria TV | Use o IP do servidor |

## Transmissão

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Botão "Compartilhar" desabilitado com aviso sobre `http://` | O Chrome bloqueia captura de tela fora de HTTPS | Libere o endereço em `chrome://flags/#unsafely-treat-insecure-origin-as-secure` ([passo a passo](instalacao.md#transmissão-de-tela-uma-vez-por-pc)) |
| Funcionava e parou de funcionar | O IP do servidor mudou e a liberação é por endereço | Refaça a liberação com o novo IP |
| "A conexão não fechou em 15 segundos" | PC e TV em redes diferentes | Coloque os dois na mesma rede — o servidor avisa quando detecta isso |
| "Outra pessoa está transmitindo" | Uma transmissão por TV | Espere a pessoa parar (ou use a outra TV) |
| Atraso de segundos | Fila dentro do PC (codificador que ignora o limite de banda) | Veja "fila de saída" nas medidas. O padrão (VP8) já evita isso |
| Imagem trava de vez em quando | Ver o registro da sessão: "travadas" com "PC" estável e perda zero = Wi-Fi da TV | TV no cabo de rede ou Wi-Fi de 5 GHz |
| "A tela só gera N quadros/s" | O app mostrado atualiza devagar, ou o PC está sobrecarregado | Feche programas pesados; compartilhe só a janela do app |

## Ferramentas pra investigar

| Onde | O que dá pra ver |
|---|---|
| Página de controle, durante a transmissão | Medidas ao vivo e o diagnóstico em português |
| Registro da sessão (botão **Copiar**) | Tudo o que aconteceu, do início ao fim, com resumo |
| `http://<ip>:8080/diagnostico` | Últimas medidas de cada TV, sem precisar de print |
| `http://<ip>:8080/diagnostico?historico=<tv>` | As últimas 300 medidas de uma TV |
| `http://<ip>:8080/tv?nome=teste` | Uma TV de mentira num PC, pra testar sem mexer nas TVs de verdade |
| `painel.log` (ou `journalctl -u painel-tv`) | Log do servidor |
