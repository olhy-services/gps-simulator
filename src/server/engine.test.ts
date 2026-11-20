import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Device, Route, Scenario } from '../shared/schema';
import type { Fix, LocationDriver } from './drivers';
import { Simulation } from './engine';

const device: Device = { id: 'fake', kind: 'android-emulator', connection: 'local', label: 'Fake', unavailableReason: null };

class FakeDriver implements LocationDriver {
  readonly device = device;
  fixes: Fix[] = [];
  async prepare() {}
  async push(fix: Fix) {
    this.fixes.push(fix);
  }
  async release() {}
}

// Três pontos numa linha norte-sul: 0 → ~1000 m → ~2000 m.
const A = { lat: 0, lng: 0 };
const B = { lat: 0.008_993, lng: 0 };
const C = { lat: 0.017_986, lng: 0 };

function scenario(dwell: [number, number, number], loop: Scenario['motion']['loop']): Scenario {
  return {
    version: 1,
    name: 'teste',
    mode: 'straight',
    profile: 'car',
    waypoints: [A, B, C].map((p, i) => ({ ...p, id: String(i), label: '', dwellSec: dwell[i] ?? 0 })),
    motion: { speedKmh: 36, timeScale: 1, accuracyM: 5, jitterM: 0, tickMs: 1000, loop },
  };
}

const route: Route = { path: [A, B, C], distanceM: 2000, stopDistancesM: [0, 1000, 2000] };

function make(dwell: [number, number, number], loop: Scenario['motion']['loop']) {
  return Simulation.route(new FakeDriver(), scenario(dwell, loop), route, { onTick: () => undefined });
}

test('anda na velocidade configurada (36 km/h = 10 m/s)', () => {
  const sim = make([0, 0, 0], 'off');
  sim.step(50);
  assert.ok(Math.abs(sim.state().traveledM - 500) < 1);
  assert.equal(sim.state().status, 'running');
});

test('para no ponto do meio pelo tempo configurado', () => {
  const sim = make([0, 30, 0], 'off');
  sim.step(100 + 10); // chega em B e fica 10 s parado
  let s = sim.state();
  assert.equal(s.status, 'dwelling');
  assert.equal(s.stopIndex, 1);
  assert.ok(Math.abs(s.dwellRemainingSec - 20) < 0.01);
  sim.step(20 + 50); // termina a parada e anda 500 m
  s = sim.state();
  assert.equal(s.status, 'running');
  assert.ok(Math.abs(s.traveledM - 1500) < 2);
});

test('espera no primeiro ponto antes de sair', () => {
  const sim = make([15, 0, 0], 'off');
  assert.equal(sim.state().status, 'dwelling');
  sim.step(15 + 10);
  assert.ok(Math.abs(sim.state().traveledM - 100) < 1);
});

test('termina no destino sem repetição', () => {
  const sim = make([0, 0, 0], 'off');
  sim.step(1000);
  assert.equal(sim.state().status, 'finished');
  assert.ok(Math.abs(sim.state().traveledM - sim.state().totalM) < 0.001);
});

test('ida e volta inverte o sentido no fim', () => {
  const sim = make([0, 0, 0], 'pingpong');
  sim.step(200 + 30); // chega em C e volta 300 m
  const s = sim.state();
  assert.equal(s.direction, -1);
  assert.equal(s.lap, 2);
  assert.ok(Math.abs(s.traveledM - (s.totalM - 300)) < 2);
  assert.ok(Math.abs(s.bearing - 180) < 1, `rumo voltando deveria ser sul, veio ${s.bearing}`);
});

test('recomeçar volta ao início e respeita a espera do primeiro ponto', () => {
  const sim = make([5, 0, 0], 'restart');
  sim.step(5 + 200 + 2); // espera, percorre tudo, recomeça e espera 2 s
  const s = sim.state();
  assert.equal(s.lap, 2);
  assert.equal(s.status, 'dwelling');
  assert.equal(s.traveledM, 0);
});

test('seek posiciona, aponta o próximo ponto e continua andando', () => {
  const sim = make([0, 0, 0], 'off');
  sim.seek(0.75);
  const s = sim.state();
  assert.ok(Math.abs(s.traveledM - 1500) < 2);
  assert.equal(s.stopIndex, 2);
  assert.equal(s.status, 'running');
});

test('seek depois de terminar deixa pausado no ponto escolhido', () => {
  const sim = make([0, 0, 0], 'off');
  sim.step(1000);
  sim.seek(0.25);
  assert.equal(sim.state().status, 'paused');
  assert.equal(sim.state().stopIndex, 1);
});
