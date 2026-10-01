/**
 * "Spring" look materials: soft toon banding (a painterly gradient ramp rather
 * than hard cel steps) plus a warm fresnel rim light, the signature edge glow of
 * Blender Studio's Spring. Swap these in for any GLB material via `springify()`.
 */
import * as THREE from "three";

let ramp: THREE.DataTexture | undefined;

/** Shared 4-tone ramp with linear filtering → soft, painted-looking light bands. */
function gradientRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const tones = [90, 150, 215, 255];
  ramp = new THREE.DataTexture(new Uint8Array(tones), tones.length, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.LinearFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

export interface SpringMaterialOptions {
  color: THREE.ColorRepresentation;
  rimColor?: THREE.ColorRepresentation;
  rimStrength?: number;
  rimPower?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
}

export function springMaterial(opts: SpringMaterialOptions): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({
    color: opts.color,
    gradientMap: gradientRamp(),
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    map: opts.map ?? null,
    normalMap: opts.normalMap ?? null,
  });
  addSpringRim(material, opts.rimColor ?? 0xffd9a0, opts.rimStrength ?? 0.6, opts.rimPower ?? 2.6);
  return material;
}

/**
 * Adds the warm fresnel rim to a lit material (toon or PBR). PBR surfaces that need
 * real relief (e.g. the carved board) still get the Spring edge glow this way.
 */
export function addSpringRim(
  material: THREE.MeshToonMaterial | THREE.MeshStandardMaterial,
  color: THREE.ColorRepresentation,
  strength: number,
  power: number,
) {
  const uniforms = {
    rimColor: { value: new THREE.Color(color) },
    rimStrength: { value: strength },
    rimPower: { value: power },
  };
  material.userData.rim = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;\nuniform float rimPower;",
      )
      .replace(
        "#include <opaque_fragment>",
        `float rimTerm = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), rimPower);
        outgoingLight += rimColor * rimTerm * rimStrength;
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "spring-rim";
}

/** Converts every mesh of an imported GLB to the Spring look, keeping its base colour and texture. */
export function springify(root: THREE.Object3D, rim?: Partial<SpringMaterialOptions>) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const material = springMaterial({
      color: src.color ?? 0xffffff,
      map: src.map,
      normalMap: src.normalMap,
      emissive: src.emissive,
      emissiveIntensity: src.emissiveIntensity,
      ...rim,
    });
    // glTF normal maps come with normalScale.y = -1 from GLTFLoader; keep that orientation.
    if (src.normalScale) material.normalScale.copy(src.normalScale);
    mesh.material = material;
  });
}
