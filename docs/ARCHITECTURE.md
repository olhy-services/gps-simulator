# Arquitetura do gps-sim

O gps-sim é um processo Node que calcula onde o aparelho "está" a cada instante e
manda essa posição para ele. A página React só desenha a rota e envia comandos: o
relógio da simulação roda no servidor, então fechar a aba não para nem atrasa o
movimento.

```
 Navegador (React + MapLibre)            Computador (Node 22)                          Aparelhos
┌──────────────────────────┐  POST /api  ┌───────────────────────────────┐
│ App.tsx                  │ ──────────▶ │ http.ts (rotas + validação)   │
│  ├ RoutePanel / MapView  │             │  ├ routing.ts  ── OSRM ───────┼──▶ routing.openstreetmap.de
│  ├ MotionPanel / Player  │             │  ├ geocode.ts  ── Nominatim ──┼──▶ nominatim.openstreetmap.org
│  └ ScenarioPanel         │             │  ├ scenarios.ts ── scenarios/*.json
│      useSessions.ts      │ ◀── SSE ─── │  └ sessions.ts                │
└──────────────────────────┘ /api/events │       └ engine.ts (Simulation)│
                                         │            └ drivers/         │
                                         │               ├ android ──────┼──▶ adb shell cmd location   (Android 12+)
                                         │               ├ emulador ─────┼──▶ adb emu geo fix
                                         │               └ ios ──────────┼──▶ xcrun simctl location
                                         └───────────────────────────────┘
```

## Pastas

| Pasta | Papel |
|---|---|
| `src/server/` | Servidor HTTP + SSE, motor da simulação, drivers dos aparelhos, rotas e busca de endereço. Roda com `tsx` (sem build). |
| `src/web/` | Interface React com mapa (MapLibre). Em dev, servida pelo Vite em modo middleware; em produção, de `dist/web`. |
| `src/shared/` | `schema.ts` (contratos Zod) e `geo.ts` (distância, ponto ao longo do caminho, ruído), usados pelos dois lados. |
| `scenarios/` | Cenários salvos em JSON. Versionáveis e usados pelo `gps-sim run`. |
| `bin/` | Ponto de entrada `gps-sim`. |
| `landing/` | Página de apresentação estática (não faz parte do app). |

## Como a simulação funciona

`Simulation` (em `engine.ts`) modela a posição como **a distância já percorrida** ao
longo da linha da rota (`route.path`). Cada waypoint é um ponto de controle nessa
distância.

1. A cada `tickMs` (padrão 250 ms), o motor mede o tempo real que passou e multiplica
   por `timeScale` (aceleração do tempo).
2. `advance()` gasta esse tempo: andando a `speedKmh`, ou parado no `dwellSec` do
   waypoint alcançado. Um tick pode atravessar vários waypoints.
3. No fim da rota aplica `loop`: `off` (para), `restart` (volta ao início) ou
   `pingpong` (inverte o sentido).
4. `updatePosition()` converte a distância em latitude/longitude e rumo, e aplica
   ruído (`jitterM`) se houver.
5. O driver envia o `Fix` ao aparelho e o estado sai para a interface por SSE.

Pausar, pular na barra (`seek`), mudar velocidade e simular perda de sinal alteram o
estado da simulação em andamento, sem recriá-la. O `step()` é público para os testes
avançarem o relógio sem esperar (`engine.test.ts`).

`SessionManager` guarda uma simulação por aparelho. Dá para rodar vários aparelhos ao
mesmo tempo, cada um com sua rota.

## Drivers

Cada tipo de aparelho implementa `LocationDriver` (`drivers/types.ts`):

```ts
interface LocationDriver {
  prepare(): Promise<void>;          // deixa pronto para receber posições
  push(fix: Fix): Promise<void>;     // envia uma posição
  release(): Promise<void>;          // devolve o GPS real (pode ser chamado mais de uma vez)
}
```

| Driver | Como envia | Observações |
|---|---|---|
| `AndroidDeviceDriver` | `cmd location providers set-test-provider-location` nos provedores `gps`, `network` e `fused` | Android 12+. Usa um `adb shell` persistente: abrir um shell por posição custa ~100 ms, reaproveitar custa poucos ms. A posição chega marcada como mock. |
| `AndroidEmulatorDriver` | `adb emu geo fix` | Alimenta o GNSS emulado; não é marcado como mock e leva a velocidade. |
| `IosSimulatorDriver` | `xcrun simctl location <udid> set` | macOS + Xcode 14+. |

Para suportar outro tipo de aparelho: crie o driver, inclua o `kind` em
`DeviceSchema` e no `switch` de `drivers/index.ts`, e devolva os aparelhos em
`listDevices()`.

## Canais entre servidor e navegador

| Canal | Conteúdo |
|---|---|
| `GET /api/devices` | Aparelhos e se `adb`/`xcrun` existem. A interface consulta a cada 3 s. |
| `POST /api/route` | Calcula a rota (OSRM ou linha reta). |
| `GET /api/geocode?q=` | Busca de endereço (Nominatim, no máximo 1 req/s). |
| `GET/PUT/DELETE /api/scenarios/:slug` | Cenários em `scenarios/`. O slug é validado por regex, então não sai da pasta. |
| `POST /api/sim/:id/start` · `teleport` · `pause` · `resume` · `restart` · `seek` · `motion` · `signal` · `stop` | Controle da simulação de um aparelho. |
| `POST /api/devices/:id/reset` | Devolve o GPS real mesmo sem sessão ativa. |
| `GET /api/events` (SSE) | `sessions` (lista inicial e mudanças) e `tick` (posição a cada envio). |

Corpos e respostas são schemas Zod de `src/shared/schema.ts`.

## Segurança

- Escuta em `127.0.0.1` por padrão.
- Recusa `Host` que não seja local (DNS rebinding).
- Comandos exigem `Content-Type: application/json` (força preflight de CORS, que o
  servidor não responde) e `Origin` igual ao próprio servidor.
- Os valores que entram no shell do aparelho são números formatados pelo servidor;
  ids e slugs passam por schema.

## Decisões

- **Relógio no servidor**, não no navegador: aba em segundo plano tem `setInterval`
  estrangulado pelo navegador, o que faria o aparelho "travar" no meio da rota.
- **Distância percorrida como estado**, não posição: pausar, pular, mudar velocidade
  e ida-e-volta viram contas simples sobre um número.
- **Serviços públicos do OpenStreetMap por padrão**, com variáveis para apontar para
  servidores próprios em uso intenso (CI, times grandes).
