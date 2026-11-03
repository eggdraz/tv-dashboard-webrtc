/* ===========================================================================
   Servidor do painel das TVs

   Sem dependencia nenhuma - roda com o Node que vem no apt do Debian.
   Nada de npm install, o que evita briga com proxy da empresa.

   Rodar:   node server.js
   TVs:     http://<ip-do-chromebook>:8080/tv?nome=simulacao
            http://<ip-do-chromebook>:8080/tv?nome=infra
            http://<ip-do-chromebook>:8080/tv?nome=teste   (pra testar num PC)
   Devs:    http://<ip-do-chromebook>:8080/

   Cada TV tem o proprio painel e a propria transmissao de tela. Duas pessoas
   podem transmitir ao mesmo tempo, uma em cada TV.

   Paineis "com login" nao usam o quadro (iframe) da TV: o navegador da TV
   nao manda o cookie de login para site dentro de quadro. Esses paineis
   rodam num Chromium invisivel aqui no Chromebook, que guarda o login, e o
   servidor manda a imagem dele para a TV. Precisa do Chromium instalado:
       sudo apt install -y chromium

   A comunicacao com as paginas e por SSE (Server-Sent Events): o navegador
   abre a conexao e o servidor empurra as mudancas. E nativo dos dois lados e
   reconecta sozinho se a rede cair - por isso nao usamos WebSocket aqui.
   =========================================================================== */

"use strict";

const http   = require("http");
const https  = require("https");
const zlib   = require("zlib");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORTA = 8080;

/* ---------------------------------------------------------------------------
   TVS
   O "id" vai no endereco da TV (?nome=...). Use so letras minusculas, sem
   espaco nem acento. O "nome" e o que aparece pras pessoas.
   --------------------------------------------------------------------------- */
const TVS = [
  { id: "simulacao", nome: "TV Simulação" },
  { id: "infra",     nome: "TV Infra" },
  /* TV de mentira pra testar sem mexer nas TVs da sala: abre em qualquer
     navegador, em http://<ip>:8080/tv?nome=teste */
  { id: "teste",     nome: "TV de Teste" }
];

/* ---------------------------------------------------------------------------
   ATALHOS
   Botoes de acesso rapido na pagina de controle. Os devs tambem podem colar
   qualquer URL na mao, entao isso aqui e so conveniencia.

   Sem o campo "tv", o atalho aparece pras duas TVs. Com "tv", so pra aquela.
     { nome: "Zabbix", url: "https://...", zoom: 1.2, tv: "infra" }
   --------------------------------------------------------------------------- */
const ATALHOS = [
  { nome: "Painel A", url: "https://example.com", zoom: 1.2 },
  { nome: "Painel B", url: "https://example.com", zoom: 1.2 }
];

/* ---------------------------------------------------------------------------
   INTERMEDIARIO PARA SITES COM LOGIN (o jeito recomendado)
   Dentro do quadro do painel, a TV nao aceita o cookie de login de um site
   "de fora". O intermediario faz o site passar pelo proprio Chromebook, numa
   porta propria: pra TV, 10.10.10.x:8081 e 10.10.10.x:8080 sao o mesmo site,
   entao o login funciona dentro do quadro - e o site roda no navegador da
   TV, nitido e com cliques nativos.

   Cada site precisa de uma porta, e cada porta precisa ser liberada no
   encaminhamento de portas do ChromeOS, igual a 8080. O login e feito na
   propria TV, uma vez (fica salvo no navegador dela).
   --------------------------------------------------------------------------- */
/* apis: servidores de dados que a pagina do site chama direto do navegador.
   Eles so aceitam pedidos vindos do endereco original do site (CORS), entao
   tambem passam pelo intermediario, em /__api0, /__api1... - pra TV fica tudo
   no mesmo endereco e o navegador nao bloqueia nada. Sem isso o site
   abre logado, mas o painel fica sem dados. */
const INTERMEDIARIOS = [
  /* exemplo:
  { site: "https://app.exemplo.com", porta: 8081,
    apis: ["https://api.exemplo.com"] }
  */
];

/* ---------------------------------------------------------------------------
   NAVEGADOR DOS PAINEIS COM LOGIN (alternativa: roda no Chromebook)
   CHROMIUM: o programa. No Chromebook o padrao "chromium" funciona depois do
   apt install. Pra testar em outro computador, aponte pro Chrome instalado.
   PERFIL_NAVEGADOR: pasta onde ficam os cookies de login. Apagar essa pasta
   desloga todos os sites.
   --------------------------------------------------------------------------- */
const CHROMIUM = process.env.CHROMIUM || "chromium";
const PERFIL = process.env.PERFIL_NAVEGADOR || path.join(__dirname, "perfil-navegador");
const PORTA_DEPURACAO = 9222;   /* so em 127.0.0.1: nunca fica visivel na rede */

/* Como uma TV comeca na primeira vez: os dois primeiros atalhos. Funciona
   mesmo se alguem deixar a lista de atalhos com um item so, ou vazia. */
function estadoPadrao() {
  const reserva = { nome: "Painel", url: "https://example.com", zoom: 1 };
  const painel = function (a) { return { titulo: a.nome, url: a.url, zoom: a.zoom, modo: "site" }; };
  return {
    layout: 1,
    paineis: [painel(ATALHOS[0] || reserva), painel(ATALHOS[1] || ATALHOS[0] || reserva)]
  };
}

function tvExiste(id) {
  return TVS.some(function (t) { return t.id === id; });
}

/* ---------------------------------------------------------------------------
   Estado: um painel por TV, salvo em disco pra sobreviver a reinicio.
   --------------------------------------------------------------------------- */
const ARQUIVO_ESTADO = path.join(__dirname, "estado.json");

let estados = {};
try {
  const lido = JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, "utf8"));
  /* a versao de uma TV so salvava { layout, paineis }: vira o estado da primeira */
  if (lido && lido.paineis) estados[TVS[0].id] = lido;
  else if (lido) estados = lido;
} catch (e) { /* primeira vez, ou arquivo corrompido: comeca do padrao */ }

TVS.forEach(function (t) {
  if (!estados[t.id] || !estados[t.id].paineis) estados[t.id] = estadoPadrao();
  /* estado salvo antes de existir painel com login: tudo e "site". Paineis
     pelo intermediario recalculam a porta, caso a lista tenha mudado. */
  estados[t.id].paineis.forEach(function (p) {
    if (p.modo !== "remoto" && p.modo !== "intermediario") p.modo = "site";
    if (p.modo === "intermediario") {
      const i = acharIntermediario(p.url);
      if (i) p.porta = i.porta; else { p.modo = "site"; delete p.porta; }
    }
  });
});

function salvarEstado() {
  fs.writeFile(ARQUIVO_ESTADO, JSON.stringify(estados, null, 2), function (err) {
    if (err) console.error("Nao consegui salvar o estado:", err.message);
  });
}

/* ---------------------------------------------------------------------------
   Clientes conectados por SSE
     TV:        { id, res, papel: "tv", tv: "infra" }
     Controle:  { id, res, papel: "controle" }  - recebe eventos de todas as
                TVs; a pagina filtra pela TV que o dev escolheu.
   --------------------------------------------------------------------------- */
