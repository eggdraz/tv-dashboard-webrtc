# Sites com login

## O problema

Um painel é um `iframe`. Pro navegador, um site dentro de um `iframe` de outra página é "de terceiros" — e navegadores modernos (inclusive o da TV) **não mandam o cookie de login** pra sites de terceiros. Resultado: o site abre deslogado dentro do painel, mas logado em tela cheia. Na TV não existe a opção de liberar cookies de terceiros.

## A solução: o intermediário

Um proxy reverso, embutido no `server.js`, numa porta própria (ex.: 8081). A TV abre o site pelo intermediário:

```
TV  ──>  http://<servidor>:8081/dashboard  ──>  https://app.exemplo.com/dashboard
```

Pro navegador, `http://<servidor>:8080` (o painel) e `http://<servidor>:8081` (o intermediário) são o **mesmo site** — mesmo endereço, só muda a porta. Então o cookie é aceito dentro do `iframe`, e o site roda de verdade no navegador da TV: nítido, com cliques nativos.

O login é feito uma vez, na própria TV, e fica salvo no navegador dela.

### As traduções

Pra o site funcionar por outro endereço, o intermediário traduz o que passa por ele:

| O quê | Ida (TV → site) | Volta (site → TV) |
|---|---|---|
| **Cookies** | Restaura o nome original | Tira `Secure`, `Domain` e `Partitioned`; troca `SameSite=None` por `Lax`; troca os prefixos `__Secure-`/`__Host-` (que exigem HTTPS) por `pxS_`/`pxH_` |
| **Endereços** | — | O endereço do site vira o do intermediário em redirecionamentos e no conteúdo (HTML, JS, JSON) — nas três formas: normal, escapado em JSON (`https:\/\/...`) e codificado em URL (`https%3A%2F%2F...`) |
| **`Origin` / `Referer`** | Viram o endereço original — o site confere esses cabeçalhos contra ataques | — |
| **Corpo de formulários** | O endereço de retorno do login (ex.: `callbackUrl`) volta pro original — sites recusam retorno pra outro endereço | — |
| **Compressão** | — | Descompacta gzip/brotli/deflate pra traduzir, devolve sem compressão |
| **Cabeçalhos HTTPS** | — | Remove `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `Alt-Svc` |

A forma codificada em URL foi a mais traiçoeira: o login decidia pra onde voltar por um `?callbackUrl=https%3A%2F%2F...`, e sem traduzi-la a TV saía do intermediário logo depois de logar.

### Servidores de dados (APIs)

Muitos sites carregam a página de um endereço e os dados de outro (ex.: `api.exemplo.com`). Esse servidor de dados confere de onde vem o pedido (CORS) e só aceita o endereço original do site — então o painel abria **logado, mas vazio**.

O intermediário também encaminha esses servidores, em caminhos próprios:

```
http://<servidor>:8081/__api0/...  ──>  https://api.exemplo.com/...
```

O endereço da API dentro do código do site é trocado por esse caminho. Pra TV, fica tudo no mesmo endereço, e o navegador não bloqueia nada.

### Configurando

No `server.js`:

```js
const INTERMEDIARIOS = [
  { site: "https://app.exemplo.com", porta: 8081,
    apis: ["https://api.exemplo.com"] }
];
```

Na página de controle, escolha o modo **"Pelo intermediário"** no painel. No Chromebook, encaminhe a porta 8081 também.

**Como descobrir as APIs de um site:** abra o site no Chrome do PC, F12 → aba Rede, e veja pra quais endereços vão os pedidos de dados (`fetch`/`XHR`). Ou procure por `https://` nos arquivos `.js` do site.

### Segurança

- O intermediário **só encaminha os sites configurados** — não é um proxy aberto pra internet.
- Ele roda na rede local, em `http://`. Use só em rede confiável, e só pra sites em que você tem conta e permissão de acesso.
- O login fica salvo no navegador da TV. Quem tem acesso à TV vê o que o site mostra — escolha uma conta com o mínimo de permissão necessário pro painel.

## Alternativa: navegador no servidor

Antes do intermediário, a solução foi rodar um **Chromium invisível no servidor** (modo `remoto`), controlado pelo protocolo de depuração do Chrome (CDP, com um cliente WebSocket mínimo escrito à mão). A TV recebe a imagem como MJPEG e manda cliques, rolagem e teclas de volta.

| | Intermediário | Navegador no servidor |
|---|---|---|
| Onde o site roda | Na TV | No servidor |
| Nitidez | Nativa | Boa (usa a escala de tela da TV) |
| Peso no servidor | Mínimo | Um Chromium inteiro |
| Animações | Nativas | Limitadas a 5 imagens/s |
| Login fica salvo | No navegador da TV | No servidor (`perfil-navegador/`) |
| Funciona com qualquer site | Quase — depende das traduções | Sim |

O intermediário é o recomendado. O modo remoto continua disponível pra sites que o intermediário não consiga traduzir. Ele precisa do Chromium instalado no servidor (`sudo apt install chromium`) e, por segurança, recusa abrir `localhost` (que daria acesso à porta de depuração dele).
