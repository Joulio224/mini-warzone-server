// ---------------------------------------------------------------------------
// Collisions précises sur les TRIANGLES RÉELS de map-colliders.glb.
//
// Avant : un THREE.Box3 par mesh. Un bâtiment avec des portes ou des fenêtres
// devenait un bloc plein, et les ouvertures étaient bouchées. Ici, tous les
// triangles de map-colliders.glb sont fusionnés dans UNE géométrie accélérée
// par un BVH (three-mesh-bvh) : chaque test (déplacement, tir, grenade, sol) ne
// regarde que les quelques triangles proches, donc c'est aussi rapide que les
// boîtes, voire plus.
//
// Ce fichier est IDENTIQUE côté client (src/collision-world.js) et côté serveur
// (collision-world.js) : garde les deux copies synchronisées.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

// Les faces dont la normale est plus verticale que ça (|ny| > 0,7, soit une
// pente de moins de ~45° par rapport à l'horizontale) sont des sols, des
// rampes ou des plafonds : on peut marcher dessus (le sol est géré par un
// rayon vers le bas), ce ne sont pas des murs.
const WALL_MAX_ABS_NY = 0.7;
const SKIN = 0.002; // petite marge pour ne pas rester exactement collé au mur

const _tmpBox = new THREE.Box3();
const _tmpSphere = new THREE.Sphere();
const _tmpNormal = new THREE.Vector3();
const _tmpPoint = new THREE.Vector3();
const _ray = new THREE.Ray();

// Distance (plan XZ) d'un point à un segment [ax,az]-[bx,bz]. Renvoie aussi le
// point le plus proche via `out`.
function pointSegmentDistXZ(px, pz, ax, az, bx, bz, out) {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = ax + abx * t;
  out.z = az + abz * t;
  return Math.hypot(px - out.x, pz - out.z);
}

// Découpe un polygone (tableau de [x,y,z]) pour ne garder que la tranche
// yMin <= y <= yMax (Sutherland-Hodgman).
function clipPolygonY(poly, yMin, yMax) {
  let out = poly;
  for (const [limit, keepAbove] of [[yMin, true], [yMax, false]]) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = keepAbove ? cur[1] >= limit : cur[1] <= limit;
      const prevIn = keepAbove ? prev[1] >= limit : prev[1] <= limit;
      if (curIn !== prevIn) {
        const t = (limit - prev[1]) / (cur[1] - prev[1]);
        out.push([
          prev[0] + (cur[0] - prev[0]) * t,
          limit,
          prev[2] + (cur[2] - prev[2]) * t,
        ]);
      }
      if (curIn) out.push(cur);
    }
    if (out.length === 0) return out;
  }
  return out;
}

function pointInPolygonXZ(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][2];
    const xj = poly[j][0], zj = poly[j][2];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Un mesh dont la hauteur totale est inférieure à ça est un décor posé au sol
// (motifs des zones de départ, 7 cm d'épaisseur) : on marche dessus, il ne
// bloque pas le déplacement (comme avant), mais il arrête quand même les tirs.
const FLAT_PLATE_MAX_THICKNESS = 0.2;

function assembleBVH(records) {
  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  for (const record of records) {
    for (let i = 0; i < record.positions.length; i++) positions.push(record.positions[i]);
    for (let i = 0; i < record.indices.length; i++) indices.push(vertexOffset + record.indices[i]);
    vertexOffset += record.positions.length / 3;
  }
  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(
    vertexOffset > 65535
      ? new THREE.Uint32BufferAttribute(indices, 1)
      : new THREE.Uint16BufferAttribute(indices, 1)
  );
  geometry.computeBoundingBox();
  return { geometry, bvh: new MeshBVH(geometry, { maxLeafTris: 8 }), triangleCount: indices.length / 3 };
}

/**
 * Fusionne tous les meshes de `root` (une scène GLTF) en géométries en
 * coordonnées monde et construit les BVH :
 *   - `bvh`     : tout (tirs, grenades, sol)
 *   - `walkBvh` : sans les décors plats (déplacement des joueurs)
 */
