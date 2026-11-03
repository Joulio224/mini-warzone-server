// ---------------------------------------------------------------------------
// Serveur temps réel Mini Warzone (Socket.io)
// ---------------------------------------------------------------------------
// Rôle : synchroniser les positions des joueurs, les tirs et la vie entre
// tous les clients connectés. Ne gère PAS les comptes/amis/groupes (ça,
// c'est Firebase, côté client) — ce serveur ne connaît que des sockets, des
// positions, des points de vie... et maintenant de l'argent et des achats
// (voir la section ÉCONOMIE ci-dessous).
//
// En dev : lance ce serveur séparément du client (`npm run dev` ici, dans un
// 2e terminal), pendant que le client tourne sur http://localhost:5173.
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Toutes les données de la map (collisions, spawns d'équipe, lumières
// d'ambiance) viennent de ce fichier
// — plus aucune géométrie de salle codée en dur ici. Doit rester identique
// à src/map-data.json côté client. La géométrie VISIBLE, elle, vient de
// map.glb (voir src/main.js) — ce fichier ne contient que ce que le rendu
// 3D ne peut pas déduire tout seul (boîtes de collision, points de jeu).
const mapData = JSON.parse(readFileSync(new URL('./map-data.json', import.meta.url)));

const PORT = process.env.PORT || 3001;

const MAX_HP = 100;
const HIT_RADIUS = 0.35; // rayon des hitbox du corps
const HEAD_HIT_RADIUS = 0.25; // correspond à la tête visible (sphère de rayon 0,25)
const HEADSHOT_MULTIPLIER = 2; // un headshot inflige deux fois les dégâts normaux
// Centres des hitbox du corps, relatifs à position.y (hauteur des yeux).
// La hitbox supérieure du corps s'arrête sous la tête pour qu'un tir dans
// la tête soit reconnu comme un headshot plutôt que comme un tir au corps.
const BODY_SAMPLE_OFFSETS = [-1.6, -1.1, -0.7]; // pieds -> haut du torse
const RESPAWN_DELAY_MS = 3000;

// Compensation de latence : un tir teste la position des AUTRES joueurs telle
// qu'elle était LAG_COMPENSATION_MS plus tôt, pas leur position toute
// fraîche. Sans ça, viser pile sur quelqu'un qui bouge (et surtout qui
// saute, où la hauteur change vite) rate systématiquement le tir : entre le
// moment où le tireur VOIT la cible à l'écran et le moment où le serveur
// reçoit le tir, la cible a déjà un peu bougé côté serveur — à cause à la
// fois de la fréquence d'envoi des positions (~20/s, voir MOVE_SEND_INTERVAL
// dans main.js) et du lissage visuel des autres joueurs côté client
// (mesh.position.lerp(...)). Valeur de départ raisonnable ; à ajuster après
// avoir testé en vrai (l'augmenter si ça rate encore, la baisser si ça
// touche des gens qui avaient déjà visiblement esquivé).
const LAG_COMPENSATION_MS = 150;
// Combien de temps d'historique de position on garde par joueur pour
// pouvoir "remonter dans le temps" — un peu plus que LAG_COMPENSATION_MS
// par sécurité (pic de latence, petit décalage d'horloge...).
const POSITION_HISTORY_MS = 400;

// Bouclier (gilets pare-balle) : le "stuff" contient des gilets en réserve
// (achetés en boutique), chacun ajouté au bouclier actif seulement quand le
// joueur choisit de l'utiliser (touche P) — pas automatiquement à l'achat.
// MAX_SHIELD_VESTS est le nombre de base (2) ; la capacité spéciale "3e
// emplacement de gilet" (voir ÉCONOMIE) le porte à 3 pour le joueur qui
// l'achète, jusqu'à la fin de la partie en cours. Doit rester identique à
// src/shop.js et src/main.js.
const SHIELD_PER_VEST = 25;
const MAX_SHIELD_VESTS = 2;

function shieldSteps(player) {
  return Math.min(player.maxVestSlots, Math.ceil(player.shield / SHIELD_PER_VEST));
}
function maxShieldFor(player) {
  return SHIELD_PER_VEST * player.maxVestSlots;
}

// Argent gagné à chaque élimination, affiché en haut de l'écran côté client.
// Ne se réinitialise jamais (ni à la mort, ni au respawn) — seule la
// boutique en dépense.
const KILL_REWARD = 50;

// ---------------------------------------------------------------------------
// ÉCONOMIE — rareté des armes + catalogue boutique + achats
// ---------------------------------------------------------------------------
// 3 paliers de rareté, du plus faible au plus fort. Chaque palier multiplie
// les dégâts de l'arme par 1.15 PAR RAPPORT AU PALIER PRÉCÉDENT (effet
// cumulatif, pas juste +15% par rapport au gris) :
//   gris  = ×1
//   bleu  = ×1.15
//   rouge = ×1.15² = ×1.3225 (~+32% par rapport au gris)
// Doit rester identique à RARITIES / RARITY_DAMAGE_STEP dans src/shop.js.
const RARITIES = ['gray', 'blue', 'red'];
const RARITY_DAMAGE_STEP = 1.15;
function rarityDamageMultiplier(rarity) {
  const index = RARITIES.indexOf(rarity);
  return RARITY_DAMAGE_STEP ** Math.max(0, index);
}

// Table des armes — dégâts (PAR PLOMB pour le fusil à pompe), cadence,
// chargeur, temps de rechargement, nombre de plombs et dispersion. Doit rester
// identique à WEAPON_DEFS dans src/weapons.js (côté client). Le serveur ne fait
// jamais confiance au client pour les dégâts, la cadence ou les munitions : le
// tir envoie juste un numéro de slot (+ les directions des plombs, dont la
// dispersion est plafonnée ici), le serveur regarde lui-même ce qui s'y trouve.
const WEAPON_DEFS = {
  pistol: { baseDamage: 18, cooldown: 0.35, magSize: 12, reloadTime: 1.2, pellets: 1, spread: { hip: 0.006, aim: 0.002 }, basePrice: 90, slot: 0 },
  smg: { baseDamage: 10, cooldown: 0.09, magSize: 30, reloadTime: 1.7, pellets: 1, spread: { hip: 0.022, aim: 0.009 }, basePrice: 80, slot: 1 },
  rifle: { baseDamage: 16, cooldown: 0.18, magSize: 25, reloadTime: 2.0, pellets: 1, spread: { hip: 0.014, aim: 0.003 }, basePrice: 110, slot: 1 },
  shotgun: {
    baseDamage: 9, cooldown: 0.85, magSize: 6, reloadTime: 2.4, pellets: 8,
    spread: { hip: 0.055, aim: 0.04 }, basePrice: 120, slot: 1,
    falloff: { start: 7, end: 28, min: 0.25 },
  },
  sniper: { baseDamage: 70, cooldown: 1.3, magSize: 5, reloadTime: 2.8, pellets: 1, spread: { hip: 0.06, aim: 0 }, basePrice: 150, slot: 1 },
};
const WEAPON_ID_PATTERN = Object.keys(WEAPON_DEFS).join('|');
const DEFAULT_WEAPON_ID = 'pistol';

function weaponDef(weaponId) {
  return WEAPON_DEFS[weaponId] || WEAPON_DEFS[DEFAULT_WEAPON_ID];
}
// Une arme dans un slot du stuff : { id, rarity, ammo } — ammo = balles dans le
// chargeur (la réserve est illimitée, seul le rechargement prend du temps).
function makeWeapon(weaponId, rarity = 'gray') {
  return { id: weaponId, rarity, ammo: weaponDef(weaponId).magSize };
}
// Dégâts d'UN tir (d'UN plomb pour le fusil à pompe).
function weaponDamage(weaponId, rarity) {
  return Math.round(weaponDef(weaponId).baseDamage * rarityDamageMultiplier(rarity));
}
function weaponCooldown(weaponId) {
  return weaponDef(weaponId).cooldown;
}
// Fraction des dégâts conservée à `distance` mètres pour une arme à
// atténuation (fusil à pompe) ; 1 pour les autres.
function falloffFactor(falloff, distance) {
  if (!falloff || distance <= falloff.start) return 1;
  if (distance >= falloff.end) return falloff.min;
  const t = (distance - falloff.start) / (falloff.end - falloff.start);
  return 1 - t * (1 - falloff.min);
}

// Dispersion : mêmes constantes que src/weapons.js. Le client tire ses plombs
// dans un disque de dispersion autour de sa visée ; le serveur ne vérifie que le
// PLAFOND (hanche, en l'air, plein "bloom"), pour qu'un client modifié ne puisse
// pas envoyer des plombs en dehors de ce que l'arme permet.
const SPREAD_AIR_MULT = 2.2;
const SPREAD_BLOOM_FACTOR = 0.8;
const BLOOM_MAX = 1.5;
const SPREAD_CAP_SAFETY = 3.6; // >= SPREAD_AIR_MULT + SPREAD_BLOOM_FACTOR * BLOOM_MAX (= 3,4), avec marge
function maxSpreadCosine(def) {
  const radius = def.spread.hip * SPREAD_CAP_SAFETY + 0.002;
  return Math.cos(Math.atan(radius));
}

// Prix de base (palier gris) par type d'arme, et multiplicateur de PRIX par
// palier de rareté — volontairement plus agressif que le multiplicateur de
// dégâts ci-dessus, pour que le rouge reste un achat de fin de partie et pas
// un simple confort. Doit rester identique à src/shop.js / src/weapons.js.
const RARITY_PRICE_MULTIPLIER = { gray: 1, blue: 2, red: 3.5 };
function weaponPrice(weaponId, rarity) {
  const base = weaponDef(weaponId).basePrice || 100;
  return Math.round(base * (RARITY_PRICE_MULTIPLIER[rarity] ?? 1));
}

// ---------------------------------------------------------------------------
// Grenades — table + physique de vol (identique à src/weapons.js). Le serveur
// simule le vol (rebonds sur les mêmes boîtes de collision que les tirs) et
// décide seul de l'explosion et des dégâts ; les clients ne font qu'afficher.
// ---------------------------------------------------------------------------
const GRENADE_DEFS = {
  frag: { price: 70, max: 2, fuse: 2.4, radius: 7, damage: 100 },
  smoke: { price: 40, max: 2, fuse: 1.8, radius: 5, duration: 14 },
};
const GRENADE_RADIUS = 0.12;
const GRENADE_GRAVITY = 16;
const GRENADE_RESTITUTION = 0.45;
const GRENADE_THROW_SPEED = 16;
const GRENADE_THROW_LIFT = 3;
const GRENADE_STEP = 1 / 60;
const GRENADE_THROW_COOLDOWN_MS = 700;

function grenadeCollides(boxes, x, y, z) {
  const r = GRENADE_RADIUS;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (
      x > b.minX - r && x < b.maxX + r &&
      y > b.minY - r && y < b.maxY + r &&
      z > b.minZ - r && z < b.maxZ + r
    ) {
      return true;
    }
  }
  return false;
}

