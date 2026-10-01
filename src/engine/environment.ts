/**
 * Spring-style backdrop shared by all games: painted dusk sky, layered misty
 * ridges (2.5D parallax), drifting light shafts, floating pollen and warm
 * key/fill lighting for the toon materials.
 */
import * as THREE from "three";
import type { Stage } from "./stage";
import type { Art } from "./art";
import { lightShaftTexture, mulberry32, ridgeTexture, skyTexture, softDotTexture } from "./painted";

export function createSpringEnvironment(stage: Stage, art?: Art) {
  const { scene } = stage;
  const root = new THREE.Group();
  root.name = "spring-environment";
  scene.add(root);
  scene.background = new THREE.Color("#f2c99a");

  // --- Painted layers, far to near -----------------------------------------
  const plane = (w: number, h: number, map: THREE.Texture, z: number, y: number, extra: Partial<THREE.MeshBasicMaterialParameters> = {}) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: false, ...extra }),
    );
    mesh.position.set(0, y, z);
    root.add(mesh);
    return mesh;
  };

  const ridges: THREE.Mesh[] = [];
  const background = art?.texture("background");
  if (background) {
    // AI-painted backdrop, dimmed so it stays under the bloom threshold and behind the board.
    plane(76 * art!.aspect("background"), 76, background, -60, 3, { transparent: false, color: new THREE.Color(0.5, 0.48, 0.52) });
  } else {
    plane(170, 64, skyTexture(), -60, 4, { transparent: false });
    ridges.push(
      plane(170, 60, ridgeTexture(3, "#8fa9cf", "#e8c08e", 26, false), -42, -13),
      plane(130, 50, ridgeTexture(11, "#4f7d93", "#c99a6e", 34, true), -30, -13),
    );
  }
  const forest = art?.texture("layer-forest");
  ridges.push(
    forest
      ? plane(78, 78 / art!.aspect("layer-forest"), forest, -22, -7, { color: new THREE.Color(0.75, 0.75, 0.78) })
      : plane(95, 38, ridgeTexture(21, "#24485a", "#6d5a52", 40, true), -19, -12.5),
  );
  const foliage = art?.texture("layer-foliage");
  if (foliage) ridges.push(plane(46, 46 / art!.aspect("layer-foliage"), foliage, -3, -4.5));

  // --- Light shafts --------------------------------------------------------
  const shaftTex = lightShaftTexture();
  const shafts = [-9, -3, 4, 11].map((x, i) => {
    const mesh = plane(5 + i * 1.5, 46, shaftTex, -10 - i, 6, {
      blending: THREE.AdditiveBlending,
      opacity: 0.1,
      color: new THREE.Color("#ffd8a8"),
    });
    mesh.position.x = x;
    mesh.rotation.z = 0.32;
    return mesh;
  });

  // --- Pollen --------------------------------------------------------------
  const count = matchMedia("(pointer: coarse)").matches ? 140 : 260;
  const rand = mulberry32(42);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set([(rand() - 0.5) * 44, (rand() - 0.5) * 28, -14 + rand() * 20], i * 3);
    seeds[i] = rand() * 100;
  }
  const pollenGeo = new THREE.BufferGeometry();
  pollenGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const pollen = new THREE.Points(
    pollenGeo,
    new THREE.PointsMaterial({
      map: softDotTexture(),
      color: "#ffe2a8",
      size: 0.22,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  root.add(pollen);

  // --- Falling leaves (painted sprite, only when the art exists) ----------------
  const leafTex = art?.texture("leaf");
  const leafCount = leafTex ? 36 : 0;
  const leafGeo = new THREE.BufferGeometry();
  const leafPos = new Float32Array(leafCount * 3);
  for (let i = 0; i < leafCount; i++) leafPos.set([(rand() - 0.5) * 34, (rand() - 0.5) * 22, -6 + rand() * 9], i * 3);
  leafGeo.setAttribute("position", new THREE.BufferAttribute(leafPos, 3));
  if (leafTex) {
    root.add(
      new THREE.Points(
        leafGeo,
        new THREE.PointsMaterial({ map: leafTex, size: 0.5, transparent: true, alphaTest: 0.25, depthWrite: false, fog: false }),
      ),
    );
  }

  // --- Lights --------------------------------------------------------------
  scene.add(new THREE.HemisphereLight("#ffe1bf", "#5a4870", 1.4));
  const key = new THREE.DirectionalLight("#ffd7a3", 2.6);
  key.position.set(6, 9, 8);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#9fb4ff", 0.5);
  fill.position.set(-8, -2, 5);
  scene.add(fill);

  scene.fog = new THREE.Fog("#e9b98a", 34, 90);

  stage.onUpdate((dt, t) => {
    const attr = pollenGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const s = seeds[i];
      let y = attr.getY(i) + dt * (0.25 + (s % 1) * 0.35);
      if (y > 14) y = -14;
      attr.setY(i, y);
      attr.setX(i, attr.getX(i) + Math.sin(t * 0.5 + s) * dt * 0.25);
    }
    attr.needsUpdate = true;
    for (let i = 0; i < leafCount; i++) {
      let y = leafPos[i * 3 + 1] - dt * (0.6 + (i % 5) * 0.12);
      if (y < -12) y = 12;
      leafPos[i * 3 + 1] = y;
      leafPos[i * 3] += Math.sin(t * 1.3 + i * 2.1) * dt * 0.9;
    }
    if (leafCount) leafGeo.getAttribute("position").needsUpdate = true;
    shafts.forEach((m, i) => {
      (m.material as THREE.MeshBasicMaterial).opacity = 0.05 + 0.06 * (0.5 + 0.5 * Math.sin(t * 0.4 + i * 1.7));
    });
    // Very slow drift on the ridges sells the depth.
    ridges.forEach((m, i) => (m.position.x = Math.sin(t * 0.05 + i) * (0.6 - i * 0.15)));
  });

  return { root, keyLight: key };
}
