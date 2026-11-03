# Transmissão de tela

Como a tela do PC chega na TV, por que cada ajuste existe, e a investigação que resolveu as travadas — com os números medidos.

## Por que WebRTC no navegador

| Tentativa | Resultado |
|---|---|
| Espelhar com Win+K (Miracast) | A TV usada não tem Miracast — modelos novos da LG removeram |
| "Transmitir" do Chrome (Google Cast) | Funciona, mas ~1 s de atraso e imagem mole |
| Cabo HDMI | Fora de questão (requisito do projeto) |
| **WebRTC na página da TV** | ✅ PC → TV direto pela rede local, sem instalar nada |

## O modo de transmissão

Depois de testar várias combinações, ficou **um modo só**, sem opções na tela — opções demais faziam as pessoas escolherem a pior.

| Ajuste | Valor | Por quê |
|---|---|---|
| Codificador | **VP8** | O H.264 por hardware de alguns PCs ignora o limite de banda (ver abaixo) |
| Resolução e quadros | **720p a 30 quadros/s** | 1080p a 15 q/s parecia travado; 720p é menos da metade do trabalho |
| Banda inicial / mínima / máxima | 2,5 / 1 / 6 Mbps | Sem banda inicial, o vídeo começa borrado; teto evita estourar o Wi-Fi da TV |
| Prioridade quando falta recurso | manter os quadros (`maintain-framerate`) | Perder nitidez incomoda menos que perder fluidez |
| Reserva na TV | **250 ms** | Absorve o Wi-Fi da TV entregando os quadros em rajadas |
| Ritmo | **30 quadros/s constantes** | O player da TV "dorme" quando a tela fica parada (ver abaixo) |

---

## A investigação

Cada problema abaixo foi resolvido **medindo**. A página de controle mostra as medidas ao vivo e guarda um **registro da sessão** (com botão Copiar), e o servidor guarda o histórico em `/diagnostico?historico=<tv>`.

### 1. Quatro segundos de atraso — que não eram da rede

O atraso aparecia numa TV e não em outra, e a primeira suspeita foi o Wi-Fi. A medida que resolveu foi a **fila de saída**: quanto cada pacote espera *dentro do PC* antes de sair pra rede (`totalPacketSendDelay` do `outbound-rtp`).

| Configuração | Fila no PC | Buffer na TV | Conclusão |
|---|---|---|---|
| H.264 (placa AMD), teto 5 Mbps | **820 ms** | 788–1594 ms | O codificador ignora o teto; o excesso vira fila |
| H.264 (placa AMD), teto 15 Mbps | **847–995 ms** | 68 ms | Produziu **15,8 Mbps** pra 720p a 15 q/s. Subir o teto não resolve: ele produz mais |
| VP8, mesma tela | **0 ms** | 15 ms | ✅ O VP8 respeita o limite |

**Lição:** um teto de banda baixo com um codificador que não obedece cria uma fila de segundos. O teto não pode ser o mecanismo de controle.

### 2. Vídeo começando em 320×180

Com VP8, os primeiros ~10 s saíam em 320×180 e 0,6 Mbps. As instruções de banda (`x-google-start-bitrate`, `x-google-min-bitrate`, `x-google-max-bitrate`) eram acrescentadas nas linhas `a=fmtp` do SDP — **e o VP8 não tem essa linha**. As instruções nunca chegavam.

A correção (`aplicarBanda` em `controle.html`) cria a linha `a=fmtp` quando ela não existe. Resultado: 1280×720 e 3,3 Mbps desde o primeiro segundo.

Isso só foi descoberto porque o teste local media a resolução segundo a segundo. Checar a sintaxe não teria pego.

### 3. Travadas com a rede perfeita

O sintoma: 29 quadros/s chegando na TV, buffer de 20 ms, zero descartados — e a imagem "travando". Pra entender, a TV passou a medir mais duas coisas:

- **Travadas:** quantas vezes a imagem congelou (`freezeCount`, `totalFreezesDuration`)
- **Irregularidade:** o desvio do intervalo entre quadros mostrados (de `totalInterFrameDelay` e `totalSquaredInterFrameDelay`). A 30 q/s o ideal é 33 ms sempre; desvio alto = ritmo irregular = vídeo parecendo travado mesmo com quadros de sobra.

Um registro real, numa sessão de 2 min 22 s:

```
13:58:11  tela  1 q/s | PC  1 q/s | rede 9 ms perda 0% | TV  5 q/s travadas 1
13:58:15  tela 29 q/s | PC 28 q/s | rede 9 ms perda 0% | TV  3 q/s travadas 2 (1875 ms parada)
13:58:17  tela 17 q/s | PC 16 q/s | rede 22 ms perda 0% | TV 30 q/s travadas 0
...
Fim. travadas 75 (47136 ms) · pacotes perdidos: 0
```

