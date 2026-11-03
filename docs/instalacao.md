# Instalação

O servidor é um arquivo só (`server.js`) e roda em qualquer máquina com **Node 18 ou mais novo**. Não tem `npm install`.

- [Em Linux comum](#em-linux-comum-o-caso-mais-simples) — o caso mais simples
- [No Chromebook (Linux do ChromeOS)](#no-chromebook-linux-do-chromeos) — funciona, com armadilhas conhecidas
- [Nas TVs](#nas-tvs)
- [Transmissão de tela: uma vez por PC](#transmissão-de-tela-uma-vez-por-pc)
- [Configuração](#configuração)

---

## Em Linux comum (o caso mais simples)

```bash
sudo apt install -y nodejs        # confira: node --version  (18+)
git clone https://github.com/eggdraz/tv-dashboard-webrtc.git ~/servidor
cd ~/servidor
node server.js
```

### Subir sozinho no boot

Um serviço do systemd reinicia o servidor se ele cair e sobe junto com a máquina:

```bash
sudo tee /etc/systemd/system/painel-tv.service >/dev/null <<EOF
[Unit]
Description=Painel das TVs
After=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME/servidor
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now painel-tv
```

Ver o log: `journalctl -u painel-tv -f`

### IP fixo

As TVs guardam o endereço do servidor. Se o IP mudar, todas param. Peça uma **reserva de IP no roteador (DHCP)** pra máquina do servidor — é a coisa que mais evita dor de cabeça.

---

## No Chromebook (Linux do ChromeOS)

Funciona bem e aproveita um Chromebook parado, mas o ChromeOS tem particularidades. Todas abaixo aconteceram de verdade.

### 1. Antes de instalar o Linux

Em `chrome://flags/#crostini-containerless`, deixe **desligado**. Ligado, ele quebra o encaminhamento de portas — e o painel fica invisível pra rede.

### 2. Instalar

Configurações → Desenvolvedores → **Ambiente de desenvolvimento Linux** → Ativar. Depois, no Terminal:

```bash
sudo apt update && sudo apt install -y nodejs git
git clone https://github.com/eggdraz/tv-dashboard-webrtc.git ~/servidor
chmod +x ~/servidor/iniciar-painel.sh
~/servidor/iniciar-painel.sh
```

### 3. Encaminhamento de portas

O Linux do ChromeOS roda isolado; a rede só enxerga as portas encaminhadas.

Configurações → Desenvolvedores → Linux → **Encaminhamento de portas** → adicionar e **ativar**:

| Porta | Pra quê |
|---|---|
| 8080 | Painel (obrigatória) |
| 8081 | Intermediário de sites com login (se usar) |
| 2222 | SSH (se usar — a 22 é aceita na tela, mas não funciona) |

> ⚠️ **Armadilhas conhecidas**
> - As portas às vezes voltam **desligadas** depois de reiniciar.
> - Se o IP ou a rede mudam, as portas continuam "ligadas" na tela mas **param de funcionar**. Desligue e ligue cada uma de novo.
> - Com **cabo e Wi-Fi ao mesmo tempo**, o ChromeOS encaminha as portas só pela rede do cabo — e não dá pra mudar essa prioridade. Deixe uma rede só.

### 4. Subir o painel

O ChromeOS não tem "serviço no boot" pro Linux. Duas formas:

**Ícone no menu de apps** (roda em silêncio):

```bash
sed "s|SEU_USUARIO|$USER|" ~/servidor/painel-tv.desktop > ~/.local/share/applications/painel-tv.desktop
```

**Ao abrir o Terminal** — cole no fim do `~/.bashrc`:

```bash
# >>> painel das TVs >>>
if [ -n "$PS1" ] && [ -x ~/servidor/iniciar-painel.sh ]; then
  ~/servidor/iniciar-painel.sh
  cd ~/servidor
fi
# <<< painel das TVs <<<
```

O `iniciar-painel.sh` não sobe duas cópias, limita o log a 5 MB e solta o servidor do Terminal (`setsid`), pra ele não morrer quando a janela fecha.

### 5. Energia

Configurações → Dispositivo → Energia: desligue **"Suspender ao fechar a tampa"**. Com o Chromebook suspenso, o Linux para e o painel cai.

### SSH (opcional, pra atualizar de outro PC)

O ChromeOS bloqueia o servidor SSH de propósito. Pra liberar, só com chave e na porta 2222:

```bash
sudo apt install -y openssh-server
sudo tee /etc/ssh/sshd_config.d/painel.conf >/dev/null <<EOF
Port 2222
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF
sudo rm -f /etc/ssh/sshd_not_to_be_run
sudo mkdir -p /run/sshd
sudo systemctl enable --now ssh
```

Adicione a chave **pública** de cada pessoa em `~/.ssh/authorized_keys` (uma por linha — assim dá pra tirar o acesso de uma sem afetar as outras). Uma atualização do ChromeOS pode recriar o `sshd_not_to_be_run`; se o SSH parar, rode a linha do `rm` de novo.

---

## Nas TVs

1. Abra o **navegador** da TV.
2. Acesse `http://<ip-do-servidor>:8080/tv?nome=<id-da-tv>` — o `id` vem da lista `TVS` do `server.js`.
3. Salve nos favoritos.
4. Clique em **"Abrir em tela cheia"** (aparece ao mexer o cursor).

A TV, o servidor e quem transmite precisam estar **na mesma rede**. Entre redes diferentes o painel até pode abrir, mas a transmissão de tela costuma falhar (o vídeo vai direto do PC pra TV) — o servidor avisa quando detecta isso.

**Tecla R** no controle remoto recarrega a página.

---

## Transmissão de tela: uma vez por PC

Navegadores só liberam a captura de tela em `https://` ou `localhost`. Como o painel roda em `http://` na rede local, cada PC que for transmitir precisa liberar o endereço **uma vez**:

1. Abra `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (no Edge: `edge://flags/...`)
2. Marque **Enabled** e escreva `http://<ip-do-servidor>:8080`
3. Clique em **Relaunch**

A própria página de controle mostra esse passo a passo quando detecta que a captura está bloqueada. Se o IP do servidor mudar, refaça com o novo.

---

## Configuração

Tudo no topo do `server.js`:

```js
const PORTA = 8080;

const TVS = [
  { id: "infra",     nome: "TV Infra" },
  { id: "simulacao", nome: "TV Simulação" },
  { id: "teste",     nome: "TV de Teste" }   // pra testar num PC, sem mexer nas TVs
];

const ATALHOS = [                            // botões de acesso rápido no controle
  { nome: "Monitoramento", url: "https://...", zoom: 1.2, tv: "infra" }
];

const INTERMEDIARIOS = [                     // sites com login (ver docs/sites-com-login.md)
  { site: "https://app.exemplo.com", porta: 8081, apis: ["https://api.exemplo.com"] }
];
```

| Variável de ambiente | Padrão | Pra quê |
|---|---|---|
| `CHROMIUM` | `chromium` | Navegador do [modo remoto](sites-com-login.md#alternativa-navegador-no-servidor) |
| `PERFIL_NAVEGADOR` | `./perfil-navegador` | Onde o modo remoto guarda os cookies de login |

O que cada TV mostra fica em `estado.json`, criado e atualizado sozinho.
