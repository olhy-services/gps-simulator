import { Download, FilePlus2, Save, Upload } from 'lucide-react';
import { useRef } from 'react';

import type { ScenarioSummary } from '../../shared/schema';

interface ScenarioPanelProps {
  name: string;
  saved: ScenarioSummary[];
  canSave: boolean;
  canExportGpx: boolean;
  onName(name: string): void;
  onSave(): void;
  onOpen(slug: string): void;
  onNew(): void;
  onImport(file: File): void;
  onExportJson(): void;
  onExportGpx(): void;
}

export function ScenarioPanel(props: ScenarioPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <section className="section" aria-labelledby="scenario-title">
      <div className="section-head">
        <h2 id="scenario-title">Cenário</h2>
        <button type="button" className="btn ghost sm" onClick={props.onNew} title="Começar uma rota do zero">
          <FilePlus2 size={14} /> Novo
        </button>
      </div>

      <div className="row">
        <input
          className="input grow"
          value={props.name}
          onChange={(e) => props.onName(e.target.value)}
          placeholder="Nome, ex.: Entrega centro → bairro"
          aria-label="Nome do cenário"
        />
        <button
          type="button"
          className="btn"
          onClick={props.onSave}
          disabled={!props.canSave}
          title={props.canSave ? 'Salvar como JSON na pasta scenarios/' : 'Marque pelo menos dois pontos'}
        >
          <Save size={15} /> Salvar
        </button>
      </div>

      <div className="row">
        <select
          className="select grow"
          aria-label="Abrir cenário salvo"
          value=""
          disabled={props.saved.length === 0}
          onChange={(e) => e.target.value && props.onOpen(e.target.value)}
        >
          <option value="">{props.saved.length === 0 ? 'Nenhum cenário salvo' : 'Abrir cenário salvo…'}</option>
          {props.saved.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name} ({s.waypointCount} pontos)
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn icon"
          onClick={() => fileRef.current?.click()}
          aria-label="Importar cenário de um arquivo JSON"
          title="Importar arquivo JSON"
        >
          <Upload size={16} />
        </button>
      </div>

      <div className="row wrap" style={{ gap: 4 }}>
        <span className="hint">Exportar:</span>
        <button type="button" className="btn ghost sm" onClick={props.onExportJson} disabled={!props.canSave}>
          <Download size={14} /> JSON
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={props.onExportGpx}
          disabled={!props.canExportGpx}
          title="Para simular num iPhone físico pelo Xcode (Debug › Simulate Location)"
        >
          <Download size={14} /> GPX para Xcode
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) props.onImport(file);
          e.target.value = '';
        }}
      />
    </section>
  );
}