export function createCollisionWorld(root) {
  root.updateMatrixWorld(true);

  const records = [];
  let skippedMeshes = 0;
  const v = new THREE.Vector3();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const pos = child.geometry.getAttribute('position');
    if (!pos || pos.count === 0) return;

    child.updateWorldMatrix(true, false);
    const matrix = child.matrixWorld;
    const flip = matrix.determinant() < 0; // échelle négative : l'ordre des sommets s'inverse

    const positions = [];
    let minY = Infinity;
    let maxY = -Infinity;
    let valid = true;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
        valid = false;
        break;
      }
      positions.push(v.x, v.y, v.z);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    if (!valid) {
      skippedMeshes++;
      return;
    }

    const index = child.geometry.index;
    const count = index ? index.count : pos.count;
    const indices = [];
    for (let i = 0; i + 2 < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      if (flip) indices.push(a, c, b);
      else indices.push(a, b, c);
    }
    records.push({ positions, indices, thin: maxY - minY < FLAT_PLATE_MAX_THICKNESS });
  });

  const full = assembleBVH(records);
  if (!full) throw new Error('Aucun triangle exploitable dans le fichier de collisions.');
  const walk = assembleBVH(records.filter((r) => !r.thin)) || full;
  const { geometry, bvh, triangleCount } = full;
  const walkBvh = walk.bvh;
  const meshCount = records.length;

  // ------------------------------------------------------------------ murs
  // Pousse le cercle (x, z) de rayon `radius` hors de tout ce qui bloque
  // entre les hauteurs yMin et yMax. `pos` = { x, z } est modifié sur place.
  // Renvoie true si la position a dû être corrigée.
  function pushOutCylinder(pos, yMin, yMax, radius, iterations = 4) {
    let moved = false;
    const closest = { x: 0, z: 0 };

    for (let iter = 0; iter < iterations; iter++) {
      let pushedThisPass = false;
      _tmpBox.min.set(pos.x - radius, yMin, pos.z - radius);
      _tmpBox.max.set(pos.x + radius, yMax, pos.z + radius);

      walkBvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_tmpBox),
        intersectsTriangle: (tri) => {
          const minY = Math.min(tri.a.y, tri.b.y, tri.c.y);
          const maxY = Math.max(tri.a.y, tri.b.y, tri.c.y);
          if (maxY <= yMin || minY >= yMax) return false;

          tri.getNormal(_tmpNormal);
          if (!Number.isFinite(_tmpNormal.x) || Math.abs(_tmpNormal.y) > WALL_MAX_ABS_NY) return false;

          let poly = [
            [tri.a.x, tri.a.y, tri.a.z],
            [tri.b.x, tri.b.y, tri.b.z],
            [tri.c.x, tri.c.y, tri.c.z],
          ];
          if (minY < yMin || maxY > yMax) poly = clipPolygonY(poly, yMin, yMax);
          if (poly.length === 0) return false;

          // Point du polygone (projeté au sol) le plus proche du centre.
          let best = Infinity;
          for (let i = 0; i < poly.length; i++) {
            const p = poly[i];
            const q = poly[(i + 1) % poly.length];
            const d = pointSegmentDistXZ(pos.x, pos.z, p[0], p[2], q[0], q[2], closest);
            if (d < best) {
              best = d;
              _tmpPoint.set(closest.x, 0, closest.z);
            }
          }

          let dirX;
          let dirZ;
          let depth;
          if (best >= radius) {
            return false;
          } else if (best > 1e-6) {
            dirX = (pos.x - _tmpPoint.x) / best;
            dirZ = (pos.z - _tmpPoint.z) / best;
            depth = radius - best;
          } else {
            // Centre pile sur la face (face oblique) : on sort du côté où se trouve le joueur.
            const nLen = Math.hypot(_tmpNormal.x, _tmpNormal.z);
            if (nLen < 1e-6) return false;
            const yMid = (yMin + yMax) / 2;
            const side =
              _tmpNormal.x * (pos.x - tri.a.x) + _tmpNormal.y * (yMid - tri.a.y) + _tmpNormal.z * (pos.z - tri.a.z);
            const sign = side < 0 ? -1 : 1;
            dirX = (_tmpNormal.x / nLen) * sign;
            dirZ = (_tmpNormal.z / nLen) * sign;
            depth = radius;
          }
          pos.x += dirX * (depth + SKIN);
          pos.z += dirZ * (depth + SKIN);
          pushedThisPass = true;
          moved = true;
          return false; // on continue : un coin peut toucher plusieurs triangles
        },
      });

      if (!pushedThisPass) break;
    }
    return moved;
  }

  // Le cylindre (x, z, yMin..yMax, radius) touche-t-il un mur ?
  function collidesCylinder(x, z, yMin, yMax, radius) {
    const probe = { x, z };
    const tolerance = radius - 0.01; // les poussées laissent SKIN d'écart : pas de faux positif
    _tmpBox.min.set(x - radius, yMin, z - radius);
    _tmpBox.max.set(x + radius, yMax, z + radius);
    return walkBvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_tmpBox),
      intersectsTriangle: (tri) => {
        const minY = Math.min(tri.a.y, tri.b.y, tri.c.y);
        const maxY = Math.max(tri.a.y, tri.b.y, tri.c.y);
        if (maxY <= yMin || minY >= yMax) return false;
        tri.getNormal(_tmpNormal);
        if (!Number.isFinite(_tmpNormal.x) || Math.abs(_tmpNormal.y) > WALL_MAX_ABS_NY) return false;
        let poly = [
          [tri.a.x, tri.a.y, tri.a.z],
          [tri.b.x, tri.b.y, tri.b.z],
          [tri.c.x, tri.c.y, tri.c.z],
        ];
        if (minY < yMin || maxY > yMax) poly = clipPolygonY(poly, yMin, yMax);
        if (poly.length === 0) return false;
        const closest = { x: 0, z: 0 };
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i];
          const q = poly[(i + 1) % poly.length];
          if (pointSegmentDistXZ(probe.x, probe.z, p[0], p[2], q[0], q[2], closest) < tolerance) return true;
        }
        return pointInPolygonXZ(probe.x, probe.z, poly) && poly.length >= 3;
      },
    });
  }

  // Déplace le cercle de (prevX, prevZ) vers (newX, newZ) en le faisant glisser
  // le long des murs. Le trajet est découpé en petits pas (au plus ~0,16 m) pour
  // qu'un mur fin ne puisse jamais être traversé, même après un à-coup de FPS.
  // Renvoie { x, z }.
  function slideMove(prevX, prevZ, newX, newZ, yMin, yMax, radius) {
    const dx = newX - prevX;
    const dz = newZ - prevZ;
    const dist = Math.hypot(dx, dz);
    const steps = Math.min(60, Math.max(1, Math.ceil(dist / (radius * 0.4))));
    const stepX = dx / steps;
    const stepZ = dz / steps;
    const pos = { x: prevX, z: prevZ };
    for (let i = 0; i < steps; i++) {
      // Chaque pas repart de la position DÉJÀ corrigée par le pas précédent.
      pos.x += stepX;
      pos.z += stepZ;
      pushOutCylinder(pos, yMin, yMax, radius);
    }
    // Coincé dans un angle impossible à résoudre : on reste où on était.
    if (collidesCylinder(pos.x, pos.z, yMin, yMax, radius) && !collidesCylinder(prevX, prevZ, yMin, yMax, radius)) {
      return { x: prevX, z: prevZ };
    }
    return pos;
  }

  // -------------------------------------------------------------- grenades
  function collidesSphere(x, y, z, radius) {
    _tmpSphere.center.set(x, y, z);
    _tmpSphere.radius = radius;
    const r2 = radius * radius;
    return bvh.shapecast({
      intersectsBounds: (box) => _tmpSphere.intersectsBox(box),
      intersectsTriangle: (tri) => {
        tri.closestPointToPoint(_tmpSphere.center, _tmpPoint);
        return _tmpPoint.distanceToSquared(_tmpSphere.center) < r2;
      },
    });
  }

  // ------------------------------------------------------------------ rayons
  // Premier triangle touché (dans les deux sens) : { distance, point, normal } ou null.
  function raycastFirst(ox, oy, oz, dx, dy, dz, maxDist = Infinity) {
    _ray.origin.set(ox, oy, oz);
    _ray.direction.set(dx, dy, dz);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
    if (!hit) return null;
    return {
      distance: hit.distance,
      point: hit.point.clone(),
      normal: hit.face ? new THREE.Vector3(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z) : null,
    };
  }

  // Distance jusqu'au premier obstacle (Infinity si aucun).
  function rayDistance(ox, oy, oz, dx, dy, dz, maxDist = Infinity) {
    const hit = raycastFirst(ox, oy, oz, dx, dy, dz, maxDist);
    return hit ? hit.distance : Infinity;
  }

  // Hauteur de la surface PORTANTE (face tournée vers le haut) située sous
  // (x, fromY, z), ou `fallback` s'il n'y en a pas.
  function groundHeightAt(x, fromY, z, fallback = 0) {
    _ray.origin.set(x, fromY, z);
    _ray.direction.set(0, -1, 0);
    const hits = bvh.raycast(_ray, THREE.DoubleSide, 0, Infinity);
    let bestDist = Infinity;
    let bestY = fallback;
    for (const hit of hits) {
      if (!hit.face || hit.face.normal.y <= 0.3) continue;
      if (hit.distance < bestDist) {
        bestDist = hit.distance;
        bestY = hit.point.y;
      }
    }
    return bestY;
  }

  return {
    bvh,
    geometry,
    boundingBox: geometry.boundingBox,
    meshCount,
    skippedMeshes,
    triangleCount,
    walkTriangleCount: walk.triangleCount,
    pushOutCylinder,
    slideMove,
    collidesCylinder,
    collidesSphere,
    raycastFirst,
    rayDistance,
    groundHeightAt,
  };
}