function stepGrenade(g, boxes, dt = GRENADE_STEP) {
  g.vel.y -= GRENADE_GRAVITY * dt;
  for (const axis of ['x', 'y', 'z']) {
    const prev = g.pos[axis];
    g.pos[axis] += g.vel[axis] * dt;
    if (grenadeCollides(boxes, g.pos.x, g.pos.y, g.pos.z)) {
      g.pos[axis] = prev;
      g.vel[axis] = -g.vel[axis] * GRENADE_RESTITUTION;
      for (const other of ['x', 'y', 'z']) {
        if (other !== axis) g.vel[other] *= 0.85;
      }
    }
  }
  if (g.pos.y < GRENADE_RADIUS) {
    g.pos.y = GRENADE_RADIUS;
    g.vel.y = Math.abs(g.vel.y) > 1.2 ? -g.vel.y * 0.4 : 0;
    g.vel.x *= 0.86;
    g.vel.z *= 0.86;
  }
}

const VEST_PRICE = 60;
// Capacité spéciale : débloque un 3e emplacement de gilet (réserve + bouclier
// actif) pour le reste de la partie EN COURS — ne se réinitialise jamais à
// la mort/au respawn, contrairement aux gilets en réserve et aux armes.
const ABILITY_EXTRA_VEST_PRICE = 300;
const ABILITY_MAX_VEST_SLOTS = MAX_SHIELD_VESTS + 1;

// itemId attendu pour chaque type d'achat — doit rester identique aux id
// générés par buildCatalog() dans src/shop.js.
function isWeaponItemId(itemId) {
  return new RegExp(`^weapon:(${WEAPON_ID_PATTERN}):(gray|blue|red)$`).exec(itemId);
}

// Traite un achat pour `player` (déjà vérifié vivant par l'appelant). Ne
// fait RIEN silencieusement si l'achat est invalide (fonds insuffisants,
// déjà possédé, slot déjà plein…) — même logique "no-op silencieux" que le
// reste du serveur (ex. use-vest quand le bouclier est déjà plein) : le
// client empêche déjà ça via les boutons désactivés, ceci n'est qu'un
// filet de sécurité côté autorité.
function tryPurchase(socket, player, itemId) {
  if (itemId === 'vest') {
    if (player.vestCount >= player.maxVestSlots) return;
    if (player.money < VEST_PRICE) return;
    player.money -= VEST_PRICE;
    player.vestCount += 1;
    io.to(socket.id).emit('your-money', { money: player.money });
    io.to(socket.id).emit('your-vest-count', { count: player.vestCount });
    return;
  }

  if (itemId === 'ability-extra-vest-slot') {
    if (player.maxVestSlots >= ABILITY_MAX_VEST_SLOTS) return;
    if (player.money < ABILITY_EXTRA_VEST_PRICE) return;
    player.money -= ABILITY_EXTRA_VEST_PRICE;
    player.maxVestSlots = ABILITY_MAX_VEST_SLOTS;
    io.to(socket.id).emit('your-money', { money: player.money });
    io.to(socket.id).emit('your-abilities', { maxVestSlots: player.maxVestSlots });
    return;
  }

  const utilityMatch = /^utility:(frag|smoke)$/.exec(itemId);
  if (utilityMatch) {
    const kind = utilityMatch[1];
    const def = GRENADE_DEFS[kind];
    if ((player.grenades[kind] || 0) >= def.max) return;
    if (player.money < def.price) return;
    player.money -= def.price;
    player.grenades[kind] = (player.grenades[kind] || 0) + 1;
    io.to(socket.id).emit('your-money', { money: player.money });
    io.to(socket.id).emit('your-grenades', { ...player.grenades });
    return;
  }

  const weaponMatch = isWeaponItemId(itemId);
  if (weaponMatch) {
    const [, weaponId, rarity] = weaponMatch;
    const price = weaponPrice(weaponId, rarity);
    if (player.money < price) return;

    // Le pistolet occupe toujours le slot 0 (l'achat ne fait qu'améliorer sa
    // rareté) ; toutes les autres armes vont dans le slot 1 (remplace ce qui
    // s'y trouve déjà). Une arme achetée arrive avec un chargeur plein.
    const slot = weaponDef(weaponId).slot;

    player.money -= price;
    cancelReload(player, slot);
    player.weapons[slot] = makeWeapon(weaponId, rarity);
    io.to(socket.id).emit('your-money', { money: player.money });
    io.to(socket.id).emit('your-weapons', { weapons: player.weapons });
  }
}

const TEAMS = ['red', 'blue', 'yellow', 'green'];

// Doit rester identique à EMOJI_FACES dans src/appearance.js — le serveur ne
// fait confiance à aucune valeur envoyée par le client : couleur hors format
// ou emoji hors liste retombent silencieusement sur une valeur par défaut.
const EMOJI_FACES = ['😀', '😎', '😡', '😱', '🤖', '👽', '💀', '🥶', '🤠', '🤡', '😈', '🥵'];
const DEFAULT_APPEARANCE = { bodyColor: '#8a8f98', face: EMOJI_FACES[0] };
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function sanitizeAppearance(input) {
  const bodyColor = HEX_COLOR_RE.test(input?.bodyColor) ? input.bodyColor : DEFAULT_APPEARANCE.bodyColor;
  const face = EMOJI_FACES.includes(input?.face) ? input.face : DEFAULT_APPEARANCE.face;
  return { bodyColor, face };
}

// Identifiant du groupe Firestore (voir src/groups.js côté client) auquel le
// joueur appartient, s'il en a un — sert uniquement à équilibrer les équipes
// et les spawns (voir assignTeam / pickTeamSpawn), jamais interprété comme
// un chemin ou une requête.
function sanitizeGroupId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Mode de jeu ("solo" ou "team") + équipe choisie par le créateur du groupe.
// Envoyés par le client (voir game-session.js), jamais vérifiés contre
// Firestore : le serveur ne connaît ni comptes ni groupes (voir tout en
// haut du fichier) — mêmes limites de confiance que groupId juste au-dessus.
// mode ne vaut vraiment 'team' que si une équipe valide l'accompagne, sinon
// on retombe silencieusement sur 'solo' (comportement inchangé).
function sanitizeTeamChoice(input) {
  return TEAMS.includes(input) ? input : null;
}
function sanitizeMode(input, team) {
  return input === 'team' && team ? 'team' : 'solo';
}

