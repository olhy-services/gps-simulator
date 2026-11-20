import { LoopModeSchema, type Motion, type MotionPatch } from '../../shared/schema';
import { LOOP_LABEL } from '../labels';

const SPEED_PRESETS = [5, 15, 30, 45, 60, 80];
const TIME_SCALES = [1, 2, 5, 10, 20];

interface MotionPanelProps {
  motion: Motion;
  /** Simulação rodando com esta rota: as mudanças valem na hora. */
  live: boolean;
  onChange(patch: MotionPatch): void;
}

export function MotionPanel({ motion, live, onChange }: MotionPanelProps) {
  return (
    <section className="section" aria-labelledby="motion-title">
      <div className="section-head">
        <h2 id="motion-title">Movimento</h2>
        {live && <span className="hint">muda na hora</span>}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <label className="field">
          <span>Velocidade</span>
          <div className="row">
            <span className="unit-input" style={{ width: 96, flex: "none" }}>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min={0.5}
                max={400}
                step={1}
                value={motion.speedKmh}
                onChange={(e) => {
                  const v = e.target.valueAsNumber;
                  if (Number.isFinite(v) && v >= 0.5 && v <= 400) onChange({ speedKmh: v });
                }}
              />
              <i>km/h</i>
            </span>
            <div className="chips" role="group" aria-label="Velocidades comuns em km/h">
              {SPEED_PRESETS.map((kmh) => (
                <button
                  key={kmh}
                  type="button"
                  className="chip"
                  aria-pressed={motion.speedKmh === kmh}
                  onClick={() => onChange({ speedKmh: kmh })}
                >
                  {kmh}
                </button>
              ))}
            </div>
          </div>
        </label>
      </div>

      <div className="fields-2">
        <label className="field">
          <span>Ritmo</span>
          <select
            className="select"
            value={motion.timeScale}
            onChange={(e) => onChange({ timeScale: Number(e.target.value) })}
          >
            {TIME_SCALES.map((x) => (
              <option key={x} value={x}>
                {x === 1 ? 'Tempo real' : `${x}× mais rápido`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>No fim da rota</span>
          <select
            className="select"
            value={motion.loop}
            onChange={(e) => {
              const loop = LoopModeSchema.safeParse(e.target.value);
              if (loop.success) onChange({ loop: loop.data });
            }}
          >
            {LoopModeSchema.options.map((mode) => (
              <option key={mode} value={mode}>
                {LOOP_LABEL[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details>
        <summary>Sinal do GPS</summary>
        <div className="fields-3">
          <NumberField
            label="Precisão"
            unit="m"
            value={motion.accuracyM}
            min={1}
            max={500}
            onChange={(accuracyM) => onChange({ accuracyM })}
          />
          <NumberField label="Ruído" unit="m" value={motion.jitterM} min={0} max={200} onChange={(jitterM) => onChange({ jitterM })} />
          <NumberField
            label="Envio a cada"
            unit="ms"
            value={motion.tickMs}
            min={200}
            max={10_000}
            step={50}
            onChange={(tickMs) => onChange({ tickMs: Math.round(tickMs) })}
          />
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Ruído faz a posição oscilar como um GPS real perto de prédios. Envios mais frequentes deixam o movimento mais
          fluido.
        </p>
      </details>
    </section>
  );
}

interface NumberFieldProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
}

function NumberField({ label, unit, value, min, max, step = 1, onChange }: NumberFieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="unit-input">
        <input
          className="input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
          }}
        />
        <i>{unit}</i>
      </span>
    </label>
  );
}
