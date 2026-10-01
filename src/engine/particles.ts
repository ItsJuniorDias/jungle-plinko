/**
 * Pooled additive particle bursts (sparks, glow dust). Fading is done by
 * darkening vertex colours, which under additive blending reads as transparency
 * — one draw call for every live particle.
 */
import * as THREE from "three";
import { softDotTexture } from "./painted";

interface Particle {
  life: number;
  maxLife: number;
  vel: THREE.Vector3;
  color: THREE.Color;
}

export class ParticleBurst {
  readonly points: THREE.Points;
  private particles: Particle[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private cursor = 0;

  constructor(
    private capacity = 600,
    size = 0.28,
    private gravity = -9,
  ) {
    this.positions = new Float32Array(capacity * 3).fill(9999);
    this.colors = new Float32Array(capacity * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: softDotTexture(),
        size,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      this.particles.push({ life: 0, maxLife: 1, vel: new THREE.Vector3(), color: new THREE.Color() });
    }
  }

  emit(origin: THREE.Vector3, count: number, color: THREE.ColorRepresentation, speed = 4, spread = Math.PI * 2, up = 1.2) {
    const base = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const p = this.particles[i];
      const angle = Math.PI / 2 + (Math.random() - 0.5) * spread;
      const v = speed * (0.4 + Math.random() * 0.8);
      p.vel.set(Math.cos(angle) * v, Math.sin(angle) * v * up, (Math.random() - 0.5) * v * 0.4);
      p.maxLife = p.life = 0.5 + Math.random() * 0.7;
      p.color.copy(base).offsetHSL((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.15);
      this.positions.set([origin.x, origin.y, origin.z], i * 3);
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      const o = i * 3;
      if (p.life <= 0) {
        this.positions[o + 1] = 9999;
        this.colors.fill(0, o, o + 3);
        continue;
      }
      p.vel.y += this.gravity * dt;
      p.vel.multiplyScalar(Math.pow(0.35, dt)); // air drag
      this.positions[o] += p.vel.x * dt;
      this.positions[o + 1] += p.vel.y * dt;
      this.positions[o + 2] += p.vel.z * dt;
      const fade = p.life / p.maxLife;
      this.colors[o] = p.color.r * fade;
      this.colors[o + 1] = p.color.g * fade;
      this.colors[o + 2] = p.color.b * fade;
    }
    this.points.geometry.getAttribute("position").needsUpdate = true;
    this.points.geometry.getAttribute("color").needsUpdate = true;
  }
}