// Deux joueurs sont coéquipiers "protégés" seulement si TOUS LES DEUX sont en
// mode 'team' et partagent la même équipe — un joueur en solo (ou dont
// l'équipe n'a pas encore été assignée par l'admin) reste attaquable par/vers
// tout le monde, comme avant.
function isFriendlyFire(shooter, target) {
  return shooter.mode === 'team' && target.mode === 'team' && shooter.team === target.team;
}

// ---------------------------------------------------------------------------
// Obstacles (murs + balcon + caisses de couverture) : chargés depuis
// mapData.colliders, plus aucune géométrie codée en dur ici. Le serveur n'a
// pas de moteur 3D — juste ces boîtes, au format {minX,maxX,minY,maxY,minZ,
// maxZ}, pour empêcher les tirs de traverser murs/balcon/caisses. Le type
// "floor" (sol du balcon) ne bloque un tir qu'à sa hauteur ; les murs/caisses
// (type "wall") bloquent sur toute leur hauteur — voir rayBoxDistance juste
// en dessous, qui traite les deux de la même façon (un simple test de boîte).
function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0);

  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
      }
    }
  }

  return out;
}

function nodeLocalMatrix(node) {
  if (node.matrix && node.matrix.length === 16) {
    return node.matrix;
  }

  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];

  return [
    (1 - 2 * (y * y + z * z)) * sx,
    (2 * (x * y + z * w)) * sx,
    (2 * (x * z - y * w)) * sx,
    0,

    (2 * (x * y - z * w)) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    (2 * (y * z + x * w)) * sy,
    0,

    (2 * (x * z + y * w)) * sz,
    (2 * (y * z - x * w)) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,

    tx, ty, tz, 1,
  ];
}

function transformPoint(matrix, x, y, z) {
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  };
}

function loadColliderBoxesFromGLB() {
  const path = new URL('../mini-warzone/public/assets/map-colliders.glb', import.meta.url);
  const buffer = readFileSync(path);

  if (buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('Signature GLB invalide : les 4 premiers octets ne sont pas "glTF".');
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 2) {
    throw new Error(`Version GLB non prise en charge : ${version}. Version attendue : 2.`);
  }

  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength > buffer.length) {
    throw new Error(
      `Fichier GLB incomplet : taille annoncée ${declaredLength}, taille reçue ${buffer.length}.`
    );
  }

  let offset = 12;
  let gltf = null;
  let binaryChunk = null;

  while (offset + 8 <= Math.min(declaredLength, buffer.length)) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;

    if (end > buffer.length) {
      throw new Error(`Chunk GLB tronqué à l'octet ${offset}.`);
    }

    if (chunkType === 0x4E4F534A) {
      gltf = JSON.parse(buffer.toString('utf8', start, end));
    } else if (chunkType === 0x004E4942) {
      binaryChunk = buffer.subarray(start, end);
    }

    offset = end;
  }

  if (!gltf) throw new Error('Le fichier GLB ne contient pas de chunk JSON.');
  if (!binaryChunk) throw new Error('Le fichier GLB ne contient pas de données BIN intégrées.');

  const boxes = [];
  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];
  const accessors = gltf.accessors || [];
  const bufferViews = gltf.bufferViews || [];

  function readPosition(accessorIndex) {
    const accessor = accessors[accessorIndex];

    if (!accessor) {
      throw new Error(`Accessor POSITION introuvable : ${accessorIndex}.`);
    }

    if (accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
      throw new Error(
        `Accessor POSITION ${accessorIndex} non pris en charge : componentType=${accessor.componentType}, type=${accessor.type}. POSITION doit être FLOAT VEC3.`
      );
    }

    const view = bufferViews[accessor.bufferView];

    if (!view || view.buffer !== undefined && view.buffer !== 0) {
      throw new Error(`BufferView invalide pour l'accessor ${accessorIndex}.`);
    }

    const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    const stride = view.byteStride || 12;
    const data = new DataView(
      binaryChunk.buffer,
      binaryChunk.byteOffset,
      binaryChunk.byteLength
    );
    const points = [];

    for (let i = 0; i < accessor.count; i++) {
      const p = start + i * stride;

      if (p + 12 > binaryChunk.length) {
        throw new Error(`Positions tronquées dans l'accessor ${accessorIndex}, vertex ${i}.`);
      }

      points.push([
        data.getFloat32(p, true),
        data.getFloat32(p + 4, true),
        data.getFloat32(p + 8, true),
      ]);
    }

    return points;
  }

  function visitNode(nodeIndex, parentMatrix) {
    const node = nodes[nodeIndex];

    if (!node) {
      throw new Error(`Node GLB introuvable : ${nodeIndex}.`);
    }

    const worldMatrix = multiplyMatrices(parentMatrix, nodeLocalMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];

      if (!mesh) {
        throw new Error(`Mesh GLB introuvable : ${node.mesh}.`);
      }

      for (const primitive of mesh.primitives || []) {
        if (primitive.attributes?.POSITION === undefined) continue;

        const points = readPosition(primitive.attributes.POSITION);

        if (!points.length) continue;

        const first = transformPoint(
          worldMatrix, points[0][0], points[0][1], points[0][2]
        );

        const box = {
          minX: first.x, maxX: first.x,
          minY: first.y, maxY: first.y,
          minZ: first.z, maxZ: first.z,
        };

        for (let i = 1; i < points.length; i++) {
          const p = transformPoint(
            worldMatrix, points[i][0], points[i][1], points[i][2]
          );

          box.minX = Math.min(box.minX, p.x);
          box.maxX = Math.max(box.maxX, p.x);
          box.minY = Math.min(box.minY, p.y);
          box.maxY = Math.max(box.maxY, p.y);
          box.minZ = Math.min(box.minZ, p.z);
          box.maxZ = Math.max(box.maxZ, p.z);
        }

        boxes.push(box);
      }
    }

    for (const childIndex of node.children || []) {
      visitNode(childIndex, worldMatrix);
    }
  }

  const identity = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];

  const scenes = gltf.scenes || [];
  const activeScene = scenes[gltf.scene || 0];

  if (activeScene?.nodes?.length) {
    for (const nodeIndex of activeScene.nodes) {
      visitNode(nodeIndex, identity);
    }
  } else {
    // Secours pour un GLB sans scène active définie.
    const childNodes = new Set();
    for (const node of nodes) {
      for (const child of node.children || []) childNodes.add(child);
    }

    nodes.forEach((node, index) => {
      if (!childNodes.has(index)) visitNode(index, identity);
    });
  }

  if (boxes.length === 0) {
    throw new Error(
      'Aucune géométrie POSITION exploitable trouvée dans map-colliders.glb.'
    );
  }

  console.info(
    `[MAP-COLLIDERS] Serveur : ${boxes.length} boîte(s) de collision calculée(s) depuis map-colliders.glb.`
  );

  return boxes;
}

let OBSTACLES;

try {
  OBSTACLES = loadColliderBoxesFromGLB();
} catch (error) {
  console.error(
    '[MAP-COLLIDERS] ÉCHEC DU CHARGEMENT SERVEUR de public/asset/map-colliders.glb :',
    error
  );

  console.warn(
    '[MAP-COLLIDERS] Utilisation temporaire de map-data.json. Les tirs risquent de ne pas correspondre à la nouvelle map.'
  );

  OBSTACLES = mapData.colliders || [];

  if (!OBSTACLES.length) {
    console.error(
      '[MAP-COLLIDERS] ATTENTION : aucun obstacle de secours disponible. Les tirs ne seront pas bloqués par les murs.'
    );
  }
}

