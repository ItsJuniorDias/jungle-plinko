/**
 * Loads the AI-painted art listed in public/art/manifest.json (written by
 * `npm run art`). Every entry is optional: games fall back to procedural
 * placeholders for anything missing, so the prototype runs with or without art.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type ArtName =
  | "background"
  | "layer-forest"
  | "layer-foliage"
  | "board"
  | "ball"
  | "peg"
  | "bucket"
  | "leaf"
  | "logo"
  | "cover";

/** AI-generated 3D props (Hyper3D Rodin → Blender cleanup), listed in public/models/manifest.json. */
export type ModelName = "ball" | "bucket" | "peg" | "mascot";

export interface ArtEntry {
  file: string;
  width: number;
  height: number;
}

export interface Art {
  texture(name: ArtName): THREE.Texture | undefined;
  /** Width / height of the image, for sizing planes. */
  aspect(name: ArtName): number;
  url(name: ArtName): string | undefined;
  /** A fresh clone of a 3D prop (geometry and materials are shared with the original). */
  model(name: ModelName): THREE.Object3D | undefined;
}

export async function loadArt(): Promise<Art> {
  // 2D art and 3D models download in parallel.
  const modelsReady = loadModels();
  let manifest: Partial<Record<ArtName, ArtEntry>> = {};
  try {
    const res = await fetch("/art/manifest.json", { cache: "no-cache" });
    if (res.ok) manifest = await res.json();
  } catch {
    /* no art yet */
  }

  const loader = new THREE.TextureLoader();
  const textures = new Map<ArtName, THREE.Texture>();
  await Promise.all(
    (Object.entries(manifest) as [ArtName, ArtEntry][]).map(async ([name, entry]) => {
      try {
        const tex = await loader.loadAsync(`/art/${entry.file}`);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        textures.set(name, tex);
      } catch {
        console.warn(`art: could not load ${entry.file}`);
      }
    }),
  );

  const models = await modelsReady;

  return {
    texture: (name) => textures.get(name),
    model: (name) => models.get(name)?.clone(true),
    aspect: (name) => (manifest[name] ? manifest[name]!.width / manifest[name]!.height : 1),
    url: (name) => (textures.has(name) ? `/art/${manifest[name]!.file}` : undefined),
  };
}

async function loadModels(): Promise<Map<ModelName, THREE.Object3D>> {
  const models = new Map<ModelName, THREE.Object3D>();
  try {
    const res = await fetch("/models/manifest.json", { cache: "no-cache" });
    const list: Partial<Record<ModelName, { file: string }>> = res.ok ? await res.json() : {};
    const gltf = new GLTFLoader();
    await Promise.all(
      (Object.entries(list) as [ModelName, { file: string }][]).map(async ([name, entry]) => {
        try {
          models.set(name, (await gltf.loadAsync(`/models/${entry.file}`)).scene);
        } catch {
          console.warn(`art: could not load model ${entry.file}`);
        }
      }),
    );
  } catch {
    /* no models yet */
  }
  return models;
}