Zero pacotes perdidos — não era a rede. E o padrão era claro: **toda travada vinha logo depois de a tela ficar parada.** O Chrome só manda quadro quando a tela muda; com a tela parada, cai pra ~1 q/s. O player de vídeo da TV "dorme" nessas pausas e, quando o movimento volta, fica 1–2 s congelado antes de alcançar. No navegador do PC isso não acontece — por isso nunca apareceu nos testes locais.

#### A correção, em três tentativas

| Tentativa | O que aconteceu |
|---|---|
| Mandar o quadro novo na hora e **repetir o último só nas pausas** | Envio irregular (PC 5–20 q/s com a tela a 20–29): os dois se misturavam, e o codificador descarta quadros que chegam perto demais |
| **Relógio fixo**: um quadro a cada 33 ms, sempre o mais recente | Funcionou no teste, mas no PC real a tela parada ainda saía a 1–2 q/s: a cópia do quadro levava o mesmo "número de captura" do original, e o Chrome a descartava como "sem mudança" |
| Relógio fixo + **repetição desenhada numa tela própria** (`OffscreenCanvas`) | ✅ Quadro novo sai como veio; repetição sai de uma cópia desenhada, que é um quadro genuinamente novo |

Detalhes que fazem diferença:

- **O relógio roda num Web Worker.** O Chrome atrasa os timers de abas em segundo plano — e quem transmite está no app dele, não na aba do painel. Timers de Workers não sofrem isso.
- **Carimbo de tempo da agenda**, não da hora em que saiu: a TV vê intervalos de exatamente 33,3 ms, mesmo que o timer do sistema oscile.
- **Se o PC engasga**, a agenda recomeça dali em vez de mandar uma rajada pra compensar.

```
     tela do PC:  ▮ ▮▮ ▮      (parada)       ▮▮ ▮ ▮
 antes (envio):   ▮ ▮▮ ▮                     ▮▮ ▮ ▮   ← TV "dorme" na pausa
 depois (envio):  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮   ← sempre 30 q/s
```

### 4. As travadas que sobraram: o Wi-Fi da TV

Com o ritmo constante, as travadas caíram pela metade. As restantes aconteciam mesmo com o PC mandando 28–29 q/s e perda zero: o Wi-Fi da TV segurava pacotes e entregava em rajadas. A **reserva** da TV (`jitterBufferTarget`) subiu de 100 pra 250 ms — 0,15 s a mais de atraso, imperceptível pra mostrar uma simulação, e cobre a maioria dessas pausas.

Curiosamente, a primeira versão usava reserva **zero**, pra ter o menor atraso possível. Era exatamente isso que fazia o vídeo parecer travado: a TV mostrava cada quadro assim que chegava, no ritmo irregular do Wi-Fi.

### 5. Sites escondidos disputando o processador

Durante a transmissão, os painéis ficavam escondidos atrás do vídeo — mas continuavam rodando. Um dashboard buscando dados o tempo todo disputava o processador fraco da TV com o decodificador. Agora os painéis são descarregados quando a transmissão começa e voltam quando ela acaba.

---

## Lições

1. **Meça antes de corrigir.** Quase toda suposição inicial estava errada: não era a rede, não era o Wi-Fi, não era o processador do PC.
2. **Teste no lugar de verdade.** O navegador do PC não reproduz o player da TV; várias correções só se provaram na TV.
3. **Menos opções.** A tela de transmissão tinha qualidade e codificador pra escolher; as pessoas escolhiam o pior por engano. Um modo bom, fixo, resolveu mais que três modos.
4. **Atraso mínimo não é o objetivo.** Reserva zero deu o menor atraso e o pior vídeo.

## As medidas, na página de controle

| Linha | O que mostra |
|---|---|
| Captura da tela | Quadros novos que a tela gera por segundo |
| Este PC envia | Resolução, quadros/s, Mbps, fila de saída, o que limita |
| Rede até a TV | Ida e volta (ms) e perda de pacotes |
| A TV recebe | Quadros/s, espera no buffer, decodificação, descartados, travadas, irregularidade |
| Diagnóstico | O maior gargalo encontrado, em português, com o que fazer |

O **registro da sessão** grava uma linha a cada 10 s (e na hora, quando aparece um problema) e fecha com um resumo: duração, média de quadros na TV, total de travadas, maior irregularidade, maior buffer e maior fila.