// Distance d'intersection rayon/boîte (test des "tranches" standard). Rend
// null si le rayon ne touche pas la boîte, sinon la distance du premier point
// de contact.
function rayBoxDistance(ox, oy, oz, dx, dy, dz, box) {
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const min = [box.minX, box.minY, box.minZ];
  const max = [box.maxX, box.maxY, box.maxZ];
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
      continue;
    }
    let t1 = (min[i] - o[i]) / d[i];
    let t2 = (max[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

// Distance jusqu'au premier obstacle touché par ce tir (Infinity si aucun) —
// sert à la fois à limiter la portée visuelle du traceur ET à empêcher un tir
// de toucher quelqu'un caché derrière un mur/une caisse.
function nearestObstacleDistance(origin, direction) {
  let nearest = Infinity;
  for (const box of OBSTACLES) {
    const dist = rayBoxDistance(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, box);
    if (dist !== null && dist >= 0 && dist < nearest) nearest = dist;
  }
  return nearest;
}

// Équipe rouge à l'ouest (x négatif), équipe bleue à l'est (x positif) —
// coordonnées définies dans mapData.teamSpawns (à ajuster là-bas si la
// taille de la salle change côté client).
const TEAM_SPAWN_POINTS = mapData.teamSpawns;

// Renvoie { position, spawnIndex }. Si un coéquipier du même groupe (voir
// groupId, envoyé par le client à la connexion — cf. src/groups.js côté
// client) est déjà posté sur cette équipe, on réutilise SON point de spawn
// (avec un petit décalage pour ne pas apparaître littéralement l'un dans
// l'autre) plutôt qu'un tirage au hasard : c'est ce qui permet à un groupe
// d'amis d'atterrir vraiment ensemble plutôt qu'à trois coins différents.
function pickTeamSpawn(team, groupId) {
  const points = TEAM_SPAWN_POINTS[team] || TEAM_SPAWN_POINTS[TEAMS[0]];

  if (groupId) {
    const groupmates = Array.from(players.values()).filter(
      (p) => p.groupId === groupId && p.team === team && Number.isInteger(p.spawnIndex)
    );
    if (groupmates.length > 0) {
      const spawnIndex = groupmates[0].spawnIndex;
      const base = points[spawnIndex] || points[0];
      const offset = groupmates.length * 0.8; // évite la superposition exacte
      return {
        position: { x: base.x + offset, y: base.y, z: base.z + offset },
        spawnIndex,
      };
    }
  }

  const spawnIndex = Math.floor(Math.random() * points.length);
  return { position: { ...points[spawnIndex] }, spawnIndex };
}

// Équilibrage : le nouveau joueur rejoint l'équipe la moins nombreuse
// (égalité → équipe rouge).
//
// Pas d'exception "groupId" ici — il y en a eu une avant (mettre
// automatiquement un groupe entier dans la même équipe), mais elle entrait
// en conflit avec le choix de l'admin (voir ÉQUIPES ci-dessous) : dès que le
// premier membre d'un groupe rejoignait, TOUS les suivants héritaient
// silencieusement de SON équipe — et comme le tout premier joueur connecté
// (equal counts) atterrit toujours côté rouge, un groupe entier qui teste
// ensemble finissait systématiquement rouge en entier, quoi que l'admin ait
// réellement assigné à chacun. C'est précisément le bug "tout le monde est
// dans l'équipe rouge" : cette fonction n'est appelée QUE pour un joueur
// sans équipe fixée par l'admin (voir le handler 'join' plus bas), donc
// l'équilibrer normalement, sans tenir compte du groupe, est le bon
// comportement par défaut.
//
// La cohésion de groupe reste assurée autrement, sans rien devoir au
// hasard : pickTeamSpawn (juste au-dessus) fait spawner ensemble ceux qui
// sont déjà sur la MÊME équipe (qu'elle vienne de l'admin ou de cet
// équilibrage), et le mode Équipes + l'assignation manuelle restent le
// moyen explicite de mettre tout un groupe du même côté.
function assignTeam() {
  const counts = Object.fromEntries(TEAMS.map((team) => [team, 0]));
  players.forEach((p) => {
    if (Object.hasOwn(counts, p.team)) counts[p.team] += 1;
  });
  return TEAMS.reduce((least, team) => counts[team] < counts[least] ? team : least, TEAMS[0]);
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Mini Warzone — serveur temps réel OK');
});

// Ouvert à tout le monde : le but est justement que n'importe qui avec le
// lien puisse rejoindre la partie (projet perso entre potes, pas de données
// sensibles à protéger ici). Si un jour tu veux restreindre, remplace '*'
// par l'URL exacte de ton client (ex. ton lien Netlify).
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

// socket.id -> { pseudo, position, rotationY, hp, shield, weapons, vestCount,
//                maxVestSlots, money, alive }
const players = new Map();

// ---------------------------------------------------------------------------
// Stuff au sol — armes et gilets qui tombent à la mort d'un joueur (voir
// dropLoot, appelé depuis killPlayer). Contrairement à l'ancien loot de la
// map (retiré), rien n'est semé au hasard ni réapprovisionné tout seul.
// Un objet tombe d'abord au sol (chute calculée ici), puis y reste
// LOOT_LIFETIME_MS (1 minute) avant de disparaître s'il n'a pas été ramassé :
// le compte à rebours démarre à l'ATTERRISSAGE, pas à la mort, et repart à zéro
// chaque fois que l'objet retombe au sol (voir armLootTimer).
//   groundVests   : vestId         -> { position, fromY, landedAt, expiresAt }
//   groundWeapons : weaponPickupId -> { position, weapon, fromY, landedAt, expiresAt }
// `position` est toujours la position FINALE, au sol ; `fromY` la hauteur de
// départ de la chute.
// Les gilets se ramassent automatiquement en marchant dessus (voir le
// handler 'move' plus bas) ; les armes demandent une action du joueur
// (touche E par défaut, configurable — voir 'collect-weapon' plus bas), pour
// éviter d'échanger son arme sans le vouloir en traversant le point de mort
// de quelqu'un en plein combat.
const groundVests = new Map();
const groundWeapons = new Map();
const VEST_PICKUP_RADIUS = 1.1; // ramassage auto : assez court pour ne pas "aimanter" de loin (distance horizontale)
const WEAPON_PICKUP_RADIUS = 1.8; // ramassage à la touche E : portée normale d'interaction (distance horizontale)
const PICKUP_VERTICAL_REACH = 1.2; // écart de hauteur toléré entre le torse du joueur et l'objet au sol

// Durée de vie d'un objet au sol, comptée depuis son atterrissage. La variable
// d'environnement ne sert qu'aux tests (ex. LOOT_LIFETIME_MS=3000 node server.js).
const LOOT_LIFETIME_MS = Number(process.env.LOOT_LIFETIME_MS) > 0 ? Number(process.env.LOOT_LIFETIME_MS) : 60_000;
const LOOT_GRAVITY = 12; // m/s², pour la durée de chute (le client anime la même chute)

// Hauteur du sol sous (x, z), en partant de `fromY` : le dessus de la boîte de
// collision la plus haute située sous ce point (sol, caisse, plateforme), 0 par défaut.
function groundHeightAt(x, fromY, z) {
  let best = 0;
  for (let i = 0; i < OBSTACLES.length; i++) {
    const b = OBSTACLES[i];
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.maxY <= fromY + 0.2 && b.maxY > best) best = b.maxY;
  }
  return best;
}

// Position finale + chute pour un objet qui lâche à (x, fromY, z).
function lootLanding(x, fromY, z) {
  const landY = groundHeightAt(x, fromY, z);
  const height = Math.max(0, fromY - landY);
  const fallMs = Math.round(Math.sqrt((2 * height) / LOOT_GRAVITY) * 1000);
  return { position: { x, y: landY, z }, fromY: Math.max(fromY, landY), fallMs };
}

// (Re)lance le compte à rebours d'un objet qui touche le sol à `landsAt`.
// À rappeler chaque fois qu'un objet RETOMBE au sol : il repart pour une minute.
function armLootTimer(item, landsAt) {
  item.landedAt = landsAt;
  item.expiresAt = landsAt + LOOT_LIFETIME_MS;
}

// Ce que les clients doivent savoir pour animer la chute et le clignotement final.
function lootTimingPayload(item, now = Date.now()) {
  return {
    fromY: item.fromY,
    fallMs: Math.max(0, item.landedAt - now),
    expiresInMs: Math.max(0, item.expiresAt - now),
  };
}

// Le joueur est-il à portée d'un objet au sol ? Horizontalement, + une fenêtre
// verticale (position.y = hauteur des yeux ; le torse est ~0,9 m plus bas).
function inPickupReach(player, pos, radius) {
  const dx = player.position.x - pos.x;
  const dz = player.position.z - pos.z;
  if (Math.hypot(dx, dz) > radius) return false;
  return Math.abs(player.position.y - 0.9 - pos.y) <= PICKUP_VERTICAL_REACH;
}