let clientes = [];
let proximoId = 1;

/* Por TV: quem esta transmitindo (id do controle) e qual aba de TV recebe.
   Guardamos a aba exata porque, se a mesma TV estiver aberta em dois lugares
   (a TV e um PC de teste, por exemplo), as duas responderiam a oferta e a
   conexao do dev quebraria na segunda resposta. */
const transmissao = {};
TVS.forEach(function (t) { transmissao[t.id] = { dev: null, tela: null }; });

function enviar(res, evento) {
  try { res.write("data: " + JSON.stringify(evento) + "\n\n"); }
  catch (e) { /* conexao ja morreu, o cleanup pega */ }
}

function paraControles(evento) {
  clientes.forEach(function (c) { if (c.papel === "controle") enviar(c.res, evento); });
}

function paraTv(tv, evento) {
  clientes.forEach(function (c) { if (c.papel === "tv" && c.tv === tv) enviar(c.res, evento); });
}

function acharCliente(id) {
  return clientes.filter(function (c) { return c.id === id; })[0];
}

function telasDa(tv) {
  return clientes.filter(function (c) { return c.papel === "tv" && c.tv === tv; });
}

function presenca() {
  const p = {};
  TVS.forEach(function (t) { p[t.id] = telasDa(t.id).length; });
  return p;
}

function quemTransmite() {
  const q = {};
  TVS.forEach(function (t) { q[t.id] = transmissao[t.id].dev; });
  return q;
}

function avisarPresenca() {
  paraControles({ tipo: "presenca", tvs: presenca() });
}

/* Ultimas medidas de transmissao de cada TV: o que o PC envia e o que a TV
   recebe. Ficam em /diagnostico pra investigar atraso sem depender de alguem
   tirar print da pagina de controle. */
const diagnostico = {};

/* Alem da ultima medida, guarda um historico curto (~5 minutos com medidas a
   cada 2 s dos dois lados): mostra COMO o atraso evolui durante uma
   transmissao - por exemplo, se cresce quando a banda sobe. */
const HISTORICO_MAX = 300;
const historico = {};

function guardarMedida(tv, lado, dados) {
  if (!tvExiste(tv) || !dados || typeof dados !== "object") return;
  if (!diagnostico[tv]) diagnostico[tv] = {};
  diagnostico[tv][lado] = { dados: dados, em: Date.now() };
  if (!historico[tv]) historico[tv] = [];
  historico[tv].push(Object.assign({ em: new Date().toISOString().slice(11, 19), lado: lado }, dados));
  if (historico[tv].length > HISTORICO_MAX) historico[tv].shift();
}

/* Encerra a transmissao de uma TV e avisa todo mundo. Chamado quando o dev
   clica em parar, quando o navegador dele fecha, e quando a TV some. */
function pararTransmissao(tv, motivo) {
  const t = transmissao[tv];
  if (!t || t.dev === null) return;
  const tela = t.tela !== null ? acharCliente(t.tela) : null;
  t.dev = null;
  t.tela = null;
  if (tela) enviar(tela.res, { tipo: "parar-tela" });
  paraControles({ tipo: "compartilhando", tv: tv, quem: null, motivo: motivo || "" });
}

/* Rede de seguranca: durante uma transmissao, a TV manda medidas a cada 2 s.
   Se passar 20 s sem nenhuma, o video morreu no caminho - encerra, senao a
   TV e a pagina do dev ficam presas em "transmitindo" pra sempre. */
setInterval(function () {
  const agora = Date.now();
  TVS.forEach(function (tv) {
    const t = transmissao[tv.id];
    if (t.dev === null) return;
    const medida = diagnostico[tv.id] && diagnostico[tv.id].tvRecebe;
    const ultimoSinal = Math.max(t.inicio || 0, medida ? medida.em : 0);
    if (agora - ultimoSinal > 20000) {
      console.log("Transmissao na " + tv.nome + " encerrada: a TV parou de receber o video");
      pararTransmissao(tv.id, "a TV parou de receber o vídeo");
    }
  });
}, 5000);

/* SSE morre em silencio se ficar parado. Um ping periodico segura a conexao
   viva atraves de proxy e roteador. */
setInterval(function () {
  clientes.forEach(function (c) {
    try { c.res.write(": ping\n\n"); } catch (e) {}
  });
}, 25000);

/* ===========================================================================
   NAVEGADOR DOS PAINEIS COM LOGIN

   Um Chromium sem tela (headless) roda aqui, com um perfil proprio que guarda
   os cookies. Cada painel com login vira uma aba dele. A gente conversa com o
   Chromium pelo protocolo de depuracao (CDP): pede a imagem da pagina sempre
   que ela muda (screencast) e repassa cliques, rolagem e teclado.

   Pra TV e pra pagina de controle, a imagem vai como MJPEG: um <img> comum
   que se atualiza sozinho. Nenhuma das duas precisa saber nada de CDP.
   =========================================================================== */

/* ---------- WebSocket minimo (o Node 18 nao tem cliente nativo) ---------- */

function montarQuadroWs(op, dados) {
  /* quadro do cliente: sempre mascarado, como manda o protocolo */
  const mascara = crypto.randomBytes(4);
  let cab;
  if (dados.length < 126) {
    cab = Buffer.alloc(2);
    cab[1] = 0x80 | dados.length;
  } else if (dados.length < 65536) {
    cab = Buffer.alloc(4);
    cab[1] = 0x80 | 126;
    cab.writeUInt16BE(dados.length, 2);
  } else {
    cab = Buffer.alloc(10);
    cab[1] = 0x80 | 127;
    cab.writeBigUInt64BE(BigInt(dados.length), 2);
  }
  cab[0] = 0x80 | op;
  const corpo = Buffer.from(dados);
  for (let i = 0; i < corpo.length; i++) corpo[i] ^= mascara[i % 4];
  return Buffer.concat([cab, mascara, corpo]);
}

function abrirWebSocket(endereco) {
  return new Promise(function (resolve, reject) {
    const u = new URL(endereco);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64")
      }
    });
    req.on("upgrade", function (res, socket, inicio) { resolve(criarCanal(socket, inicio)); });
    req.on("response", function (res) { reject(new Error("o Chromium recusou a conexao (HTTP " + res.statusCode + ")")); });
    req.on("error", reject);
    req.end();
  });
}

