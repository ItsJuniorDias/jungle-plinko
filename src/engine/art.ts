/**
 * Loads the AI-painted art listed in public/art/manifest.json (written by
 * `npm run art`). Every entry is optional: games fall back to procedural
 * placeholders for anything missing, so the prototype runs with or without art.
 */
import * as THREE from "three";

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
}

export async function loadArt(): Promise<Art> {
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

  return {
    texture: (name) => textures.get(name),
    aspect: (name) => (manifest[name] ? manifest[name]!.width / manifest[name]!.height : 1),
    url: (name) => (textures.has(name) ? `/art/${manifest[name]!.file}` : undefined),
  };
}