// Fait tomber au sol les armes (avec leur rareté réelle — un fusil rouge
// acheté tombe en fusil rouge, pas en arme générique) et les gilets en
// réserve non utilisés d'un joueur qui vient de mourir. Appelée tout en haut
// de killPlayer, avant que son stuff ne soit réinitialisé pour le respawn.
function dropLoot(victim) {
  const pos = victim.position;
  const now = Date.now();
  const startY = pos.y - 0.7; // la chute part du torse du joueur

  victim.weapons.forEach((weapon, slot) => {
    if (!weapon) return;
    const id = randomUUID();
    // léger décalage pour ne pas empiler les deux armes pile au même point
    const landing = lootLanding(pos.x + (slot === 0 ? -0.3 : 0.3), startY, pos.z);
    const item = { position: landing.position, weapon: { ...weapon }, fromY: landing.fromY };
    armLootTimer(item, now + landing.fallMs);
    groundWeapons.set(id, item);
    io.emit('weapon-pickup-spawned', {
      id,
      weaponId: weapon.id,
      rarity: weapon.rarity,
      position: item.position,
      ...lootTimingPayload(item, now),
    });
  });

  for (let i = 0; i < victim.vestCount; i++) {
    const id = randomUUID();
    const landing = lootLanding(pos.x + (i - (victim.vestCount - 1) / 2) * 0.35, startY, pos.z - 0.4);
    const item = { position: landing.position, fromY: landing.fromY };
    armLootTimer(item, now + landing.fallMs);
    groundVests.set(id, item);
    io.emit('vest-spawned', { id, position: item.position, ...lootTimingPayload(item, now) });
  }
}

// Fait disparaître le butin dont la minute est écoulée (repassé toutes les secondes).
function sweepGroundLoot() {
  const now = Date.now();
  groundWeapons.forEach((item, id) => {
    if (now < item.expiresAt) return;
    groundWeapons.delete(id);
    io.emit('weapon-pickup-removed', { id });
  });
  groundVests.forEach((item, id) => {
    if (now < item.expiresAt) return;
    groundVests.delete(id);
    io.emit('vest-removed', { id });
  });
}
setInterval(sweepGroundLoot, 1000);

// ---------------------------------------------------------------------------
// Détection de tir : test rayon-sphère simple, pas besoin de Three.js côté
// serveur — juste de la géométrie de base. On garde le point d'impact le
// plus proche si plusieurs joueurs sont alignés sur le tir.
// ---------------------------------------------------------------------------
function raySphereDistance(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null; // le rayon part de l'extérieur et s'en éloigne
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const t = -b - Math.sqrt(discriminant);
  return t >= 0 ? t : 0;
}

// Position interpolée de `player` au moment `t` (ms, Date.now()), à partir de
// son historique de positions — voir LAG_COMPENSATION_MS plus haut. Si `t`
// est plus vieux que tout l'historique gardé, on renvoie le point le plus
// ancien disponible plutôt que d'extrapoler plus loin ; si `t` est plus
// récent que la dernière position connue, on renvoie celle-ci telle quelle.
function getPositionAtTime(player, t) {
  const history = player.positionHistory;
  if (!history || history.length === 0) return player.position;
  if (t <= history[0].t) return history[0].position;
  if (t >= history[history.length - 1].t) return player.position;

  for (let i = 1; i < history.length; i++) {
    if (history[i].t < t) continue;
    const prev = history[i - 1];
    const next = history[i];
    const span = next.t - prev.t;
    const ratio = span > 0 ? (t - prev.t) / span : 0;
    return {
      x: prev.position.x + (next.position.x - prev.position.x) * ratio,
      y: prev.position.y + (next.position.y - prev.position.y) * ratio,
      z: prev.position.z + (next.position.z - prev.position.z) * ratio,
    };
  }
  return player.position;
}

function findClosestHit(shooterId, origin, direction, maxDistance, atTime) {
  let closestHit = null;
  let closestDistance = maxDistance;

  players.forEach((player, id) => {
    if (id === shooterId || !player.alive) return;
    const rewound = getPositionAtTime(player, atTime);

    // La tête du modèle est centrée à environ -0,05 m par rapport aux yeux.
    // On teste sa hitbox séparément afin de pouvoir distinguer les headshots.
    const headDistance = raySphereDistance(
      origin,
      direction,
      { x: rewound.x, y: rewound.y - 0.05, z: rewound.z },
      HEAD_HIT_RADIUS
    );

    let bodyDistance = null;
    for (const offsetY of BODY_SAMPLE_OFFSETS) {
      const center = {
        x: rewound.x,
        y: rewound.y + offsetY,
        z: rewound.z,
      };
      const dist = raySphereDistance(origin, direction, center, HIT_RADIUS);
      if (dist !== null && (bodyDistance === null || dist < bodyDistance)) {
        bodyDistance = dist;
      }
    }

    // Le headshot est retenu uniquement si la tête est le premier point
    // touché sur ce joueur ; sinon, le tir compte comme un impact au corps.
    const isHeadshot = headDistance !== null &&
      (bodyDistance === null || headDistance <= bodyDistance);
    const playerDistance = isHeadshot ? headDistance : bodyDistance;

    if (playerDistance !== null && playerDistance < closestDistance) {
      closestDistance = playerDistance;
      closestHit = { id, headshot: isHeadshot, distance: playerDistance };
    }
  });

  return closestHit;
}