function criarCanal(socket, inicio) {
  let buffer = inicio && inicio.length ? Buffer.from(inicio) : Buffer.alloc(0);
  let fragmentos = [];
  const canal = { aoReceber: null, aoFechar: null, fechado: false };

  socket.setNoDelay(true);

  canal.enviar = function (texto) {
    if (!canal.fechado) socket.write(montarQuadroWs(0x1, Buffer.from(texto, "utf8")));
  };
  canal.fechar = function () {
    if (canal.fechado) return;
    try { socket.write(montarQuadroWs(0x8, Buffer.alloc(0))); } catch (e) {}
    socket.end();
  };

  function ler() {
    while (buffer.length >= 2) {
      const fim = (buffer[0] & 0x80) !== 0;
      const op = buffer[0] & 0x0f;
      const mascarado = (buffer[1] & 0x80) !== 0;
      let tamanho = buffer[1] & 0x7f;
      let pos = 2;
      if (tamanho === 126) {
        if (buffer.length < 4) return;
        tamanho = buffer.readUInt16BE(2);
        pos = 4;
      } else if (tamanho === 127) {
        if (buffer.length < 10) return;
        tamanho = Number(buffer.readBigUInt64BE(2));
        pos = 10;
      }
      const extra = mascarado ? 4 : 0;
      if (buffer.length < pos + extra + tamanho) return;   /* quadro ainda incompleto */

      let dados = Buffer.from(buffer.subarray(pos + extra, pos + extra + tamanho));
      if (mascarado) {
        const m = buffer.subarray(pos, pos + 4);
        for (let i = 0; i < dados.length; i++) dados[i] ^= m[i % 4];
      }
      buffer = buffer.subarray(pos + extra + tamanho);

      if (op === 0x8) { canal.fechar(); return; }                        /* fechar */
      if (op === 0x9) { socket.write(montarQuadroWs(0xA, dados)); continue; } /* ping */
      if (op === 0xA) continue;                                           /* pong */

      fragmentos.push(dados);
      if (fim) {
        const msg = Buffer.concat(fragmentos).toString("utf8");
        fragmentos = [];
        if (canal.aoReceber) canal.aoReceber(msg);
      }
    }
  }

  socket.on("data", function (d) { buffer = Buffer.concat([buffer, d]); ler(); });
  socket.on("error", function () { socket.destroy(); });
  socket.on("close", function () {
    if (canal.fechado) return;
    canal.fechado = true;
    if (canal.aoFechar) canal.aoFechar();
  });
  if (buffer.length) setImmediate(ler);
  return canal;
}

/* ---------- Sessao CDP: comandos com resposta e eventos ---------- */

function sessaoCdp(canal) {
  let proximo = 1;
  const pendentes = new Map();
  const ouvintes = {};

  canal.aoReceber = function (texto) {
    let m;
    try { m = JSON.parse(texto); } catch (e) { return; }
    if (m.id && pendentes.has(m.id)) {
      const p = pendentes.get(m.id);
      pendentes.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method && ouvintes[m.method]) {
      ouvintes[m.method](m.params);
    }
  };

  const fecharAntes = canal.aoFechar;
  canal.aoFechar = function () {
    pendentes.forEach(function (p) { p.reject(new Error("conexao com o Chromium caiu")); });
    pendentes.clear();
    if (fecharAntes) fecharAntes();
  };

  return {
    chamar: function (metodo, params) {
      return new Promise(function (resolve, reject) {
        if (canal.fechado) { reject(new Error("conexao com o Chromium fechada")); return; }
        const id = proximo++;
        pendentes.set(id, { resolve: resolve, reject: reject });
        canal.enviar(JSON.stringify({ id: id, method: metodo, params: params || {} }));
      });
    },
    ao: function (evento, fn) { ouvintes[evento] = fn; },
    fechar: function () { canal.fechar(); }
  };
}

/* ---------- Processo do Chromium ---------- */

function pedirDepuracao(metodo, caminho) {
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: "127.0.0.1", port: PORTA_DEPURACAO, path: caminho, method: metodo
    }, function (res) {
      let corpo = "";
      res.on("data", function (d) { corpo += d; });
      res.on("end", function () {
        if (res.statusCode >= 400) { reject(new Error("HTTP " + res.statusCode + ": " + corpo)); return; }
        try { resolve(JSON.parse(corpo)); } catch (e) { resolve(corpo); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, function () { req.destroy(new Error("o Chromium nao respondeu")); });
    req.end();
  });
}

function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

let processoNavegador = null;
let navegadorPronto = null;     /* Promise compartilhada enquanto o Chromium sobe */
let erroNavegador = "";
let desligandoDeProposito = false;

function depuracaoResponde() {
  return pedirDepuracao("GET", "/json/version").then(function () { return true; }, function () { return false; });
}

function iniciarNavegador() {
  if (navegadorPronto) return navegadorPronto;

  navegadorPronto = (async function () {
    /* Sobrou um Chromium de uma execucao anterior (servidor morto sem chance
       de fechar ele)? Reaproveita, fechando as abas velhas. */
    if (await depuracaoResponde()) {
      const velhas = await pedirDepuracao("GET", "/json/list").catch(function () { return []; });
      for (const a of velhas) {
        if (a.type === "page") await pedirDepuracao("GET", "/json/close/" + a.id).catch(function () {});
      }
      erroNavegador = "";
      return;
    }

    fs.mkdirSync(PERFIL, { recursive: true });
    const argumentos = [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + PORTA_DEPURACAO,
      "--user-data-dir=" + PERFIL,
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--hide-scrollbars",
      "--disable-gpu",
      "about:blank"
    ];

    let saida = "";
    const proc = spawn(CHROMIUM, argumentos, { stdio: ["ignore", "ignore", "pipe"] });
    processoNavegador = proc;
    proc.stderr.on("data", function (d) { saida = (saida + d).slice(-2000); });

    /* Se o Chromium nao existir ou cair ao abrir, isso interrompe a espera.
       O catch vazio evita que a rejeicao derrube o servidor se ninguem estiver
       esperando nesse momento. */
    const falhou = new Promise(function (_, rejeitar) {
      proc.on("error", function (e) {
        if (processoNavegador === proc) { processoNavegador = null; navegadorPronto = null; }
        rejeitar(new Error("nao consegui abrir o Chromium (\"" + CHROMIUM + "\"): " + e.message +
          ". No Chromebook, instale com: sudo apt install -y chromium"));
      });
      proc.on("exit", function (codigo) {
        const ultimas = saida.trim().split("\n").slice(-2).join(" ");
        rejeitar(new Error("o Chromium fechou ao abrir (codigo " + codigo + ") " + ultimas));
      });
    });
    falhou.catch(function () {});

    proc.on("exit", function () {
      if (processoNavegador === proc) { processoNavegador = null; navegadorPronto = null; }
      if (!desligandoDeProposito) console.error("Navegador: o Chromium fechou.");
      desligandoDeProposito = false;
    });

    const limite = Date.now() + 20000;
    while (Date.now() < limite) {
      await Promise.race([esperar(300), falhou]);
      if (await depuracaoResponde()) {
        erroNavegador = "";
        console.log("Navegador: Chromium pronto (perfil em " + PERFIL + ")");
        return;
      }
    }
    throw new Error("o Chromium nao respondeu em 20 segundos");
  })().catch(function (e) {
    erroNavegador = e.message;
    navegadorPronto = null;
    throw e;
  });

  return navegadorPronto;
}

function desligarNavegador() {
  navegadorPronto = null;
  if (processoNavegador) {
    desligandoDeProposito = true;
    try { processoNavegador.kill(); } catch (e) {}
    processoNavegador = null;
  }
}

/* O Chromium e filho deste processo: se o servidor parar (pkill, Ctrl+C),
   fechamos ele junto, senao ele segura a pasta do perfil e a porta 9222. */
function encerrar() {
  desligarNavegador();
  process.exit(0);
}
process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);

