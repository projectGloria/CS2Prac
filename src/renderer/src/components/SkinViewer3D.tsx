// 3D skin editor (Phase 14): the weapon's own model from the local CS2 install, stickers drawn where the game puts
// them (its sticker UV set, TEXCOORD_1) and a charm marker. Drag on the model to move the picked sticker or the charm;
// the result is saved to the loadout (and pushed to the server) when the drag ends. The finish is an
// approximation from the paint kit's material (pattern, colours, placement; no wear or masks): inspect in game (F).
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RotateCcw } from 'lucide-react'
import {
  anchorFor,
  bodyMesh,
  charmOffset,
  clampToRegion,
  defaultCharmPoint,
  gltfToSource,
  sourceToGltf,
  stickerSlots,
  stickerUv,
  uvToStickerOffset,
  type ModelMarkup,
  type PaintMarkup
} from '@shared/models'
import type { KeychainSel, StickerSel } from '@shared/skins'

const SLOTS = 5
type Target = { kind: 'sticker'; slot: number } | { kind: 'charm' }

const VERTEX = /* glsl */ `
attribute vec2 stUv;
varying vec2 vUv;
varying vec2 vSt;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vUv = uv;
  vSt = stUv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`

const stickerBlock = (i: number) => `
  {
    vec4 r = stRect[${i}];
    float c = cos(r.w), s = sin(r.w);
    vec2 d = vSt - r.xy;
    vec2 st = vec2((d.x * c + d.y * s) / r.z + 0.5, (-d.x * s + d.y * c) / r.z + 0.5);
    if (stOn[${i}] > 0.5 && st.x >= 0.0 && st.x <= 1.0 && st.y >= 0.0 && st.y <= 1.0) {
      vec4 t = texture2D(stTex${i}, st);
      col = mix(col, t.rgb, t.a * (1.0 - 0.85 * stWear[${i}]));
      float e = min(min(st.x, 1.0 - st.x), min(st.y, 1.0 - st.y));
      if (stSel > ${i - 0.5} && stSel < ${i + 0.5} && e < 0.03) col = mix(col, vec3(1.0, 0.72, 0.2), 0.9);
    }
  }`

// The finish: an approximation of csgo_customweapon. Custom/gunsmith patterns are the weapon's albedo in uv0; the
// other styles tile a mask whose r/g/b pick colours 1–3 over colour 0. Wear and the game's per-part masks are left out.
const PAINT = /* glsl */ `
vec3 paintColour(vec3 base) {
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  // keep some of the weapon's own shading (ambient occlusion, edges) under the paint
  float detail = baseDetail > 0.5 ? clamp(0.55 + lum * 0.9, 0.55, 1.15) : 1.0;
  if (paintStyle > 5.5 && paintStyle < 6.5 || paintStyle > 7.5) {
    vec4 p = texture2D(patMap, vUv);
    return p.rgb * detail;
  }
  float c = cos(patXform.y), s = sin(patXform.y);
  vec2 d = vUv - 0.5;
  vec2 puv = vec2(d.x * c - d.y * s, d.x * s + d.y * c) * patXform.x + 0.5 + patXform.zw;
  vec4 p = hasPattern > 0.5 ? texture2D(patMap, puv) : vec4(0.0);
  if (paintStyle > 6.5) return clamp(p.rgb * paintBright, 0.0, 1.0) * detail;
  vec3 col = paintCol[0];
  col = mix(col, paintCol[1], p.r);
  col = mix(col, paintCol[2], p.g);
  col = mix(col, paintCol[3], p.b);
  return clamp(col * paintBright, 0.0, 1.0) * detail;
}`

