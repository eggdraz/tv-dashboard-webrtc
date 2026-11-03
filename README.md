# Painel das TVs

Transforma TVs com navegador (testado em LG webOS) em painéis de escritório,
usando um computador velho ou um Chromebook como servidor — sem cabos e sem
comprar nada.

- **Painéis:** cada TV abre uma página que mostra um ou dois sites lado a lado,
  com zoom. Uma página de controle, aberta em qualquer PC da rede, decide o que
  cada TV mostra.
- **Transmissão de tela:** qualquer pessoa transmite a tela do PC ao vivo pra
  uma TV, direto pela rede local (WebRTC, PC → TV). Duas TVs, duas pessoas
  transmitindo ao mesmo tempo.
- **Sites com login:** um intermediário (proxy) faz sites com login funcionarem
  dentro do painel, onde o navegador da TV normalmente recusaria o cookie.
- **Zero dependências:** um único `server.js` em Node 18+, sem `npm install`.

## Como rodar

```bash
node server.js
```

- Controle: `http://<ip-do-servidor>:8080/`
- Cada TV: `http://<ip-do-servidor>:8080/tv?nome=infra` (as TVs ficam na lista `TVS` do `server.js`)
- TV de teste num PC qualquer: `http://<ip-do-servidor>:8080/tv?nome=teste`

Pra transmitir a tela por `http://`, o Chrome de quem transmite precisa liberar a
origem uma vez em `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

## Configuração (no topo do `server.js`)

| O quê | Onde |
|---|---|
| TVs | `TVS` |
| Sites sugeridos na página de controle | `ATALHOS` |
| Sites com login via intermediário | `INTERMEDIARIOS` (site, porta e servidores de dados que a página chama) |

O estado de cada TV fica salvo em `estado.json` (criado sozinho; fora do git).

## O que aprendi no caminho

A transmissão travava mesmo com a rede perfeita. Em vez de chutar, a página de
controle ganhou um **registro da sessão**: o que a tela gera, o que o PC envia,
o que a TV recebe, perda de pacotes, congelamentos e irregularidade entre
quadros. Os números mostraram:

1. **Zero pacotes perdidos** — não era a rede.
2. Toda travada vinha **logo depois de a tela ficar parada**: o Chrome só manda
   quadro quando a tela muda, e o player da TV "dormia" nas pausas.
3. **Correção:** um relógio num Web Worker manda sempre 30 quadros/s, repetindo o
   último quando a tela não muda — com carimbo de tempo da agenda, pra TV ver um
   ritmo perfeitamente igual.

Outros achados, todos medidos:

- O codificador H.264 por hardware de alguns PCs ignora o limite de banda e o
  excesso vira fila de mais de 1 s dentro do próprio PC; VP8 respeita o limite.
- O VP8 não tem linha `a=fmtp` no SDP, então as instruções de banda inicial e
  mínima nunca chegavam e o vídeo começava em 320×180 — a correção cria a linha.
- Sites escondidos atrás da transmissão continuavam rodando e disputavam o
  processador fraco da TV; agora saem durante a transmissão e voltam no fim.
- A TV entra em proteção de tela se nenhum vídeo estiver tocando; um vídeo mudo
  de 2 pixels em loop resolve, e pausa durante a transmissão.

## Estrutura

```
server.js              servidor HTTP, sinalização WebRTC, intermediário, estado
public/controle.html   página de controle (painéis + transmissão + medidas)
public/tv.html         página que cada TV abre
public/acordada.mp4    vídeo de 1,5 KB contra a proteção de tela
iniciar-painel.sh      sobe o servidor em segundo plano (Linux)
painel-tv.desktop      atalho pro script acima
```
