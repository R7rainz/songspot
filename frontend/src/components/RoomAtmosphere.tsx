import { useEffect, useRef } from "react";
import type {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  PerspectiveCamera,
  Points,
  WebGLRenderer,
} from "three";

interface Props {
  playing: boolean;
}

type ThreeModule = typeof import("three");

interface Bar {
  mesh: Mesh;
  base: number;
  phase: number;
}

function mountScene(
  host: HTMLDivElement,
  THREE: ThreeModule,
  playingRef: React.MutableRefObject<boolean>,
) {
  let renderer: WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    host.dataset.webgl = "unavailable";
    return () => {};
  }

  host.dataset.webgl = "ready";
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "room-atmosphere__canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0, 4.8, 9.5);
  camera.lookAt(0, -1.15, 0);

  const root: Group = new THREE.Group();
  root.rotation.y = -0.08;
  scene.add(root);

  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];

  const grid = new THREE.GridHelper(22, 30, 0x665c54, 0x3c3836);
  const gridMaterials = Array.isArray(grid.material)
    ? grid.material
    : [grid.material];
  for (const material of gridMaterials) {
    material.transparent = true;
    material.opacity = 0.2;
    material.depthWrite = false;
    materials.push(material);
  }
  grid.position.y = -2.2;
  root.add(grid);

  const barGeometry = new THREE.BoxGeometry(0.24, 1, 0.24);
  geometries.push(barGeometry);
  const palette = [0xfabd2f, 0xfe8019, 0x8ec07c];
  const barMaterials = palette.map((color) => {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
    });
    materials.push(material);
    return material;
  });

  const bars: Bar[] = [];
  for (let i = 0; i < 31; i += 1) {
    const base = 0.45 + ((i * 17) % 9) * 0.09;
    const mesh = new THREE.Mesh(
      barGeometry,
      barMaterials[i % barMaterials.length],
    );
    mesh.position.x = (i - 15) * 0.56;
    mesh.position.z = -1.7 + Math.sin(i * 0.58) * 1.35;
    mesh.scale.y = base;
    mesh.position.y = -2.2 + base / 2;
    root.add(mesh);
    bars.push({ mesh, base, phase: i * 0.67 });
  }

  const ringGeometry = new THREE.TorusGeometry(3.8, 0.035, 8, 128);
  geometries.push(ringGeometry);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xfabd2f,
    transparent: true,
    opacity: 0.18,
  });
  materials.push(ringMaterial);
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(3.2, -2.12, -0.8);
  root.add(ring);

  const innerRing = new THREE.Mesh(ringGeometry, ringMaterial.clone());
  materials.push(innerRing.material);
  innerRing.scale.setScalar(0.72);
  innerRing.rotation.x = Math.PI / 2;
  innerRing.position.copy(ring.position);
  root.add(innerRing);

  const particleGeometry = new THREE.BufferGeometry();
  geometries.push(particleGeometry);
  const particlePositions = new Float32Array(90 * 3);
  for (let i = 0; i < 90; i += 1) {
    particlePositions[i * 3] = ((i * 47) % 100) / 6 - 8.3;
    particlePositions[i * 3 + 1] = ((i * 29) % 60) / 10 - 2;
    particlePositions[i * 3 + 2] = ((i * 71) % 100) / 10 - 5;
  }
  particleGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(particlePositions, 3),
  );
  const particleMaterial = new THREE.PointsMaterial({
    color: 0xebdbb2,
    size: 0.035,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  materials.push(particleMaterial);
  const particles: Points = new THREE.Points(
    particleGeometry,
    particleMaterial,
  );
  root.add(particles);

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  let pointerX = 0;
  let pointerY = 0;
  let frame = 0;
  let stopped = false;
  let pixelsChecked = false;
  const startedAt = performance.now();

  const resize = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const onPointerMove = (event: PointerEvent) => {
    pointerX = (event.clientX / window.innerWidth - 0.5) * 2;
    pointerY = (event.clientY / window.innerHeight - 0.5) * 2;
  };

  const draw = (now: number) => {
    if (stopped) return;
    const time = (now - startedAt) / 1000;
    const active = playingRef.current;
    const amplitude = active ? 0.78 : 0.16;
    const speed = active ? 2.1 : 0.42;

    for (const { mesh, base, phase } of bars) {
      const pulse = 1 + Math.sin(time * speed + phase) * amplitude;
      const height = Math.max(0.22, base * pulse);
      mesh.scale.y = height;
      mesh.position.y = -2.2 + height / 2;
    }

    ring.rotation.z = time * (active ? 0.12 : 0.035);
    innerRing.rotation.z = -time * (active ? 0.08 : 0.02);
    particles.rotation.y = time * 0.008;

    if (!reducedMotion) {
      camera.position.x += (pointerX * 0.35 - camera.position.x) * 0.025;
      camera.position.y +=
        (4.8 - pointerY * 0.18 - camera.position.y) * 0.025;
      camera.lookAt(0, -1.15, 0);
    }

    renderer.render(scene, camera);
    if (!pixelsChecked) {
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      const width = renderer.domElement.width;
      const height = renderer.domElement.height;
      let nonBlank = 0;
      let samples = 0;
      for (let y = 1; y < 10; y += 1) {
        for (let x = 1; x < 10; x += 1) {
          gl.readPixels(
            Math.floor((width * x) / 10),
            Math.floor((height * y) / 10),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixel,
          );
          if (pixel[3] > 0 || pixel[0] + pixel[1] + pixel[2] > 0) nonBlank += 1;
          samples += 1;
        }
      }
      host.dataset.canvasPixels = `${nonBlank}/${samples}`;
      pixelsChecked = true;
    }
    if (!reducedMotion) frame = requestAnimationFrame(draw);
  };

  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  if (!reducedMotion) window.addEventListener("pointermove", onPointerMove);
  draw(performance.now());

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    window.removeEventListener("pointermove", onPointerMove);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}

export function RoomAtmosphere({ playing }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import("three")
      .then((THREE) => {
        if (!cancelled) cleanup = mountScene(host, THREE, playingRef);
      })
      .catch(() => {
        host.dataset.webgl = "unavailable";
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return <div ref={hostRef} className="room-atmosphere" aria-hidden="true" />;
}