const FRAGMENT = /* glsl */ `
uniform sampler2D baseMap;
uniform float hasBase;
uniform sampler2D patMap;
uniform float paintOn;
uniform float paintStyle;
uniform float hasPattern;
uniform float baseDetail;
uniform float paintBright;
uniform vec3 paintCol[4];
uniform vec4 patXform;
${Array.from({ length: SLOTS }, (_, i) => `uniform sampler2D stTex${i};`).join('\n')}
uniform vec4 stRect[${SLOTS}];
uniform float stOn[${SLOTS}];
uniform float stWear[${SLOTS}];
uniform float stSel;
varying vec2 vUv;
varying vec2 vSt;
varying vec3 vN;
varying vec3 vPos;
${PAINT}
void main() {
  vec3 col = hasBase > 0.5 ? texture2D(baseMap, vUv).rgb : vec3(0.42);
  if (paintOn > 0.5) col = paintColour(baseDetail > 0.5 ? col : vec3(0.5));
  ${Array.from({ length: SLOTS }, (_, i) => stickerBlock(i)).join('\n')}
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(-vPos);
  vec3 key = normalize(vec3(0.4, 0.7, 0.6));
  vec3 fill = normalize(vec3(-0.6, 0.1, 0.4));
  float light = 0.32 + 0.7 * max(dot(n, key), 0.0) + 0.25 * max(dot(n, fill), 0.0);
  float spec = pow(max(dot(n, normalize(key + v)), 0.0), 40.0) * 0.25;
  gl_FragColor = vec4(col * light + spec, 1.0);
}`

interface Scene {
  markup: ModelMarkup
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  material: THREE.ShaderMaterial
  meshes: THREE.Mesh[]
  charm: THREE.Sprite
  home: { pos: THREE.Vector3; target: THREE.Vector3 }
  dispose: () => void
}