/* ---------- Abas: uma por painel com login ---------- */

/* chave "tv:painel", ex. "infra:1" */
const abas = new Map();

function novaAba(chave, url) {
  return {
    chave: chave,
    url: url,
    alvo: null,          /* id da aba no Chromium */
    cdp: null,
    quadro: null,        /* ultima imagem (JPEG) */
    assinantes: new Set(),
    largura: 1280, altura: 720, zoom: 1,   /* tamanho do painel na TV */
    dpr: 1,              /* pixels reais da tela por pixel da pagina, na TV */
    vw: 1280, vh: 720,   /* tamanho da janela do site, em px dele */
    conectando: false,
    erro: "",
    espera: 2000,
    timer: null
  };
}

/* Quais paineis com login precisam estar abertos agora. O painel da direita
   so conta quando a tela esta dividida. */
function paineisComLogin() {
  const desejados = new Map();
  TVS.forEach(function (t) {
    const e = estados[t.id];
    e.paineis.forEach(function (p, i) {
      if (p.modo === "remoto" && (i === 0 || e.layout === 2)) desejados.set(t.id + ":" + i, p.url);
    });
  });
  return desejados;
}

function sincronizarAbas() {
  const desejados = paineisComLogin();

  abas.forEach(function (aba, chave) { if (!desejados.has(chave)) fecharAba(chave); });

  desejados.forEach(function (url, chave) {
    let aba = abas.get(chave);
    if (!aba) {
      aba = novaAba(chave, url);
      abas.set(chave, aba);
      conectarAba(aba);
    } else if (aba.url !== url) {
      aba.url = url;
      if (aba.cdp) aba.cdp.chamar("Page.navigate", { url: url }).catch(function () {});
    }
  });

  /* nenhum painel com login: libera a memoria do Chromium. O login continua
     salvo no perfil e volta quando um painel precisar de novo. */
  if (!desejados.size && processoNavegador) {
    console.log("Navegador: nenhum painel com login, fechando o Chromium");
    desligarNavegador();
  }
}

function agendarReconexao(aba) {
  if (aba.timer || abas.get(aba.chave) !== aba) return;
  aba.timer = setTimeout(function () {
    aba.timer = null;
    conectarAba(aba);
  }, aba.espera);
  aba.espera = Math.min(aba.espera * 2, 30000);
}

async function conectarAba(aba) {
  if (aba.conectando || aba.cdp || abas.get(aba.chave) !== aba) return;
  aba.conectando = true;
  try {
    await iniciarNavegador();

    /* abre em branco e navega depois: o endereco do site nao precisa passar
       pela URL do pedido, onde caracteres especiais dariam problema */
    const alvo = await pedirDepuracao("PUT", "/json/new?about:blank");
    const canal = await abrirWebSocket(alvo.webSocketDebuggerUrl);

    if (abas.get(aba.chave) !== aba) {   /* o painel deixou de ter login enquanto abria */
      canal.fechar();
      pedirDepuracao("GET", "/json/close/" + alvo.id).catch(function () {});
      return;
    }

    canal.aoFechar = function () {
      aba.cdp = null;
      if (abas.get(aba.chave) === aba) agendarReconexao(aba);
    };
    const cdp = sessaoCdp(canal);
    aba.alvo = alvo.id;
    aba.cdp = cdp;

    cdp.ao("Page.screencastFrame", function (params) {
      cdp.chamar("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(function () {});
      aba.quadro = Buffer.from(params.data, "base64");
      agendarDistribuicao(aba);
    });

    await cdp.chamar("Page.enable");
    await aplicarTamanho(aba);
    await cdp.chamar("Page.navigate", { url: aba.url });

    aba.erro = "";
    aba.espera = 2000;
    console.log("Navegador: painel " + aba.chave + " aberto em " + aba.url);
  } catch (e) {
    aba.cdp = null;
    aba.erro = e.message;
    console.error("Navegador: nao abriu o painel " + aba.chave + ": " + e.message);
    agendarReconexao(aba);
  } finally {
    aba.conectando = false;
  }
}

function fecharAba(chave) {
  const aba = abas.get(chave);
  if (!aba) return;
  abas.delete(chave);
  clearTimeout(aba.timer);
  clearTimeout(aba.timerEnvio);
  if (aba.cdp) aba.cdp.fechar();
  if (aba.alvo) pedirDepuracao("GET", "/json/close/" + aba.alvo).catch(function () {});
  /* encerra as imagens abertas: TV e controle reconectam no que vier depois */
  aba.assinantes.forEach(function (s) { try { s.res.end(); } catch (e) {} });
  aba.assinantes.clear();
}

/* A janela do site tem o tamanho do painel dividido pelo zoom. A densidade de
   pixel e zoom x escala da TV: o navegador da LG trabalha em escala (ex. 1536
   px de pagina numa tela de 1920, escala 1,25), entao gerar a imagem no
   tamanho "de pagina" faria a TV ampliar e embacar. Assim a imagem sai com os
   pixels REAIS da tela, nitida, e com a letra no tamanho escolhido. */
async function aplicarTamanho(aba) {
  if (!aba.cdp) return;
  const z = Math.min(3, Math.max(0.5, aba.zoom || 1));
  const dpr = Math.min(3, Math.max(1, aba.dpr || 1));
  const w = Math.max(320, Math.round(aba.largura / z));
  const h = Math.max(200, Math.round(aba.altura / z));
  aba.vw = w;
  aba.vh = h;
  await aba.cdp.chamar("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, deviceScaleFactor: z * dpr, mobile: false
  });
  await aba.cdp.chamar("Page.stopScreencast").catch(function () {});
  /* qualidade alta: painel muda pouco, e o Chromebook so manda imagem nova
     quando algo muda na tela - o custo extra de rede fica pequeno */
  await aba.cdp.chamar("Page.startScreencast", {
    format: "jpeg", quality: 92,
    maxWidth: Math.round(w * z * dpr), maxHeight: Math.round(h * z * dpr),
    everyNthFrame: 1
  });
}

/* ---------- Imagem em MJPEG ---------- */

/* Site com animacao (relogio, grafico ao vivo) faz o Chromium gerar dezenas
   de imagens por segundo. Mandar todas lotava o Wi-Fi e o processador da TV
   e do PC - e atrasava a transmissao de tela. Pra painel, 5 por segundo
   bastam: guardamos sempre a mais recente e mandamos no maximo a cada 200 ms,
   entao a ultima versao da tela sempre chega. */
const INTERVALO_IMAGEM = 200;

function agendarDistribuicao(aba) {
  if (aba.timerEnvio) return;
  const espera = Math.max(0, (aba.ultimoEnvio || 0) + INTERVALO_IMAGEM - Date.now());
  aba.timerEnvio = setTimeout(function () {
    aba.timerEnvio = null;
    aba.ultimoEnvio = Date.now();
    distribuir(aba);
  }, espera);
}

function distribuir(aba) {
  if (!aba.quadro) return;
  aba.assinantes.forEach(function (s) {
    /* TV com transmissao de tela na frente: nao manda nada. A TV pede de
       novo quando a transmissao acaba e recebe a imagem mais recente. */
    if (s.tv && transmissao[s.tv] && transmissao[s.tv].dev !== null) return;
    mandarQuadro(s, aba.quadro);
  });
}

