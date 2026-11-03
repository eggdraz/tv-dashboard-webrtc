#!/bin/bash
# Sobe o servidor do painel das TVs, se ainda nao estiver rodando.
# Usado pelo icone "Iniciar painel das TVs" do menu de apps do Chromebook,
# mas tambem funciona direto no Terminal: ~/servidor/iniciar-painel.sh

cd "$(dirname "$0")" || exit 1

if pgrep -x -f "node server.js" > /dev/null; then
  echo "O painel ja esta rodando."
  exit 0
fi

# Log com tamanho limitado: passou de 5 MB, guarda so o ultimo 1 MB.
if [ -f painel.log ] && [ "$(stat -c%s painel.log)" -gt 5000000 ]; then
  tail -c 1000000 painel.log > painel.log.tmp && mv painel.log.tmp painel.log
fi

# setsid: o servidor vira um processo independente. Sem isso, quando o
# icone do menu termina, o ChromeOS pode encerrar o servidor junto.
setsid nohup node server.js >> painel.log 2>&1 < /dev/null &
sleep 2

if pgrep -x -f "node server.js" > /dev/null; then
  echo "Painel no ar."
else
  echo "O painel nao subiu. Veja o motivo com: tail -20 ~/servidor/painel.log"
  exit 1
fi
