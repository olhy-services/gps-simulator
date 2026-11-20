# Como contribuir

Obrigado pelo interesse! Issues e pull requests são bem-vindos.

## Preparar o ambiente

```bash
git clone https://github.com/olhy-services/gps-simulator.git
cd gps-simulator
pnpm install   # Node 22+ (veja .nvmrc)
pnpm dev       # http://127.0.0.1:4600, recarrega ao salvar
```

Para testar de verdade você precisa de pelo menos um destes: emulador Android,
Android 12+ com Depuração USB, ou simulador iOS (macOS).

## Antes de abrir o PR

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

O CI roda esses quatro comandos e precisa passar.

## Regras do código

- **TypeScript estrito, sem `any` e sem forçar tipo** (`as X`, `!`, `@ts-ignore`).
  Só `as const` é aceito. Dado de fora (rede, saída do `adb`/`xcrun`, JSON de
  cenário) entra como `unknown` e passa por Zod.
- **Contratos em `src/shared/schema.ts`.** Rota nova tem schema de entrada e de
  saída; não escreva interface à mão duplicando um schema.
- **Mudança no motor (`engine.ts`) vem com teste** em `engine.test.ts`, usando
  `step()` para avançar o relógio sem esperar.
- **Driver novo** implementa `LocationDriver` e tem `release()` seguro para chamar mais
  de uma vez. Veja [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#drivers).
- **Respeite os serviços públicos**: nada de chamadas extras ao OSRM ou Nominatim em
  loop; o Nominatim tem limite de 1 req/s.
- **Interface:** siga o [DESIGN.md](DESIGN.md). Textos e erros em português do Brasil.

## Commits

Mensagens curtas no imperativo, descrevendo o efeito. Exemplos:
`corrige rumo no modo ida e volta`, `adiciona driver para Genymotion`.

Ao contribuir, você concorda que seu código seja distribuído sob a [licença MIT](LICENSE).