/* Cada quadro ja termina com o separador do proximo. Assim o navegador sabe
   na hora que a imagem acabou e mostra - sem isso, pagina parada (que nao
   gera quadro novo) ficaria em branco esperando o proximo. */
function mandarQuadro(sub, jpeg) {
  if (sub.ocupado) { sub.pendente = jpeg; return; }   /* rede lenta: pula quadros */
  const cabecalho = Buffer.from("Content-Type: image/jpeg\r\nContent-Length: " + jpeg.length + "\r\n\r\n");
  const ok = sub.res.write(Buffer.concat([cabecalho, jpeg, Buffer.from("\r\n--quadro\r\n")]));
  if (!ok) {
    sub.ocupado = true;
    sub.res.once("drain", function () {
      sub.ocupado = false;
      if (sub.pendente) {
        const p = sub.pendente;
        sub.pendente = null;
        mandarQuadro(sub, p);
      }
    });
  }
}

/* ---------- Entrada: cliques, rolagem e teclado ---------- */

const TECLAS = {
  Enter:      { vk: 13, texto: "\r" },
  Backspace:  { vk: 8 },
  Tab:        { vk: 9 },
  Escape:     { vk: 27 },
  Delete:     { vk: 46 },
  ArrowLeft:  { vk: 37 },
  ArrowUp:    { vk: 38 },
  ArrowRight: { vk: 39 },
  ArrowDown:  { vk: 40 },
  Home:       { vk: 36 },
  End:        { vk: 35 },
  PageUp:     { vk: 33 },
  PageDown:   { vk: 34 }
};

