# DESIGN.md — gps-sim

Ferramenta de dev: densa, neutra, o mapa é o protagonista.

- **Tokens** em `src/web/styles.css` (`:root`, com tema escuro via `prefers-color-scheme`).
- **`--primary`** só na ação principal do player (Iniciar/Pausar/Continuar). Nada decorativo.
- **Status** sempre com cor + texto: `--ok` andando, `--warn` parado/pausado/sem sinal,
  `--danger` erro do aparelho.
- **`--route`**: linha da rota e marcador ao vivo (seta = rumo do movimento).
- Pontos A, B, C… em quadrado escuro com letra (mesma marca na lista e no mapa).
- Sem gradientes, sombras coloridas, blur ou animações gratuitas. A única animação é o
  marcador deslizando entre posições, que representa movimento real (desligada com
  `prefers-reduced-motion`).
- Fonte do sistema; `--mono` para coordenadas e ids.
