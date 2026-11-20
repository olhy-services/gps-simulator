import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Scenario, ScenarioSchema, type ScenarioSummary } from '../shared/schema';
import { NotFoundError } from './sessions';

/**
 * Cenários salvos como JSON numa pasta (padrão: ./scenarios do projeto).
 * São arquivos comuns: dá pra versionar no git do seu app e compartilhar com o time.
 * O slug já chega validado (regex) — não há como escapar da pasta.
 */
export class ScenarioStore {
  constructor(readonly dir: string) {}

  private file(slug: string): string {
    return join(this.dir, `${slug}.json`);
  }

  async list(): Promise<ScenarioSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort();
    const out: ScenarioSummary[] = [];
    for (const file of files) {
      const slug = file.slice(0, -'.json'.length);
      try {
        const scenario = await this.read(slug);
        out.push({ slug, name: scenario.name, waypointCount: scenario.waypoints.length });
      } catch (error) {
        console.warn(`[gps-sim] cenário ignorado ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return out;
  }

  async read(slug: string): Promise<Scenario> {
    let text: string;
    try {
      text = await readFile(this.file(slug), 'utf8');
    } catch {
      throw new NotFoundError(`Cenário "${slug}" não encontrado`);
    }
    const raw: unknown = JSON.parse(text);
    return ScenarioSchema.parse(raw);
  }

  async write(slug: string, scenario: Scenario): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(slug), `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  }

  async remove(slug: string): Promise<void> {
    await rm(this.file(slug), { force: true });
  }
}

/** Lê um cenário de um caminho qualquer (CLI). */
export async function readScenarioFile(path: string): Promise<Scenario> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return ScenarioSchema.parse(raw);
}