export default function SkinViewer3D(props: {
  className: string
  legacy: boolean
  /** the picked finish (0 = default) */
  paintKit: number
  stickers: (StickerSel | null)[]
  keychain: KeychainSel | null
  stickerImage: (defIndex: number) => string | undefined
  keychainImage: (defIndex: number) => string | undefined
  onSticker: (slot: number, s: StickerSel) => void
  onKeychain: (k: KeychainSel) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<Scene | null>(null)
  const [status, setStatus] = useState<{ loading: boolean; error?: string }>({ loading: true })
  const [target, setTarget] = useState<Target | null>(null)
  const [, setReady] = useState(0)
  // a drag in progress: shown live, saved on release
  const live = useRef<{ slot: number; x: number; y: number } | { charm: [number, number, number] } | null>(null)
  const textures = useRef(new Map<string, THREE.Texture | 'loading'>())
  const propsRef = useRef(props)
  propsRef.current = props
  const targetRef = useRef(target)
  targetRef.current = target

  // ---------- scene (per weapon) ----------
  useEffect(() => {
    const el = host.current
    if (!el) return
    let cancelled = false
    setStatus({ loading: true })
    window.api.models.get(props.className).then(
      async (res) => {
        if (cancelled) return
        if (!res.ok) return setStatus({ loading: false, error: res.error })
        try {
          const s = await buildScene(el, res.model.markup, res.model.glb, res.model.texture)
          if (cancelled) return s.dispose()
          scene.current = s
          setStatus({ loading: false })
          setReady((n) => n + 1)
        } catch (e) {
          if (!cancelled) setStatus({ loading: false, error: e instanceof Error ? e.message : String(e) })
        }
      },
      (e) => !cancelled && setStatus({ loading: false, error: String(e) })
    )
    return () => {
      cancelled = true
      scene.current?.dispose()
      scene.current = null
    }
  }, [props.className])

  // ---------- the finish (per paint kit) ----------
  const [finish, setFinish] = useState<{ paintKit: number; paint: PaintMarkup; texture: THREE.Texture | null } | null>(null)
  const [finishNote, setFinishNote] = useState<string | null>(null)
  useEffect(() => {
    const kit = props.paintKit
    setFinishNote(null)
    if (!(kit > 0)) return setFinish(null)
    let cancelled = false
    let tex: THREE.Texture | null = null
    setFinishNote('Loading the finish…')
    window.api.models.paint(kit).then(
      async (res) => {
        if (cancelled) return
        if (!res.ok) return setFinishNote(`Finish not shown: ${res.error}`)
        if (res.pattern) {
          tex = await new THREE.TextureLoader().loadAsync(res.pattern).catch(() => null)
          if (cancelled) return tex?.dispose()
          if (tex) {
            tex.flipY = false
            tex.colorSpace = THREE.NoColorSpace
            tex.anisotropy = 8
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping
          }
        }
        setFinish({ paintKit: kit, paint: res.paint, texture: tex })
        setFinishNote(null)
      },
      (e) => !cancelled && setFinishNote(`Finish not shown: ${String(e)}`)
    )
    return () => {
      cancelled = true
      tex?.dispose()
    }
  }, [props.paintKit])

  // ---------- textures for stickers / charm ----------
  const texture = (url: string | undefined): THREE.Texture | null => {
    if (!url) return null
    const t = textures.current.get(url)
    if (t && t !== 'loading') return t
    if (!t) {
      textures.current.set(url, 'loading')
      window.api.models.image(url).then((data) => {
        if (!data) return textures.current.delete(url)
        new THREE.TextureLoader().load(data, (tex) => {
          tex.flipY = false
          tex.colorSpace = THREE.NoColorSpace
          tex.anisotropy = 4
          textures.current.set(url, tex)
          setReady((n) => n + 1)
        })
      })
    }
    return null
  }

  // ---------- uniforms / visibility from the selection ----------
  const s = scene.current
  if (s) {
    const body = bodyMesh(s.markup, props.legacy)
    for (const m of s.meshes) m.visible = (m.userData.body as string) === body
    const u = s.material.uniforms
    const f = finish?.paintKit === props.paintKit ? finish : null
    u.paintOn.value = f ? 1 : 0
    if (f) {
      const p = f.paint
      u.paintStyle.value = p.style
      u.hasPattern.value = f.texture ? 1 : 0
      u.patMap.value = f.texture ?? u.patMap.value
      // the HD body's colour map only lines up with the HD body
      u.baseDetail.value = u.hasBase.value > 0.5 && !props.legacy ? 1 : 0
      u.paintBright.value = p.brightness || 1
      p.colors.forEach((c, i) => (u.paintCol.value[i] as THREE.Vector3).set(c[0], c[1], c[2]))
      ;(u.patXform.value as THREE.Vector4).set(p.scale || 1, (p.rotation * Math.PI) / 180, p.offset[0], p.offset[1])
    }
    for (let i = 0; i < SLOTS; i++) {
      const st = props.stickers[i]
      const anchor = st ? anchorFor(s.markup, body, i) : null
      const tex = st ? texture(propsRef.current.stickerImage(st.defIndex)) : null
      const l = live.current
      const pos = l && 'slot' in l && l.slot === i ? { x: l.x, y: l.y } : st
      if (!st || !anchor || !tex || !pos) {
        u.stOn.value[i] = 0
        continue
      }
      const uv = stickerUv(anchor, { ...st, x: pos.x, y: pos.y })
      u.stOn.value[i] = 1
      ;(u.stRect.value[i] as THREE.Vector4).set(uv.u, uv.v, uv.size, uv.rot)
      u.stWear.value[i] = st.wear
      u[`stTex${i}`].value = tex
    }
    u.stSel.value = target?.kind === 'sticker' ? target.slot : -1
    const k = props.keychain
    const l = live.current
    const point =
      l && 'charm' in l ? l.charm : k && (k.x || k.y || k.z) ? ([k.x, k.y, k.z] as [number, number, number]) : k ? defaultCharmPoint(s.markup, body) : null
    const charmTex = k ? texture(props.keychainImage(k.defIndex)) : null
    s.charm.visible = !!point && !!charmTex
    if (point && charmTex) {
      s.charm.position.set(...sourceToGltf(...point))
      if (s.charm.material.map !== charmTex) {
        s.charm.material.map = charmTex
        s.charm.material.needsUpdate = true
      }
      s.charm.material.color.set(target?.kind === 'charm' ? 0xffd27a : 0xffffff)
    }
  }

  // ---------- dragging ----------
  useEffect(() => {
    const el = host.current
    if (!el) return
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let dragging = false
    const hitAt = (e: PointerEvent) => {
      const sc = scene.current
      if (!sc) return null
      const r = sc.renderer.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, sc.camera)
      return ray.intersectObjects(sc.meshes.filter((m) => m.visible), false)[0] ?? null
    }
    const place = (e: PointerEvent) => {
      const sc = scene.current
      const t = targetRef.current
      const hit = hitAt(e)
      if (!sc || !t || !hit) return false
      const p = propsRef.current
      if (t.kind === 'sticker') {
        const uv1 = (hit as { uv1?: THREE.Vector2; uv2?: THREE.Vector2 }).uv1 ?? (hit as { uv2?: THREE.Vector2 }).uv2
        const anchor = anchorFor(sc.markup, bodyMesh(sc.markup, p.legacy), t.slot)
        if (!uv1 || !anchor || !p.stickers[t.slot]) return false
        const off = uvToStickerOffset(anchor, uv1.x, uv1.y)
        const [cx, cy] = clampToRegion(anchor, anchor.offset[0] + off.x, anchor.offset[1] + off.y)
        const r4 = (n: number) => Math.round(n * 10000) / 10000
        live.current = { slot: t.slot, x: r4(cx - anchor.offset[0]), y: r4(cy - anchor.offset[1]) }
      } else {
        if (!p.keychain) return false
        // hang it just off the surface along the normal
        const n = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3()
        const at = hit.point.clone().addScaledVector(n, 0.004)
        live.current = { charm: gltfToSource(at.x, at.y, at.z) }
      }
      setReady((x) => x + 1)
      return true
    }
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !targetRef.current || !scene.current) return
      if (place(e)) {
        dragging = true
        scene.current.controls.enabled = false
        el.setPointerCapture(e.pointerId)
      }
    }
    const move = (e: PointerEvent) => {
      if (dragging) place(e)
    }
    const up = () => {
      if (!dragging) return
      dragging = false
      if (scene.current) scene.current.controls.enabled = true
      const l = live.current
      const p = propsRef.current
      live.current = null
      if (l && 'slot' in l) {
        const st = p.stickers[l.slot]
        if (st) p.onSticker(l.slot, { ...st, x: l.x, y: l.y })
      } else if (l && p.keychain) p.onKeychain({ ...p.keychain, ...charmOffset(l.charm) })
      setReady((x) => x + 1)
    }
    // capture phase, so OrbitControls (on the canvas) sees enabled = false for a drag on the model
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [])

  const markup = scene.current?.markup
  const body = markup ? bodyMesh(markup, props.legacy) : 'body_hd'
  const slotCount = markup ? stickerSlots(markup, body) : 0
  // drop a pick that no longer exists
  useEffect(() => {
    if (target?.kind === 'sticker' && !props.stickers[target.slot]) setTarget(null)
    if (target?.kind === 'charm' && !props.keychain) setTarget(null)
  }, [props.stickers, props.keychain, target])

  const resetView = () => {
    const sc = scene.current
    if (!sc) return
    sc.camera.position.copy(sc.home.pos)
    sc.controls.target.copy(sc.home.target)
    sc.controls.update()
  }
  const resetTarget = () => {
    if (target?.kind === 'sticker') {
      const st = props.stickers[target.slot]
      if (st) props.onSticker(target.slot, { ...st, x: 0, y: 0 })
    } else if (target?.kind === 'charm' && props.keychain) props.onKeychain({ ...props.keychain, x: 0, y: 0, z: 0 })
  }

  return (
    <div className="viewer3d">
      <div className="viewer3d-canvas" ref={host}>
        {status.loading && <div className="viewer3d-note muted small">Loading the model from your CS2 files… (the first time takes a few seconds)</div>}
        {status.error && <div className="viewer3d-note error-text">{status.error}</div>}
      </div>
      <div className="viewer3d-bar">
        <span className="muted small">Move:</span>
        {Array.from({ length: SLOTS }, (_, i) =>
          props.stickers[i] ? (
            <button
              key={i}
              className={target?.kind === 'sticker' && target.slot === i ? 'chip picked' : 'chip'}
              onClick={() => setTarget(target?.kind === 'sticker' && target.slot === i ? null : { kind: 'sticker', slot: i })}
              title={i >= slotCount && markup ? 'This weapon has fewer slots; the game uses its first slot for this one' : 'Drag on the model to move it'}
            >
              Sticker {i + 1}
            </button>
          ) : null
        )}
        {props.keychain && (
          <button
            className={target?.kind === 'charm' ? 'chip picked' : 'chip'}
            onClick={() => setTarget(target?.kind === 'charm' ? null : { kind: 'charm' })}
            title="Drag on the model to move it"
          >
            Charm
          </button>
        )}
        {target && (
          <button className="link small" onClick={resetTarget}>
            Default spot
          </button>
        )}
        <span className="spacer" />
        <button className="icon-btn" title="Reset view" onClick={resetView}>
          <RotateCcw size={14} aria-hidden />
        </button>
      </div>
      <p className="muted small viewer3d-hint">
        {target ? 'Drag on the weapon to place it; drag elsewhere to turn, wheel to zoom.' : 'Drag to turn, wheel to zoom. Pick a sticker or the charm above to move it.'}{' '}
        {finishNote ?? (props.paintKit > 0 ? 'The finish is an approximation (no wear): inspect it in game (F) for the exact look.' : '')}
      </p>
    </div>
  )
}