function limitar(v, min, max) {
  v = Number(v);
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

async function aplicarEntrada(aba, e) {
  const cdp = aba.cdp;
  const x = limitar(e.x, 0, 1) * aba.vw;
  const y = limitar(e.y, 0, 1) * aba.vh;

  switch (e.tipo) {
    case "clique":
      await cdp.chamar("Input.dispatchMouseEvent", { type: "mouseMoved", x: x, y: y });
      await cdp.chamar("Input.dispatchMouseEvent", { type: "mousePressed", x: x, y: y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.chamar("Input.dispatchMouseEvent", { type: "mouseReleased", x: x, y: y, button: "left", buttons: 0, clickCount: 1 });
      return;

    case "rolar":
      await cdp.chamar("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: x, y: y, deltaX: 0, deltaY: limitar(e.deltaY, -3000, 3000)
      });
      return;

    case "texto":
      if (typeof e.texto === "string" && e.texto) {
        await cdp.chamar("Input.insertText", { text: e.texto.slice(0, 2000) });
      }
      return;

    case "tecla": {
      const modificadores = (e.alt ? 1 : 0) | (e.ctrl ? 2 : 0) | (e.meta ? 4 : 0) | (e.shift ? 8 : 0);
      let def = TECLAS[e.tecla];
      let codigo = e.tecla;
      /* atalho com letra, ex. Ctrl+A pra selecionar tudo */
      if (!def && typeof e.tecla === "string" && e.tecla.length === 1 && (e.ctrl || e.meta)) {
        const letra = e.tecla.toUpperCase();
        def = { vk: letra.charCodeAt(0) };
        codigo = /[A-Z]/.test(letra) ? "Key" + letra : "";
      }
      if (!def) return;
      const base = { key: e.tecla, code: codigo, windowsVirtualKeyCode: def.vk, modifiers: modificadores };
      const descer = Object.assign({}, base, def.texto && !modificadores
        ? { type: "keyDown", text: def.texto }
        : { type: "rawKeyDown" });
      await cdp.chamar("Input.dispatchKeyEvent", descer);
      await cdp.chamar("Input.dispatchKeyEvent", Object.assign({}, base, { type: "keyUp" }));
      return;
    }

    case "navegar": {
      let url = typeof e.url === "string" ? e.url.trim() : "";
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
      if (!urlSegura(url)) throw new Error("Endereço inválido.");
      if (urlDoProprioChromebook(url)) throw new Error(MSG_LOCAL);
      await cdp.chamar("Page.navigate", { url: url });
      return;
    }

    case "voltar":
      await cdp.chamar("Runtime.evaluate", { expression: "history.back()" });
      return;

    case "recarregar":
      await cdp.chamar("Page.reload", {});
      return;
  }
  throw new Error("Ação desconhecida.");
}

/* ===========================================================================
   INTERMEDIARIO (proxy) DOS SITES COM LOGIN

   Cada pedido que chega na porta do intermediario e repassado ao site de
   verdade, e a resposta volta pra TV. Tres "traducoes" fazem o login funcionar:

   1. Cookies. O site marca o login como exclusivo de HTTPS (Secure, e nomes
      com __Secure- / __Host-). O painel e HTTP, entao a TV recusaria. Na ida
      pra TV tiramos o Secure e trocamos o prefixo do nome; na volta pro site
      o nome original e restaurado - o site nunca percebe a diferenca.
   2. Redirecionamentos e links absolutos pro endereco do site viram o
      endereco do intermediario, pra TV nao escapar dele no meio do login.
   3. Origin/Referer da TV viram o endereco do site, que confere esses
      cabecalhos contra ataques.

   So repassa pro site configurado - nao e um proxy aberto pra internet.
   =========================================================================== */

function acharIntermediario(url) {
  try {
    const origem = new URL(url).origin;
    return INTERMEDIARIOS.filter(function (i) { return i.site === origem; })[0] || null;
  } catch (e) { return null; }
}

/* nomes com prefixo de seguranca nao valem em HTTP: troca na ida, desfaz na volta */
const PREFIXOS = [["__Secure-", "pxS_"], ["__Host-", "pxH_"]];

function cookieParaTv(linha) {
  const partes = linha.split(";").map(function (s) { return s.trim(); });
  let par = partes.shift();
  PREFIXOS.forEach(function (p) { if (par.indexOf(p[0]) === 0) par = p[1] + par.slice(p[0].length); });
  const atributos = partes.filter(function (a) {
    return !/^(secure|partitioned|domain=)/i.test(a);
  }).map(function (a) {
    /* SameSite=None exige Secure; Lax basta, porque a TV e o intermediario
       sao o mesmo site */
    return /^samesite=none$/i.test(a) ? "SameSite=Lax" : a;
  });
  return [par].concat(atributos).join("; ");
}

function cookiesParaSite(cabecalho) {
  return cabecalho.split(";").map(function (s) {
    s = s.trim();
    PREFIXOS.forEach(function (p) { if (s.indexOf(p[1]) === 0) s = p[0] + s.slice(p[1].length); });
    return s;
  }).join("; ");
}

function trocarEndereco(texto, de, para) {
  /* tres formas: normal, escapada dentro de JSON e codificada dentro de link
     (ex.: ?callbackUrl=https%3A%2F%2F... - por onde o login decide pra onde
     voltar; se escapasse, a TV sairia do intermediario depois de logar) */
  return texto.split(de).join(para)
              .split(de.replace(/\//g, "\\/")).join(para.replace(/\//g, "\\/"))
              .split(encodeURIComponent(de)).join(encodeURIComponent(para));
}

const TIPOS_FORMULARIO = /application\/x-www-form-urlencoded|application\/json/i;

const TIPOS_REESCREVER = /text\/html|application\/json|text\/x-component|javascript/i;

function iniciarIntermediario(cfg) {
  const apis = cfg.apis || [];

  http.createServer(function (req, res) {
    /* o endereco que a TV usou pra chegar aqui (o IP do Chromebook muda) */
    const proprio = "http://" + (req.headers.host || ("localhost:" + cfg.porta));

    /* enderecos do site e das APIs <-> enderecos do intermediario. As APIs
       vem antes: o endereco delas no intermediario comeca com o proprio. */
    const paraTv = function (texto) {
      apis.forEach(function (api, i) { texto = trocarEndereco(texto, api, proprio + "/__api" + i); });
      return trocarEndereco(texto, cfg.site, proprio);
    };
    const paraSite = function (texto) {
      apis.forEach(function (api, i) { texto = trocarEndereco(texto, proprio + "/__api" + i, api); });
      return trocarEndereco(texto, proprio, cfg.site);
    };

    /* /__api0/... vai pra primeira API, o resto vai pro site */
    let destino = cfg.site;
    let caminho = req.url;
    const m = /^\/__api(\d+)(\/.*)?$/.exec(req.url);
    if (m && apis[Number(m[1])]) {
      destino = apis[Number(m[1])];
      caminho = m[2] || "/";
    }
    const alvo = new URL(destino);

    const cab = Object.assign({}, req.headers);
    cab.host = alvo.host;
    /* Origin/Referer sempre o do site: e o unico que as APIs aceitam */
    if (cab.origin) cab.origin = cfg.site;
    if (cab.referer) cab.referer = paraSite(cab.referer);
    if (cab.cookie) cab.cookie = cookiesParaSite(cab.cookie);

    const pedido = https.request({
      host: alvo.hostname,
      port: alvo.port || 443,
      method: req.method,
      path: paraSite(caminho),
      headers: cab
    }, function (r) {
      const h = Object.assign({}, r.headers);
      if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].map(cookieParaTv);
      if (h.location) h.location = paraTv(h.location);
      /* regras que so fazem sentido no endereco HTTPS original */
      ["strict-transport-security", "content-security-policy", "x-frame-options", "alt-svc"]
        .forEach(function (k) { delete h[k]; });

      const semCorpo = req.method === "HEAD" || r.statusCode === 204 || r.statusCode === 304;
      if (semCorpo || !TIPOS_REESCREVER.test(h["content-type"] || "")) {
        res.writeHead(r.statusCode, h);
        r.pipe(res);
        return;
      }

      /* texto: descompacta, troca os enderecos e devolve sem compressao */
      const codificacao = (h["content-encoding"] || "").toLowerCase();
      let fluxo = r;
      if (codificacao === "gzip") fluxo = r.pipe(zlib.createGunzip());
      else if (codificacao === "br") fluxo = r.pipe(zlib.createBrotliDecompress());
      else if (codificacao === "deflate") fluxo = r.pipe(zlib.createInflate());

      const pedacos = [];
      fluxo.on("data", function (d) { pedacos.push(d); });
      fluxo.on("end", function () {
        const corpo = Buffer.from(paraTv(Buffer.concat(pedacos).toString("utf8")));
        delete h["content-encoding"];
        delete h["transfer-encoding"];
        h["content-length"] = corpo.length;
        res.writeHead(r.statusCode, h);
        res.end(corpo);
      });
      fluxo.on("error", function () {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });

    pedido.on("error", function (e) {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("O intermediário não conseguiu falar com " + destino + ": " + e.message);
    });

    /* Formularios (como o de login) levam o endereco de volta no corpo. O
       site recusa endereco de retorno que nao seja o dele, entao traduzimos
       pro endereco original antes de repassar. O resto vai direto. */
    if (!TIPOS_FORMULARIO.test(req.headers["content-type"] || "")) {
      req.pipe(pedido);
      return;
    }
    const corpoPedido = [];
    let tamanho = 0;
    req.on("data", function (d) {
      tamanho += d.length;
      if (tamanho > 5e6) { req.destroy(); pedido.destroy(); return; }   /* formulario absurdo */
      corpoPedido.push(d);
    });
    req.on("end", function () {
      const corpo = Buffer.from(paraSite(Buffer.concat(corpoPedido).toString("utf8")));
      pedido.removeHeader("transfer-encoding");
      pedido.setHeader("content-length", corpo.length);
      pedido.end(corpo);
    });
  }).on("error", function (e) {
    console.error("Intermediario: nao consegui abrir a porta " + cfg.porta + " (" + e.message + ")");
  }).listen(cfg.porta, "0.0.0.0", function () {
    console.log("  Intermediario: " + cfg.site + "  ->  porta " + cfg.porta);
  });
}

/* ---------------------------------------------------------------------------
   Arquivos estaticos
   --------------------------------------------------------------------------- */
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".mp4":  "video/mp4"
};

function servirArquivo(res, arquivo) {
  const completo = path.join(__dirname, "public", arquivo);

  /* nao deixa sair da pasta public */
  if (!completo.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end("Proibido");
    return;
  }

  fs.readFile(completo, function (err, dados) {
    if (err) { res.writeHead(404).end("Nao encontrado"); return; }
    res.writeHead(200, {
      "Content-Type": TIPOS[path.extname(completo)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(dados);
  });
}

function json(res, codigo, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(texto)
  });
  res.end(texto);
}

function lerCorpo(req, cb) {
  let bruto = "";
  req.on("data", function (p) {
    bruto += p;
    if (bruto.length > 1e6) req.destroy();   /* corta payload absurdo */
  });
  req.on("end", function () {
    try { cb(null, JSON.parse(bruto || "{}")); }
    catch (e) { cb(e); }
  });
}

/* Aceita so http/https, pra nao deixar injetarem javascript: no iframe */
function urlSegura(u) {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch (e) { return false; }
}

/* O navegador dos paineis com login roda DENTRO do Chromebook. Se aceitasse
   abrir localhost/127.0.0.1, qualquer um na rede poderia usar ele pra ver
   servicos internos do Chromebook - inclusive a porta de depuracao do
   proprio Chromium. Num painel normal isso nao vale: la quem abre e a TV. */
const MSG_LOCAL = "Site com login não pode apontar para o próprio Chromebook (localhost / 127.0.0.1).";

function urlDoProprioChromebook(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" ||
           h === "0.0.0.0" || /^127\./.test(h);
  } catch (e) { return false; }
}

/* Normaliza o que veio da pagina de controle antes de virar estado */
function limparEstado(bruto, atual) {
  const limpo = {
    layout: bruto.layout === 2 ? 2 : 1,
    paineis: []
  };

  for (let i = 0; i < 2; i++) {
    const p = (bruto.paineis && bruto.paineis[i]) || {};
    const anterior = atual.paineis[i] || estadoPadrao().paineis[i];

    let url = typeof p.url === "string" ? p.url.trim() : "";
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    if (!urlSegura(url)) url = anterior.url;

    let zoom = parseFloat(p.zoom);
    if (!(zoom > 0.3 && zoom < 4)) zoom = anterior.zoom || 1;

    const painel = {
      titulo: String(p.titulo || anterior.titulo || "").slice(0, 60),
      url: url,
      zoom: zoom,
      modo: ["remoto", "intermediario"].indexOf(p.modo) >= 0 ? p.modo : "site"
    };
    /* a TV precisa saber em que porta o intermediario desse site atende */
    if (painel.modo === "intermediario") {
      const i = acharIntermediario(url);
      if (i) painel.porta = i.porta;
    }
    limpo.paineis.push(painel);
  }
  return limpo;
}

/* ---------------------------------------------------------------------------
   Servidor
   --------------------------------------------------------------------------- */
const servidor = http.createServer(function (req, res) {
  const u = new URL(req.url, "http://localhost");
  const rota = u.pathname;

  /* --- páginas --- */
  if (rota === "/" && req.method === "GET")   return servirArquivo(res, "controle.html");
  if (rota === "/tv" && req.method === "GET") return servirArquivo(res, "tv.html");
  /* video mudo de 3 s que a TV toca em loop pra nao entrar em protecao de tela */
  if (rota === "/acordada.mp4" && req.method === "GET") return servirArquivo(res, "acordada.mp4");

  /* --- configuracao inicial que as paginas precisam --- */
  if (rota === "/config" && req.method === "GET") {
    return json(res, 200, {
      tvs: TVS,
      atalhos: ATALHOS,
      intermediarios: INTERMEDIARIOS,
      estados: estados,
      presenca: presenca(),
      compartilhando: quemTransmite()
    });
  }

  /* --- canal de eventos (SSE) --- */
  if (rota === "/eventos" && req.method === "GET") {
    const papel = u.searchParams.get("papel") === "tv" ? "tv" : "controle";
    const tv = u.searchParams.get("nome");

    if (papel === "tv" && !tvExiste(tv)) {
      res.writeHead(400).end("TV desconhecida");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const cliente = {
      id: proximoId++, res: res, papel: papel, tv: papel === "tv" ? tv : null,
      /* IP de quem conectou: serve pra avisar quando PC e TV estao em redes
         diferentes (o video vai direto de um pro outro e costuma falhar) */
      ip: String(req.socket.remoteAddress || "").replace(/^::ffff:/, "")
    };
    clientes.push(cliente);

    /* o cliente precisa saber o proprio id pra rotear a sinalizacao do WebRTC */
    enviar(res, { tipo: "bemvindo", id: cliente.id });

    if (papel === "tv") {
      enviar(res, { tipo: "estado", tv: tv, estado: estados[tv] });
      avisarPresenca();
    } else {
      enviar(res, { tipo: "presenca", tvs: presenca() });
      TVS.forEach(function (t) {
        enviar(res, { tipo: "compartilhando", tv: t.id, quem: transmissao[t.id].dev });
      });
    }

    req.on("close", function () {
      clientes = clientes.filter(function (c) { return c !== cliente; });

      TVS.forEach(function (t) {
        /* dev fechou a aba no meio da transmissao: a TV ficaria travada no
           ultimo quadro, entao derrubamos explicitamente */
        if (transmissao[t.id].dev === cliente.id) pararTransmissao(t.id, "o dev saiu");
        /* a TV que estava recebendo sumiu: avisa o dev pra ele nao ficar
           transmitindo pro nada */
        if (transmissao[t.id].tela === cliente.id) pararTransmissao(t.id, "a TV desconectou");
      });

      if (papel === "tv") avisarPresenca();
    });
    return;
  }

  /* --- dev mudou o que uma TV mostra --- */
  if (rota === "/estado" && req.method === "POST") {
    return lerCorpo(req, function (err, corpo) {
      if (err) return json(res, 400, { erro: "JSON invalido" });
      if (!tvExiste(corpo.tv)) return json(res, 400, { erro: "TV desconhecida" });

      const novo = limparEstado(corpo, estados[corpo.tv]);
      if (novo.paineis.some(function (p) { return p.modo === "remoto" && urlDoProprioChromebook(p.url); })) {
        return json(res, 400, { erro: MSG_LOCAL });
      }
      const semIntermediario = novo.paineis.filter(function (p) { return p.modo === "intermediario" && !p.porta; })[0];
      if (semIntermediario) {
        return json(res, 400, { erro: "\"" + semIntermediario.url + "\" não está na lista do intermediário. " +
          "Sites disponíveis: " + INTERMEDIARIOS.map(function (i) { return i.site; }).join(", ") + "." });
      }
      estados[corpo.tv] = novo;
      salvarEstado();

      /* abre ou fecha as abas do navegador ANTES de avisar a TV, pra imagem
         ja existir quando ela pedir */
      sincronizarAbas();

      const evento = { tipo: "estado", tv: corpo.tv, estado: estados[corpo.tv] };
      paraTv(corpo.tv, evento);
      paraControles(evento);
      json(res, 200, { ok: true, telas: telasDa(corpo.tv).length });
    });
  }

  /* --- paineis com login: imagem, tamanho, entrada e situacao ------------- */
  if (rota.indexOf("/remoto/") === 0) {
    const chave = function (o) { return o.tv + ":" + (Number(o.painel) === 1 ? 1 : 0); };

    if (rota === "/remoto/stream" && req.method === "GET") {
      const aba = abas.get(chave({ tv: u.searchParams.get("tv"), painel: u.searchParams.get("painel") }));
      if (!aba) { res.writeHead(404).end("Este painel nao tem site com login"); return; }

      res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=quadro",
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "Connection": "keep-alive"
      });
      res.write("--quadro\r\n");
      /* origem=tv: e a propria TV pedindo (nao a pagina de controle). Serve pra
         parar de mandar imagem enquanto essa TV mostra uma transmissao. */
      const tvDoPedido = u.searchParams.get("origem") === "tv" ? u.searchParams.get("tv") : null;
      const sub = { res: res, ocupado: false, pendente: null, tv: tvDoPedido };
      aba.assinantes.add(sub);
      /* pagina parada nao gera quadro novo: manda o ultimo na hora - menos pra
         uma TV que esta mostrando transmissao, que nao precisa de nada agora */
      const tvTransmitindo = tvDoPedido && transmissao[tvDoPedido] && transmissao[tvDoPedido].dev !== null;
      if (aba.quadro && !tvTransmitindo) mandarQuadro(sub, aba.quadro);
      req.on("close", function () { aba.assinantes.delete(sub); });
      return;
    }

    if (rota === "/remoto/situacao" && req.method === "GET") {
      const lista = {};
      abas.forEach(function (aba, k) {
        lista[k] = { pronto: !!aba.cdp, erro: aba.cdp ? "" : (aba.erro || erroNavegador) };
      });
      return json(res, 200, { abas: lista });
    }

    if (rota === "/remoto/tamanho" && req.method === "POST") {
      return lerCorpo(req, function (err, c) {
        if (err) return json(res, 400, { erro: "JSON invalido" });
        const aba = abas.get(chave(c));
        if (!aba) return json(res, 404, { erro: "Este painel nao tem site com login" });
        aba.largura = limitar(c.largura, 200, 4000);
        aba.altura = limitar(c.altura, 150, 4000);
        aba.zoom = limitar(c.zoom, 0.5, 3);
        aba.dpr = limitar(c.dpr || 1, 1, 3);
        aplicarTamanho(aba).catch(function () {});
        json(res, 200, { ok: true });
      });
    }

    if (rota === "/remoto/entrada" && req.method === "POST") {
      return lerCorpo(req, function (err, c) {
        if (err) return json(res, 400, { erro: "JSON invalido" });
        const aba = abas.get(chave(c));
        if (!aba) return json(res, 404, { erro: "Este painel nao tem site com login" });
        if (!aba.cdp) return json(res, 409, { erro: "O navegador do Chromebook ainda está abrindo." });
        aplicarEntrada(aba, c).then(
          function () { json(res, 200, { ok: true }); },
          function (e) { json(res, 400, { erro: e.message }); }
        );
      });
    }
  }

  /* --- sinalizacao do compartilhamento de tela (WebRTC) ---------------------
     O servidor so entrega envelope: ele nao entende nem toca no video. O video
     vai direto do PC do dev pra TV, ponto a ponto na rede local - por isso a
     latencia fica baixa e o Chromebook nao vira gargalo, mesmo com as duas
     TVs transmitindo ao mesmo tempo.

       oferta    dev  -> TV     comeco da transmissao   { tv, de, sdp }
       resposta  TV   -> dev                            { para, sdp }
       ice       dev  -> TV                             { tv, de, candidate }
                 TV   -> dev                            { para, candidate }
       parar     dev  -> TV     fim da transmissao      { tv, de }
     ------------------------------------------------------------------------ */
  if (rota === "/sinal" && req.method === "POST") {
    return lerCorpo(req, function (err, msg) {
      if (err) return json(res, 400, { erro: "JSON invalido" });

      /* da TV para um dev especifico (stats: medidas da transmissao na TV) */
      if (msg.tipo === "stats") guardarMedida(msg.tv, "tvRecebe", msg.dados);
      if ((msg.tipo === "resposta" || msg.tipo === "ice" || msg.tipo === "stats") && msg.para) {
        const alvo = acharCliente(msg.para);
        if (alvo) enviar(alvo.res, msg);
        return json(res, 200, { ok: true });
      }

      if (!tvExiste(msg.tv)) return json(res, 400, { erro: "TV desconhecida" });
      const t = transmissao[msg.tv];

      if (msg.tipo === "oferta") {
        /* na mesma TV, um de cada vez; nas duas TVs, cada uma com o seu */
        if (t.dev !== null && t.dev !== msg.de) {
          return json(res, 409, { erro: "Outra pessoa já está transmitindo nesta TV." });
        }
        const telas = telasDa(msg.tv);
        if (!telas.length) {
          return json(res, 409, { erro: "Esta TV não está conectada. Confira se a página dela está aberta." });
        }
        /* a aba que conectou por ultimo e a mais provavel de ser a TV de verdade */
        const tela = telas[telas.length - 1];
        t.dev = msg.de;
        t.tela = tela.id;
        t.inicio = Date.now();
        enviar(tela.res, { tipo: "oferta", de: msg.de, sdp: msg.sdp });
        paraControles({ tipo: "compartilhando", tv: msg.tv, quem: msg.de });

        /* PC e TV em redes diferentes: o video vai direto entre os dois e,
           entre redes, costuma perder quase tudo. Avisa em vez de deixar o
           dev tentando sem saber o motivo. */
        const dev = acharCliente(msg.de);
        const rede = function (ip) { return ip.split(".").slice(0, 3).join("."); };
        const aviso = dev && dev.ip && tela.ip && rede(dev.ip) !== rede(tela.ip)
          ? "Seu PC (" + dev.ip + ") está numa rede diferente da TV (" + tela.ip + "). " +
            "A transmissão provavelmente vai falhar: conecte o PC no mesmo Wi-Fi da TV."
          : "";
        return json(res, 200, { ok: true, aviso: aviso });
      }

      if (msg.tipo === "ice") {
        /* do dev para a TV: so entrega se ele for quem esta transmitindo */
        if (t.dev === msg.de && t.tela !== null) {
          const tela = acharCliente(t.tela);
          if (tela) enviar(tela.res, msg);
        }
        return json(res, 200, { ok: true });
      }

      if (msg.tipo === "parar") {
        if (t.dev === msg.de) pararTransmissao(msg.tv, "parado pelo dev");
        return json(res, 200, { ok: true });
      }

      json(res, 400, { erro: "Tipo desconhecido" });
    });
  }

  /* --- medidas da transmissao, do lado do PC que envia --- */
  if (rota === "/medidas" && req.method === "POST") {
    return lerCorpo(req, function (err, corpo) {
      if (err) return json(res, 400, { erro: "JSON invalido" });
      guardarMedida(corpo.tv, "pcEnvia", corpo.envio);
      json(res, 200, { ok: true });
    });
  }

  /* --- ultimas medidas de cada TV, com a idade de cada uma em segundos --- */
  if (rota === "/diagnostico" && req.method === "GET") {
    /* /diagnostico?historico=infra : a serie dos ultimos minutos dessa TV */
    const tvHistorico = u.searchParams.get("historico");
    if (tvHistorico) return json(res, 200, historico[tvHistorico] || []);

    const agora = Date.now();
    const saida = {};
    Object.keys(diagnostico).forEach(function (tv) {
      saida[tv] = { transmitindoAgora: transmissao[tv].dev !== null };
      Object.keys(diagnostico[tv]).forEach(function (lado) {
        const m = diagnostico[tv][lado];
        saida[tv][lado] = Object.assign({ haSegundos: Math.round((agora - m.em) / 1000) }, m.dados);
      });
    });
    return json(res, 200, saida);
  }

  /* --- mandar uma TV recarregar --- */
  if (rota === "/recarregar" && req.method === "POST") {
    return lerCorpo(req, function (err, corpo) {
      if (err || !tvExiste(corpo.tv)) return json(res, 400, { erro: "TV desconhecida" });
      paraTv(corpo.tv, { tipo: "recarregar" });
      json(res, 200, { ok: true, telas: telasDa(corpo.tv).length });
    });
  }

  res.writeHead(404).end("Nao encontrado");
});

servidor.listen(PORTA, "0.0.0.0", function () {
  console.log("");
  console.log("  Painel no ar.");
  console.log("");
  TVS.forEach(function (t) {
    console.log("  " + t.nome + "  ->  http://<ip-do-chromebook>:" + PORTA + "/tv?nome=" + t.id);
  });
  console.log("  Devs  ->  http://<ip-do-chromebook>:" + PORTA + "/");
  console.log("");
  console.log("  Nao esqueca do encaminhamento de porta " + PORTA + " nas");
  console.log("  configuracoes de Linux do ChromeOS, senao ninguem enxerga.");
  console.log("");

  INTERMEDIARIOS.forEach(iniciarIntermediario);

  /* paineis com login que ja estavam salvos: reabre o navegador */
  sincronizarAbas();
});
