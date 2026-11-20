import { Pause, Play, RotateCcw, Square, WifiOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { formatClock, formatDistance, formatDuration } from '../../shared/geo';
import type { SessionDetail } from '../../shared/schema';
import { waypointLetter } from '../labels';

export interface Notice {
  tone: 'error' | 'info';
  text: string;
}

interface PlayerProps {
  session: SessionDetail | null;
  /** Já dá pra iniciar (aparelho pronto + rota calculada). */
  canStart: boolean;
  /** O que falta para poder iniciar, quando não dá. */
  blockedReason: string | null;
  /** A rota em edição é diferente da que está rodando no aparelho. */
  routeChanged: boolean;
  busy: boolean;
  notice: Notice | null;
  onDismissNotice(): void;
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onRestart(): void;
  onStop(): void;
  onSeek(fraction: number): void;
  onSignal(lost: boolean): void;
}

export function Player(props: PlayerProps) {
  const { session, canStart, routeChanged, busy } = props;
  const showStart = !session || session.status === 'fixed' || routeChanged;
  const moving = session?.status === 'running' || session?.status === 'dwelling';

  return (
    <div className="player" aria-label="Controle da simulação">
      <PlayerHead session={session} />
      {session?.route && <Track session={session} onSeek={props.onSeek} />}

      {session?.lastError && <p className="error">O aparelho recusou a posição: {session.lastError}</p>}
      {props.notice && (
        <p className={`notice ${props.notice.tone === 'error' ? 'error' : 'info'}`} role={props.notice.tone === 'error' ? 'alert' : 'status'}>
          <span>{props.notice.text}</span>
          <button type="button" className="btn icon sm ghost" onClick={props.onDismissNotice} aria-label="Fechar mensagem">
            <X size={14} />
          </button>
        </p>
      )}
      {showStart && !canStart && props.blockedReason && <p className="hint">{props.blockedReason}</p>}

      <div className="player-actions">
        {showStart ? (
          <button type="button" className="btn primary" disabled={!canStart || busy} onClick={props.onStart}>
            <Play size={16} /> {routeChanged ? 'Iniciar com a rota nova' : 'Iniciar'}
          </button>
        ) : moving ? (
          <button type="button" className="btn primary" disabled={busy} onClick={props.onPause}>
            <Pause size={16} /> Pausar
          </button>
        ) : session?.status === 'paused' ? (
          <button type="button" className="btn primary" disabled={busy} onClick={props.onResume}>
            <Play size={16} /> Continuar
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={props.onRestart}>
            <RotateCcw size={16} /> Fazer de novo
          </button>
        )}

        {session?.route && session.status !== 'finished' && !showStart && (
          <button
            type="button"
            className="btn icon"
            disabled={busy}
            onClick={props.onRestart}
            aria-label="Voltar ao início da rota"
            title="Voltar ao início da rota"
          >
            <RotateCcw size={16} />
          </button>
        )}
        {session && (
          <button
            type="button"
            className="btn icon"
            aria-pressed={session.signalLost}
            disabled={busy}
            onClick={() => props.onSignal(!session.signalLost)}
            aria-label={session.signalLost ? 'Devolver o sinal' : 'Simular perda de sinal'}
            title={session.signalLost ? 'Devolver o sinal' : 'Simular perda de sinal (túnel, garagem)'}
          >
            <WifiOff size={16} />
          </button>
        )}
        {session && (
          <button type="button" className="btn" disabled={busy} onClick={props.onStop} title="Para e devolve o GPS real ao aparelho">
            <Square size={13} /> Parar
          </button>
        )}
      </div>
    </div>
  );
}

function stopName(session: SessionDetail, index: number): string {
  const wp = session.scenario?.waypoints[index];
  return wp?.label || `ponto ${waypointLetter(index)}`;
}

function PlayerHead({ session }: { session: SessionDetail | null }) {
  if (!session) {
    return (
      <div className="player-head">
        <div className="status-line">
          <span className="dot" />
          <span>Parado, aparelho com o GPS real</span>
        </div>
      </div>
    );
  }

  const remainingM = session.direction === 1 ? session.totalM - session.traveledM : session.traveledM;
  const etaSec = session.speedKmh > 0 ? remainingM / (session.speedKmh / 3.6) : null;
  const pace = session.motion.timeScale !== 1 ? ` · ${session.motion.timeScale}×` : '';

  let tone = 'ok';
  let text: string;
  let eta: string | null = null;
  switch (session.status) {
    case 'running':
      text = `Andando a ${session.motion.speedKmh} km/h${pace}`;
      eta = etaSec !== null ? `${formatDistance(remainingM)} · ${formatDuration(etaSec)}` : null;
      break;
    case 'dwelling':
      text = `Parado em ${stopName(session, session.stopIndex)}`;
      eta = `sai em ${formatClock(session.dwellRemainingSec)}`;
      tone = 'warn';
      break;
    case 'paused':
      text = 'Pausado';
      eta = `faltam ${formatDistance(remainingM)}`;
      tone = 'warn';
      break;
    case 'finished':
      text = `Chegou em ${stopName(session, (session.scenario?.waypoints.length ?? 1) - 1)}`;
      break;
    case 'fixed':
      text = 'Posição fixa';
      eta = session.position ? `${session.position.lat.toFixed(5)}, ${session.position.lng.toFixed(5)}` : null;
      break;
  }
  if (session.lap > 1) text += ` · volta ${session.lap}`;
  if (session.signalLost) {
    text += ' · sem sinal';
    tone = 'warn';
  }

  return (
    <div className="player-head">
      <div className="status-line" role="status">
        <span className={`dot ${session.lastError ? 'danger' : tone}`} />
        <span>{text}</span>
      </div>
      {eta && <span className={`eta num ${session.status === 'fixed' ? 'mono' : ''}`}>{eta}</span>}
    </div>
  );
}

function Track({ session, onSeek }: { session: SessionDetail; onSeek(fraction: number): void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const route = session.route;
  const fraction = session.totalM > 0 ? session.traveledM / session.totalM : 0;
  const shown = dragging ?? fraction;

  // Preenchimento da trilha (WebKit não tem pseudo-elemento de progresso).
  useEffect(() => {
    inputRef.current?.style.setProperty('--fill', `${(shown * 100).toFixed(2)}%`);
  }, [shown]);

  if (!route) return null;
  const stops = route.stopDistancesM.map((d) => (route.distanceM > 0 ? d / route.distanceM : 0));

  const commit = () => {
    if (dragging === null) return;
    onSeek(dragging);
    setDragging(null);
  };

  return (
    <div>
      <div className="track">
        <input
          ref={inputRef}
          type="range"
          min={0}
          max={1000}
          value={Math.round(shown * 1000)}
          aria-label="Posição na rota"
          aria-valuetext={`${formatDistance(shown * session.totalM)} de ${formatDistance(session.totalM)}`}
          onChange={(e) => setDragging(Number(e.target.value) / 1000)}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className="track-stops" aria-hidden="true">
          {stops.map((f, i) => (
            <span key={i} style={{ left: `${Math.min(100, Math.max(0, f * 100))}%` }}>
              {waypointLetter(i)}
            </span>
          ))}
        </div>
      </div>
      <div className="track-numbers num">
        <span>{formatDistance(shown * session.totalM)}</span>
        <span>{formatDistance(session.totalM)}</span>
      </div>
    </div>
  );
}