// ---------------------------------------------------------------------------
// Petits utilitaires vectoriels / alliés
// ---------------------------------------------------------------------------
function isFiniteVec3(v) {
  return v && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
function normalizeVec(v) {
  if (!isFiniteVec3(v)) return null;
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-6) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// Alliés = même équipe ET même mode ; en mode Solo (équipes auto-équilibrées,
// donc sans rapport entre elles) il faut en plus appartenir au même groupe.
// Sert à décider qui voit les pings d'équipe (voir 'place-ping' plus bas).
function isAlly(a, b) {
  if (!a || !b || a.team !== b.team || a.mode !== b.mode) return false;
  return a.mode === 'team' || (Boolean(a.groupId) && a.groupId === b.groupId);
}
function allyIds(senderId) {
  const sender = players.get(senderId);
  if (!sender) return [];
  const ids = [senderId];
  players.forEach((p, id) => {
    if (id !== senderId && isAlly(sender, p)) ids.push(id);
  });
  return ids;
}
function emitToIds(ids, event, payload) {
  ids.forEach((id) => io.to(id).emit(event, payload));
}

// ---------------------------------------------------------------------------
// Rechargement : le serveur est seul juge du moment où le chargeur est plein
// (le client fait la même animation en parallèle, avec une petite avance).
// ---------------------------------------------------------------------------
const RELOAD_TOLERANCE_MS = 80; // latence : on finit un peu plus tôt que le temps théorique

// Annule le rechargement en cours. `onlySlot` (optionnel) : ne l'annule que
// s'il concerne ce slot (ex. l'arme de ce slot vient d'être remplacée).
function cancelReload(player, onlySlot = null) {
  if (!player.reload) return;
  if (onlySlot !== null && player.reload.slot !== onlySlot) return;
  clearTimeout(player.reload.timer);
  player.reload = null;
}

function startReload(socketId, slot) {
  const player = players.get(socketId);
  if (!player || !player.alive || player.reload) return;
  if (slot !== 0 && slot !== 1) return;
  const weapon = player.weapons[slot];
  if (!weapon) return;
  const def = weaponDef(weapon.id);
  if (weapon.ammo >= def.magSize) return;

  player.reload = {
    slot,
    weaponId: weapon.id,
    rarity: weapon.rarity,
    timer: setTimeout(() => finishReload(socketId), Math.max(0, def.reloadTime * 1000 - RELOAD_TOLERANCE_MS)),
  };
}

function finishReload(socketId) {
  const player = players.get(socketId);
  if (!player || !player.reload) return;
  const { slot, weaponId, rarity } = player.reload;
  player.reload = null;
  const weapon = player.weapons[slot];
  // L'arme a changé / le joueur est mort pendant le rechargement : rien à faire.
  if (!player.alive || !weapon || weapon.id !== weaponId || weapon.rarity !== rarity) return;
  weapon.ammo = weaponDef(weapon.id).magSize;
  io.to(socketId).emit('your-ammo', { slot, ammo: weapon.ammo, reloaded: true });
}

// ---------------------------------------------------------------------------
// Dégâts : point d'entrée UNIQUE pour tout ce qui blesse un joueur (balles,
// plombs, grenades) — bouclier d'abord, puis points de vie, puis mort.
// attackerId peut être null (grenade d'un joueur parti, ou suicide).
// ---------------------------------------------------------------------------
function dealDamage(attackerId, targetId, amount, { headshot = false, weapon = null, source = null } = {}) {
  const target = players.get(targetId);
  if (!target || !target.alive) return;
  const total = Math.round(amount);
  if (total <= 0) return;

  let damage = total;
  if (target.shield > 0) {
    const absorbed = Math.min(target.shield, damage);
    target.shield -= absorbed;
    damage -= absorbed;
    io.to(targetId).emit('your-shield', { shield: target.shield });
    broadcastShieldSteps(targetId, target);
  }
  target.hp = Math.max(0, target.hp - damage);
  io.to(targetId).emit('your-hp', { hp: target.hp });
  // D'où vient le coup (position du tireur ou de l'explosion) : sert à l'indicateur
  // rouge autour du viseur côté client. Pas d'info sur l'identité de l'attaquant.
  if (source) io.to(targetId).emit('damage-taken', { x: source.x, z: source.z, amount: total, headshot });
  if (attackerId && attackerId !== targetId) {
    io.to(attackerId).emit('hit-confirmed', { target: targetId, headshot, damage: total });
  }
  if (target.hp <= 0) {
    killPlayer(targetId, attackerId && attackerId !== targetId ? attackerId : null, weapon);
  }
}

// ---------------------------------------------------------------------------
// Grenades en vol : une boucle à ~30 Hz, active seulement tant qu'il y en a.
// ---------------------------------------------------------------------------
const grenades = new Map(); // id -> { id, kind, owner, pos, vel, explodeAt }
let grenadeTimer = null;
let lastGrenadeTick = 0;

function ensureGrenadeLoop() {
  if (grenadeTimer) return;
  lastGrenadeTick = Date.now();
  grenadeTimer = setInterval(tickGrenades, 1000 / 30);
}

function tickGrenades() {
  const now = Date.now();
  const steps = Math.min(8, Math.max(1, Math.round(((now - lastGrenadeTick) / 1000) / GRENADE_STEP)));
  lastGrenadeTick = now;

  for (const g of Array.from(grenades.values())) {
    for (let i = 0; i < steps; i++) stepGrenade(g, OBSTACLES, GRENADE_STEP);
    if (now >= g.explodeAt) explodeGrenade(g);
  }
  if (grenades.size === 0) {
    clearInterval(grenadeTimer);
    grenadeTimer = null;
  }
}

function explodeGrenade(g) {
  grenades.delete(g.id);
  const position = { x: g.pos.x, y: g.pos.y, z: g.pos.z };
  io.emit('grenade-exploded', { id: g.id, kind: g.kind, position });
  if (g.kind !== 'frag') return; // le fumigène n'est que visuel

  const def = GRENADE_DEFS.frag;
  const owner = players.get(g.owner) || null;
  const origin = { x: position.x, y: position.y + 0.3, z: position.z };

  // Copie : dealDamage peut tuer quelqu'un pendant qu'on parcourt.
  Array.from(players.entries()).forEach(([playerId, player]) => {
    if (!player.alive) return;
    // Centre du torse (position = hauteur des yeux).
    const center = { x: player.position.x, y: player.position.y - 0.9, z: player.position.z };
    const dx = center.x - origin.x;
    const dy = center.y - origin.y;
    const dz = center.z - origin.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > def.radius) return;

    // Un mur/une caisse entre l'explosion et le joueur le protège totalement.
    if (dist > 0.5) {
      const obstacle = nearestObstacleDistance(origin, { x: dx / dist, y: dy / dist, z: dz / dist });
      if (obstacle < dist - 0.4) return;
    }
    if (owner && playerId !== g.owner && isFriendlyFire(owner, player)) return;

    let damage = def.damage * (1 - dist / def.radius);
    if (playerId === g.owner) damage *= 0.5; // auto-dégâts réduits
    dealDamage(owner ? g.owner : null, playerId, damage, { weapon: { id: 'frag', rarity: null }, source: position });
  });
}

// Diffusé à TOUT le monde (pas juste au joueur concerné) car l'assombrissement
// du gilet doit être visible par les autres joueurs.
function broadcastShieldSteps(id, player) {
  io.emit('player-shield-steps', { id, steps: shieldSteps(player) });
}

// ---------------------------------------------------------------------------
// Scores : kills/morts de chaque joueur pour la durée de sa connexion (ils
// repartent de zéro s'il se reconnecte). Le tableau COMPLET est rediffusé à
// chaque changement (mort, arrivée, départ) : quelques joueurs, quelques
// octets — plus simple et plus sûr que d'envoyer des différences.
// ---------------------------------------------------------------------------
function scoreboardSnapshot() {
  return Array.from(players.entries()).map(([id, p]) => ({
    id,
    pseudo: p.pseudo,
    team: p.team,
    mode: p.mode,
    kills: p.kills,
    deaths: p.deaths,
  }));
}

function broadcastScoreboard() {
  io.emit('scoreboard', scoreboardSnapshot());
}

