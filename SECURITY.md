# Segurança

## Versões com suporte

Só a branch `main` recebe correções.

## Como reportar

Não abra issue pública para falha de segurança. Use o
[reporte privado do GitHub](https://github.com/olhy-services/gps-simulator/security/advisories/new).
Responderemos em até 5 dias úteis.

Inclua: o que um atacante consegue fazer, os passos para reproduzir e a versão
(commit) testada.

## Modelo de ameaça

O gps-sim controla um aparelho conectado por `adb` com os poderes do shell do adb.
Por isso ele é pensado para rodar **só no computador de quem usa**:

- O servidor escuta em `127.0.0.1` por padrão.
- Requisições com cabeçalho `Host` diferente de `localhost`/`127.0.0.1`/`[::1]`
  são recusadas (proteção contra DNS rebinding).
- Comandos (`POST`/`PUT`/`DELETE`) e WebSocket só são aceitos vindos da
  própria página (`Origin` igual ao servidor), então um site aberto em outra aba
  não consegue mandar comandos.
- Toda entrada (corpo, parâmetros, mensagens do WebSocket) é validada com Zod.

São fora do escopo: quem já tem acesso ao seu usuário no computador, ou quem já
tem acesso ao adb do aparelho, porque esses já têm o mesmo poder que a ferramenta.