async function buildScene(el: HTMLDivElement, markup: ModelMarkup, glb: Uint8Array, textureUrl: string | null): Promise<Scene> {
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer
  const gltf = await new GLTFLoader().parseAsync(buffer, '')
  const baseMap = textureUrl ? await new THREE.TextureLoader().loadAsync(textureUrl) : null
  if (baseMap) {
    baseMap.flipY = false
    baseMap.colorSpace = THREE.NoColorSpace
    baseMap.anisotropy = 8
    baseMap.wrapS = baseMap.wrapT = THREE.RepeatWrapping
  }
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
  blank.needsUpdate = true
  const uniforms: Record<string, THREE.IUniform> = {
    baseMap: { value: baseMap ?? blank },
    hasBase: { value: baseMap ? 1 : 0 },
    patMap: { value: blank },
    paintOn: { value: 0 },
    paintStyle: { value: 0 },
    hasPattern: { value: 0 },
    baseDetail: { value: 0 },
    paintBright: { value: 1 },
    paintCol: { value: Array.from({ length: 4 }, () => new THREE.Vector3()) },
    patXform: { value: new THREE.Vector4(1, 0, 0, 0) },
    stRect: { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) },
    stOn: { value: new Array(SLOTS).fill(0) },
    stWear: { value: new Array(SLOTS).fill(0) },
    stSel: { value: -1 }
  }
  for (let i = 0; i < SLOTS; i++) uniforms[`stTex${i}`] = { value: blank }
  const material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, side: THREE.DoubleSide })

  const meshes: THREE.Mesh[] = []
  gltf.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    // three.js strips the dots from node names and appends _1, _2 … per primitive: match the markup's body names,
    // longest first (body_legacy before a hypothetical body)
    const bodies = [...markup.meshes].sort((a, b) => b.length - a.length)
    let name = ''
    for (let p: THREE.Object3D | null = o; p && !name; p = p.parent) name = bodies.find((b) => p!.name.includes(b)) ?? ''
    const g = o.geometry as THREE.BufferGeometry
    const st = g.getAttribute('uv1') ?? g.getAttribute('uv2') ?? g.getAttribute('uv')
    if (st) g.setAttribute('stUv', st)
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
    o.material = material
    o.userData.body = name || markup.meshes[0]
    meshes.push(o)
  })

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x14171d)
  scene.add(gltf.scene)
  const charm = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }))
  charm.center.set(0.5, 1)
  charm.renderOrder = 10
  charm.visible = false
  scene.add(charm)

  // frame the body the weapon is shown with (both bodies are about the same size)
  const box = new THREE.Box3()
  for (const m of meshes) if (m.userData.body === bodyMesh(markup, false)) box.expandByObject(m)
  if (box.isEmpty()) box.setFromObject(gltf.scene)
  const centre = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3()).length()
  charm.scale.set(size * 0.07, size * 0.07, 1)

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)
  const camera = new THREE.PerspectiveCamera(30, 1, size / 100, size * 20)
  // the weapon's left side (Source +y = glTF +x), where the stickers are
  const home = { pos: centre.clone().add(new THREE.Vector3(size * 1.15, size * 0.1, 0)), target: centre.clone() }
  camera.position.copy(home.pos)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(centre)
  controls.enableDamping = true
  controls.minDistance = size * 0.2
  controls.maxDistance = size * 6
  controls.update()

  const resize = () => {
    const w = el.clientWidth || 1
    const h = el.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(el)
  let frame = 0
  const loop = () => {
    controls.update()
    renderer.render(scene, camera)
    frame = requestAnimationFrame(loop)
  }
  loop()

  return {
    markup,
    renderer,
    camera,
    controls,
    material,
    meshes,
    charm,
    home,
    dispose: () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      for (const m of meshes) m.geometry.dispose()
      material.dispose()
      baseMap?.dispose()
      blank.dispose()
      charm.material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }
}