// weapon : { id, rarity } de l'arme avec laquelle le tir mortel a été tiré
// (pour le kill feed), ou null.
function killPlayer(victimId, killerId, weapon = null) {
  const victim = players.get(victimId);
  if (!victim) return;

  dropLoot(victim); // avant toute réinitialisation : encore le stuff qu'il avait au moment de mourir

  cancelReload(victim);
  victim.grenades = { frag: 0, smoke: 0 }; // les grenades non lancées ne survivent pas à la mort
  io.to(victimId).emit('your-grenades', { ...victim.grenades });

  victim.alive = false;
  victim.hp = 0;
  victim.shield = 0; // le gilet équipé ne survit pas à la mort
  victim.vestCount = 0; // les gilets en réserve non plus
  // maxVestSlots N'EST PAS réinitialisé : la capacité spéciale reste acquise
  // pour le reste de la partie, y compris après un respawn.
  broadcastShieldSteps(victimId, victim);

  victim.deaths += 1;
  const killer = killerId ? players.get(killerId) : null;
  if (killer) {
    killer.kills += 1;
    killer.money = (killer.money || 0) + KILL_REWARD;
    io.to(killerId).emit('your-money', { money: killer.money });
  }

  io.emit('player-died', { id: victimId, killedBy: killerId || null });
  io.to(victimId).emit('you-died');

  // Kill feed : tout est résolu ici (pseudos, équipes, arme) pour que les
  // clients n'aient rien à deviner — et n'affichent jamais un id inconnu si
  // quelqu'un part juste après. L'équipe n'est transmise qu'en mode Équipes :
  // en solo la couleur d'équipe ne sert qu'au spawn, elle n'a pas de sens
  // à l'écran.
  io.emit('kill-feed', {
    killerId: killer ? killerId : null,
    killerPseudo: killer ? killer.pseudo : null,
    killerTeam: killer && killer.mode === 'team' ? killer.team : null,
    victimId,
    victimPseudo: victim.pseudo,
    victimTeam: victim.mode === 'team' ? victim.team : null,
    weaponId: weapon ? weapon.id : null,
    rarity: weapon ? weapon.rarity : null,
  });
  broadcastScoreboard();

  setTimeout(() => {
    if (!players.has(victimId)) return; // parti entre-temps
    const { position: spawn, spawnIndex } = pickTeamSpawn(victim.team, victim.groupId);
    victim.alive = true;
    victim.hp = MAX_HP;
    victim.position = spawn;
    // Repart de zéro : sans ça, juste après le respawn, un rewind pourrait
    // encore remonter à l'ancienne position (avant la mort), qui n'a plus
    // rien à voir avec où le joueur vient d'apparaître.
    victim.positionHistory = [{ t: Date.now(), position: spawn }];
    victim.spawnIndex = spawnIndex;
    victim.weapons = [makeWeapon('pistol', 'gray'), null]; // on repart avec juste le pistolet, rareté gris, chargeur plein
    victim.vestCount = 0;
    io.to(victimId).emit('you-respawned', { position: spawn });
    io.to(victimId).emit('your-weapons', { weapons: victim.weapons });
    io.to(victimId).emit('your-vest-count', { count: victim.vestCount });
    io.emit('player-respawned', { id: victimId, position: spawn });
  }, RESPAWN_DELAY_MS);
}

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    // Compat : un vieux client pourrait encore envoyer juste le pseudo en
    // texte brut plutôt que { pseudo, appearance }.
    const {
      pseudo: pseudoInput,
      appearance: appearanceInput,
      groupId: groupIdInput,
      mode: modeInput,
      team: teamChoiceInput,
    } = typeof payload === 'string' ? { pseudo: payload } : payload || {};
    const pseudo = String(pseudoInput || 'Joueur').slice(0, 20);
    const appearance = sanitizeAppearance(appearanceInput);
    const groupId = sanitizeGroupId(groupIdInput);

    // Mode "Équipes" avec une couleur choisie par l'admin du groupe : on la
    // prend telle quelle plutôt que d'auto-équilibrer. Sinon (mode "Solo", ou
    // pas encore assigné par l'admin), comportement inchangé.
    const teamChoice = sanitizeTeamChoice(teamChoiceInput);
    const mode = sanitizeMode(modeInput, teamChoice);
    const team = mode === 'team' ? teamChoice : assignTeam();
    const { position: spawn, spawnIndex } = pickTeamSpawn(team, groupId);

    // On dit au nouveau venu quelle équipe/quel point de spawn est le sien...
    socket.emit('team-assigned', { team, spawn });

    // ...puis on lui donne la liste de ceux déjà dans l'arène...
    const existingPlayers = Array.from(players.entries()).map(([id, p]) => ({
      id,
      pseudo: p.pseudo,
      team: p.team,
      mode: p.mode,
      position: p.position,
      rotationY: p.rotationY,
      hp: p.hp,
      shieldSteps: shieldSteps(p),
      appearance: p.appearance,
      groupId: p.groupId,
    }));
    socket.emit('current-players', existingPlayers);

    // ...et le stuff déjà au sol (gilets/armes tombés avant son arrivée).
    socket.emit(
      'current-vests',
      Array.from(groundVests.entries()).map(([id, v]) => ({ id, position: v.position, ...lootTimingPayload(v) }))
    );
    socket.emit(
      'current-weapon-pickups',
      Array.from(groundWeapons.entries()).map(([id, w]) => ({
        id,
        weaponId: w.weapon.id,
        rarity: w.weapon.rarity,
        position: w.position,
        ...lootTimingPayload(w),
      }))
    );

    // ...puis on l'ajoute et on prévient tout le monde.
    const player = {
      pseudo,
      team,
      mode,
      groupId,
      spawnIndex,
      appearance,
      position: spawn,
      // Historique pour la compensation de latence (voir LAG_COMPENSATION_MS) —
      // amorcé avec la position de spawn pour ne jamais être vide.
      positionHistory: [{ t: Date.now(), position: spawn }],
      rotationY: 0,
      hp: MAX_HP,
      shield: 0,
      weapons: [makeWeapon('pistol', 'gray'), null],
      grenades: { frag: 0, smoke: 0 },
      reload: null,
      lastThrowAt: 0,
      lastPingAt: 0,
      vestCount: 0,
      maxVestSlots: MAX_SHIELD_VESTS,
      money: 0,
      kills: 0,
      deaths: 0,
      alive: true,
    };
    players.set(socket.id, player);
    socket.emit('your-weapons', { weapons: player.weapons });
    socket.emit('your-grenades', { ...player.grenades });
    socket.emit('your-vest-count', { count: 0 });
    socket.emit('your-abilities', { maxVestSlots: player.maxVestSlots });
    socket.emit('your-money', { money: player.money });

    socket.broadcast.emit('player-joined', { id: socket.id, pseudo, team, mode, position: spawn, appearance, groupId });
    broadcastScoreboard(); // le nouvel arrivant (à 0-0) apparaît chez tout le monde, et reçoit le tableau

    console.log(
      `[+] ${pseudo} (${socket.id}) — équipe ${team}${mode === 'team' ? ' (mode équipes)' : ''} — ${players.size} joueur(s) connecté(s)`
    );
  });

  socket.on('move', ({ position, rotationY } = {}) => {
    const player = players.get(socket.id);
    if (!player || !player.alive || !position) return;

    player.position = position;
    player.rotationY = rotationY || 0;

    const now = Date.now();
    player.positionHistory.push({ t: now, position });
    const cutoff = now - POSITION_HISTORY_MS;
    while (player.positionHistory.length > 1 && player.positionHistory[0].t < cutoff) {
      player.positionHistory.shift();
    }

    // Ramassage automatique d'un gilet au sol à portée — rien à faire pour
    // le joueur, juste marcher dessus. On n'en prend qu'un seul par appel de
    // 'move' (le prochain, à l'appel suivant, quelques ms plus tard) pour ne
    // jamais dépasser le plafond par erreur si plusieurs sont superposés.
    if (player.vestCount < player.maxVestSlots) {
      for (const [vestId, vest] of groundVests) {
        if (!inPickupReach(player, vest.position, VEST_PICKUP_RADIUS)) continue;
        groundVests.delete(vestId);
        io.emit('vest-removed', { id: vestId });
        player.vestCount += 1;
        io.to(socket.id).emit('your-vest-count', { count: player.vestCount });
        break;
      }
    }

    socket.broadcast.emit('player-moved', {
      id: socket.id,
      position: player.position,
      rotationY: player.rotationY,
    });
  });

  // Le client envoie un NUMÉRO DE SLOT (0 = arme 1, 1 = arme 2), jamais un
  // identifiant d'arme ou des dégâts : le serveur regarde lui-même ce que ce
  // slot contient dans son propre état (id, rareté, munitions) pour calculer
  // cadence, chargeur et dégâts. Impossible pour un client modifié de prétendre
  // tirer avec une arme/rareté/un chargeur qu'il n'a pas.
  //
  // `direction` = visée du joueur ; `directions` = direction de chaque plomb
  // (1 pour la plupart des armes, 8 pour le fusil à pompe), déjà dispersée par
  // le client. Le serveur vérifie que chaque plomb reste dans le plafond de
  // dispersion de l'arme (voir maxSpreadCosine) et jette les autres.
  socket.on('shoot', ({ origin: originInput, direction, directions, slot } = {}) => {
    const shooter = players.get(socket.id);
    if (!shooter || !shooter.alive || !isFiniteVec3(originInput)) return;
    if (slot !== 0 && slot !== 1) return;

    const equipped = shooter.weapons[slot];
    if (!equipped) return; // rien dans ce slot
    if (shooter.reload && shooter.reload.slot === slot) return; // rechargement en cours

    const base = normalizeVec(direction);
    if (!base) return;

    const def = weaponDef(equipped.id);
    const now = Date.now();
    // Petite tolérance (20ms) pour la latence réseau, sans quoi une cadence
    // pile-poil correcte côté client se ferait parfois rejeter à tort.
    if (now - (shooter.lastShotAt || 0) < def.cooldown * 1000 - 20) return;

    if (!(equipped.ammo > 0)) {
      // Chargeur vide : on resynchronise le client (qui a pu se tromper) et on s'arrête.
      socket.emit('your-ammo', { slot, ammo: 0 });
      return;
    }
    shooter.lastShotAt = now;
    equipped.ammo -= 1;
    socket.emit('your-ammo', { slot, ammo: equipped.ammo });

    // L'origine du tir doit rester près de la dernière position connue du
    // joueur (latence comprise) : sinon on tire depuis sa position serveur.
    const dxo = originInput.x - shooter.position.x;
    const dyo = originInput.y - shooter.position.y;
    const dzo = originInput.z - shooter.position.z;
    const origin = Math.hypot(dxo, dyo, dzo) <= 4
      ? { x: originInput.x, y: originInput.y, z: originInput.z }
      : { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z };

    // Directions des plombs : plafonnées en dispersion ; client sans
    // `directions` (ancienne version) = un seul plomb tiré pile à la visée.
    const minCos = maxSpreadCosine(def);
    const pellets = [];
    if (Array.isArray(directions)) {
      directions.slice(0, def.pellets).forEach((candidate) => {
        const dir = normalizeVec(candidate);
        if (!dir) return;
        if (dir.x * base.x + dir.y * base.y + dir.z * base.z >= minCos) pellets.push(dir);
      });
    } else {
      pellets.push(base);
    }
    if (pellets.length === 0) return;

    const perTarget = new Map(); // id -> { damage, headshot }
    const tracers = [];
    const rewindTime = now - LAG_COMPENSATION_MS;
    pellets.forEach((dir) => {
      const obstacleDistance = nearestObstacleDistance(origin, dir);
      tracers.push({ direction: dir, maxLength: Math.min(obstacleDistance, 60) });

      const hit = findClosestHit(socket.id, origin, dir, obstacleDistance, rewindTime);
      if (!hit) return;
      const target = players.get(hit.id);
      // Mode Équipes : le tir touche visuellement (le traceur est diffusé
      // plus bas) mais ne fait aucun dégât à un coéquipier.
      if (!target || isFriendlyFire(shooter, target)) return;

      let damage = weaponDamage(equipped.id, equipped.rarity);
      damage = Math.round(damage * falloffFactor(def.falloff, hit.distance));
      if (hit.headshot) damage = Math.round(damage * HEADSHOT_MULTIPLIER);

      const entry = perTarget.get(hit.id) || { damage: 0, headshot: false };
      entry.damage += damage;
      entry.headshot = entry.headshot || hit.headshot;
      perTarget.set(hit.id, entry);
    });

    socket.broadcast.emit('player-shoot', {
      id: socket.id,
      weaponId: equipped.id, // pour que chaque arme ait son propre son chez les autres joueurs
      origin,
      // Champs historiques (premier plomb) + liste complète pour les armes à plombs multiples
      direction: tracers[0].direction,
      maxLength: tracers[0].maxLength,
      shots: tracers,
    });

    const weaponForFeed = { id: equipped.id, rarity: equipped.rarity };
    perTarget.forEach((entry, targetId) => {
      dealDamage(socket.id, targetId, entry.damage, {
        headshot: entry.headshot,
        weapon: weaponForFeed,
        source: { x: origin.x, z: origin.z },
      });
    });
  });

  // Rechargement (touche R, ou automatique à chargeur vide côté client).
  socket.on('reload', ({ slot } = {}) => {
    startReload(socket.id, slot);
  });
  socket.on('cancel-reload', () => {
    const player = players.get(socket.id);
    if (player) cancelReload(player);
  });

  // Lancer de grenade / fumigène : le client envoie seulement le TYPE et la
  // direction du regard. Position de départ, vitesse, minuterie : serveur.
  socket.on('throw-grenade', ({ kind, direction } = {}) => {
    const player = players.get(socket.id);
    if (!player || !player.alive) return;
    const def = GRENADE_DEFS[kind];
    if (!def || (player.grenades[kind] || 0) <= 0) return;
    const dir = normalizeVec(direction);
    if (!dir) return;
    const now = Date.now();
    if (now - player.lastThrowAt < GRENADE_THROW_COOLDOWN_MS) return;
    player.lastThrowAt = now;

    player.grenades[kind] -= 1;
    socket.emit('your-grenades', { ...player.grenades });

    // Départ un peu devant les yeux ; si c'est déjà dans un mur (lancer contre
    // une paroi), on part des yeux — jamais "coincée" dans un obstacle.
    let pos = {
      x: player.position.x + dir.x * 0.6,
      y: player.position.y - 0.1 + dir.y * 0.6,
      z: player.position.z + dir.z * 0.6,
    };
    if (grenadeCollides(OBSTACLES, pos.x, pos.y, pos.z)) {
      pos = { x: player.position.x, y: player.position.y - 0.1, z: player.position.z };
    }
    const vel = {
      x: dir.x * GRENADE_THROW_SPEED,
      y: dir.y * GRENADE_THROW_SPEED + GRENADE_THROW_LIFT,
      z: dir.z * GRENADE_THROW_SPEED,
    };

    const id = randomUUID();
    grenades.set(id, { id, kind, owner: socket.id, pos, vel, explodeAt: now + def.fuse * 1000 });
    ensureGrenadeLoop();
    io.emit('grenade-spawned', {
      id,
      kind,
      owner: socket.id,
      position: { ...pos },
      velocity: { ...vel },
      fuseMs: def.fuse * 1000,
    });
  });

  // Ping d'équipe posé depuis la carte (touche M, voir minimap.js côté client) :
  // un seul ping actif par joueur (le nouveau remplace l'ancien), visible
  // uniquement par ses alliés et lui-même, dans la couleur de son skin.
  const PING_TTL_MS = 15000;
  const PING_COOLDOWN_MS = 700;
  const PING_LIMIT = 80; // la map fait ±75 m
  socket.on('place-ping', ({ x, z } = {}) => {
    const player = players.get(socket.id);
    if (!player || !player.alive) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const now = Date.now();
    if (now - player.lastPingAt < PING_COOLDOWN_MS) return;
    player.lastPingAt = now;

    emitToIds(allyIds(socket.id), 'ping-placed', {
      senderId: socket.id,
      pseudo: player.pseudo,
      color: player.appearance.bodyColor, // déjà validé (#rrggbb) par sanitizeAppearance
      x: Math.max(-PING_LIMIT, Math.min(PING_LIMIT, x)),
      z: Math.max(-PING_LIMIT, Math.min(PING_LIMIT, z)),
      ttl: PING_TTL_MS,
    });
  });
  socket.on('remove-ping', () => {
    if (!players.has(socket.id)) return;
    emitToIds(allyIds(socket.id), 'ping-removed', { senderId: socket.id });
  });

  // Activation d'un gilet en réserve (touche P) : consomme 1 gilet du stuff, ajoute au bouclier actif. Le
  // plafond du bouclier dépend de maxVestSlots (2, ou 3 si la capacité
  // spéciale a été achetée) — voir ÉCONOMIE plus haut.
  socket.on('use-vest', () => {
    const player = players.get(socket.id);
    if (!player || !player.alive || player.vestCount <= 0) return;
    const maxShield = maxShieldFor(player);
    if (player.shield >= maxShield) return; // bouclier déjà plein, on ne gâche pas le gilet

    player.vestCount -= 1;
    player.shield = Math.min(maxShield, player.shield + SHIELD_PER_VEST);
    io.to(socket.id).emit('your-vest-count', { count: player.vestCount });
    io.to(socket.id).emit('your-shield', { shield: player.shield });
    broadcastShieldSteps(socket.id, player);
  });

  // Ramassage d'une arme au sol (touche E, configurable — voir keybinds.js
  // côté client). `slot` (0 ou 1) est le slot sélectionné côté client au
  // moment du ramassage, utilisé seulement si le stuff est déjà plein. Comme
  // pour 'shoot', le client ne peut choisir QUE lequel de ses propres slots
  // se fait remplacer ; il ne peut ni inventer une arme ni éviter d'en
  // perdre une, donc pas besoin de s'en méfier davantage.
  socket.on('collect-weapon', ({ pickupId, slot } = {}) => {
    const player = players.get(socket.id);
    const pickup = groundWeapons.get(pickupId);
    if (!player || !player.alive || !pickup) return;

    if (!inPickupReach(player, pickup.position, WEAPON_PICKUP_RADIUS)) return;

    groundWeapons.delete(pickupId);
    io.emit('weapon-pickup-removed', { id: pickupId });

    // S'il reste un slot vide (le 1, puisque le 0 démarre toujours avec le
    // pistolet), l'arme ramassée le remplit ; sinon (stuff plein) elle
    // remplace l'arme du slot sélectionné au ramassage — y compris le
    // pistolet du slot 0, qui n'est donc pas protégé.
    const targetSlot = player.weapons[1] ? (slot === 0 || slot === 1 ? slot : 0) : 1;
    cancelReload(player, targetSlot);
    player.weapons[targetSlot] = { ...pickup.weapon };
    io.to(socket.id).emit('your-weapons', { weapons: player.weapons });
  });

  // ---------------------------------------------------------------------
  // ÉCONOMIE — achat en boutique. itemId vient du catalogue défini dans
  // src/shop.js (ex. "vest", "weapon:rifle:red", "ability-extra-vest-slot").
  // Aucune donnée de prix/effet n'est envoyée par le client : seul l'id de
  // l'objet voyage sur le réseau, le serveur retrouve le prix et l'effet
  // dans son propre catalogue (voir ÉCONOMIE plus haut).
  // ---------------------------------------------------------------------
  socket.on('buy-item', ({ itemId } = {}) => {
    const player = players.get(socket.id);
    if (!player || !player.alive || typeof itemId !== 'string') return;
    tryPurchase(socket, player, itemId);
  });

  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (!player) return;
    cancelReload(player);
    emitToIds(allyIds(socket.id), 'ping-removed', { senderId: socket.id });
    players.delete(socket.id);
    io.emit('player-left', { id: socket.id });
    broadcastScoreboard();
    console.log(`[-] ${player.pseudo} (${socket.id}) — ${players.size} joueur(s) connecté(s)`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Serveur Mini Warzone (Socket.io) lancé sur http://localhost:${PORT}`);
});