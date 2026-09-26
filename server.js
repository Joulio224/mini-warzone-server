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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Toutes les données de la map (collisions, spawns d'équipe, points
// d'apparition des armes/gilets, lumières d'ambiance) viennent de ce fichier
// — plus aucune géométrie de salle codée en dur ici. Doit rester identique
// à src/map-data.json côté client. La géométrie VISIBLE, elle, vient de
// map.glb (voir src/main.js) — ce fichier ne contient que ce que le rendu
// 3D ne peut pas déduire tout seul (boîtes de collision, points de jeu).
const mapData = JSON.parse(readFileSync(new URL('./map-data.json', import.meta.url)));

const PORT = process.env.PORT || 3001;

const MAX_HP = 100;
const HIT_RADIUS = 0.35; // calé sur le rayon réel de la capsule visuelle du joueur
// Hauteurs testées le long du corps (relatives à position.y, qui est la
// hauteur des yeux) — une approximation simple d'une capsule verticale, sans
// faire de vraie géométrie de capsule côté serveur. Remplace l'ancienne
// sphère unique et bien trop large (0.9) qui faisait toucher quelqu'un même
// en visant à côté de lui.
const BODY_SAMPLE_OFFSETS = [-1.6, -1.1, -0.6, -0.1, 0.15]; // pieds -> tête
const RESPAWN_DELAY_MS = 3000;

// Bouclier (gilets pare-balle) : le "stuff" contient des gilets en réserve
// (ramassés au sol ou achetés en boutique), chacun ajouté au bouclier actif
// seulement quand le joueur choisit de l'utiliser (clic droit sur le slot
// gilets) — pas automatiquement au ramassage/achat. MAX_SHIELD_VESTS est le
// nombre de base (2) ; la capacité spéciale "3e emplacement de gilet" (voir
// ÉCONOMIE) le porte à 3 pour le joueur qui l'achète, jusqu'à la fin de la
// partie en cours. Doit rester identique à src/shop.js et src/main.js.
const SHIELD_PER_VEST = 25;
const MAX_SHIELD_VESTS = 2;
const VEST_COLLECT_RADIUS = 1.8;
const VEST_RESPAWN_MS = 25000;

// Armes ramassables au sol : le slot 0 est toujours le pistolet de départ
// (jamais perdu), le slot 1 se remplit en ramassant une arme au sol — un
// point de spawn fixe par arme (voir mapData.weaponPickups), jamais
// aléatoire. Les armes trouvées au sol sont toujours de rareté "gray" (la
// rareté supérieure ne s'obtient qu'en boutique, voir ÉCONOMIE).
const WEAPON_PICKUP_POINTS = mapData.weaponPickups;
const WEAPON_PICKUP_COLLECT_RADIUS = 1.8;
const WEAPON_PICKUP_RESPAWN_MS = 30000;

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

// Dégâts de base (palier gris) et cadence de tir par TYPE d'arme — la
// cadence ne dépend jamais de la rareté, seuls les dégâts changent. Doit
// rester identique à WEAPON_BASE dans src/shop.js. Le serveur ne fait
// jamais confiance au client pour les dégâts ou la cadence : le tir envoie
// juste un numéro de slot, le serveur regarde lui-même ce qui s'y trouve.
const WEAPON_BASE = {
  pistol: { baseDamage: 18, cooldown: 0.35 },
  smg: { baseDamage: 10, cooldown: 0.09 },
  rifle: { baseDamage: 16, cooldown: 0.18 },
};
const DEFAULT_WEAPON_ID = 'pistol';

function weaponDamage(weaponId, rarity) {
  const base = WEAPON_BASE[weaponId] || WEAPON_BASE[DEFAULT_WEAPON_ID];
  return Math.round(base.baseDamage * rarityDamageMultiplier(rarity));
}
function weaponCooldown(weaponId) {
  const base = WEAPON_BASE[weaponId] || WEAPON_BASE[DEFAULT_WEAPON_ID];
  return base.cooldown;
}

// Prix de base (palier gris) par type d'arme, et multiplicateur de PRIX par
// palier de rareté — volontairement plus agressif que le multiplicateur de
// dégâts ci-dessus, pour que le rouge reste un achat de fin de partie et pas
// un simple confort. Doit rester identique à WEAPON_BASE / RARITY_PRICE_MULTIPLIER
// dans src/shop.js.
const WEAPON_BASE_PRICE = { pistol: 90, smg: 80, rifle: 110 };
const RARITY_PRICE_MULTIPLIER = { gray: 1, blue: 2, red: 3.5 };
function weaponPrice(weaponId, rarity) {
  const base = WEAPON_BASE_PRICE[weaponId] || 100;
  return Math.round(base * (RARITY_PRICE_MULTIPLIER[rarity] ?? 1));
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
  return /^weapon:(pistol|smg|rifle):(gray|blue|red)$/.exec(itemId);
}

// Traite un achat pour `player` (déjà vérifié vivant par l'appelant). Ne
// fait RIEN silencieusement si l'achat est invalide (fonds insuffisants,
// déjà possédé, slot déjà plein…) — même logique "no-op silencieux" que le
// reste du serveur (ex. collect-vest quand la réserve est pleine) : le
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

  const weaponMatch = isWeaponItemId(itemId);
  if (weaponMatch) {
    const [, weaponId, rarity] = weaponMatch;
    const price = weaponPrice(weaponId, rarity);
    if (player.money < price) return;

    // Le pistolet occupe toujours le slot 0 (l'achat ne fait qu'améliorer sa
    // rareté) ; mitraillette/fusil vont dans le slot 1 (remplace ce qui s'y
    // trouve déjà, y compris une arme ramassée au sol).
    const slot = weaponId === 'pistol' ? 0 : 1;

    player.money -= price;
    player.weapons[slot] = { id: weaponId, rarity };
    io.to(socket.id).emit('your-money', { money: player.money });
    io.to(socket.id).emit('your-weapons', { weapons: player.weapons });
  }
}

const TEAMS = ['red', 'blue'];

// ---------------------------------------------------------------------------
// Obstacles (murs + balcon + caisses de couverture) : chargés depuis
// mapData.colliders, plus aucune géométrie codée en dur ici. Le serveur n'a
// pas de moteur 3D — juste ces boîtes, au format {minX,maxX,minY,maxY,minZ,
// maxZ}, pour empêcher les tirs de traverser murs/balcon/caisses. Le type
// "floor" (sol du balcon) ne bloque un tir qu'à sa hauteur ; les murs/caisses
// (type "wall") bloquent sur toute leur hauteur — voir rayBoxDistance juste
// en dessous, qui traite les deux de la même façon (un simple test de boîte).
const OBSTACLES = mapData.colliders;

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

function pickTeamSpawn(team) {
  const points = TEAM_SPAWN_POINTS[team] || TEAM_SPAWN_POINTS[TEAMS[0]];
  return { ...points[Math.floor(Math.random() * points.length)] };
}

// Équilibrage simple : le nouveau joueur rejoint l'équipe la moins nombreuse
// (égalité → équipe rouge).
function assignTeam() {
  const counts = { red: 0, blue: 0 };
  players.forEach((p) => {
    counts[p.team] = (counts[p.team] || 0) + 1;
  });
  return counts.red <= counts.blue ? 'red' : 'blue';
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

// Gilets pare-balle : réapparaissent tout seuls à des emplacements fixes
// (mapData.vestSpawns), après un délai.
const VEST_SPAWN_POINTS = mapData.vestSpawns;
const vests = new Map(); // vestId -> { position, spawnIndex }

function spawnVestAt(spawnIndex) {
  const vestId = randomUUID();
  const position = VEST_SPAWN_POINTS[spawnIndex];
  vests.set(vestId, { position, spawnIndex });
  io.emit('vest-spawned', { id: vestId, position });
}

// weaponPickupId -> { weaponId, position, spawnIndex }
const weaponPickups = new Map();

function spawnWeaponPickupAt(spawnIndex) {
  const pickupId = randomUUID();
  const { weaponId, x, y, z } = WEAPON_PICKUP_POINTS[spawnIndex];
  weaponPickups.set(pickupId, { weaponId, position: { x, y, z }, spawnIndex });
  io.emit('weapon-pickup-spawned', { id: pickupId, weaponId, position: { x, y, z } });
}

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

function findClosestHit(shooterId, origin, direction, maxDistance) {
  let closestId = null;
  let closestDistance = maxDistance;

  players.forEach((player, id) => {
    if (id === shooterId || !player.alive) return;
    for (const offsetY of BODY_SAMPLE_OFFSETS) {
      const center = {
        x: player.position.x,
        y: player.position.y + offsetY,
        z: player.position.z,
      };
      const dist = raySphereDistance(origin, direction, center, HIT_RADIUS);
      if (dist !== null && dist < closestDistance) {
        closestDistance = dist;
        closestId = id;
      }
    }
  });

  return closestId;
}

// Diffusé à TOUT le monde (pas juste au joueur concerné) car l'assombrissement
// du gilet doit être visible par les autres joueurs.
function broadcastShieldSteps(id, player) {
  io.emit('player-shield-steps', { id, steps: shieldSteps(player) });
}

function killPlayer(victimId, killerId) {
  const victim = players.get(victimId);
  if (!victim) return;

  victim.alive = false;
  victim.hp = 0;
  victim.shield = 0; // le gilet équipé ne survit pas à la mort
  victim.vestCount = 0; // les gilets en réserve non plus
  // maxVestSlots N'EST PAS réinitialisé : la capacité spéciale reste acquise
  // pour le reste de la partie, y compris après un respawn.
  broadcastShieldSteps(victimId, victim);

  if (killerId) {
    const killer = players.get(killerId);
    if (killer) {
      killer.money = (killer.money || 0) + KILL_REWARD;
      io.to(killerId).emit('your-money', { money: killer.money });
    }
  }

  io.emit('player-died', { id: victimId, killedBy: killerId || null });
  io.to(victimId).emit('you-died');

  setTimeout(() => {
    if (!players.has(victimId)) return; // parti entre-temps
    const spawn = pickTeamSpawn(victim.team);
    victim.alive = true;
    victim.hp = MAX_HP;
    victim.position = spawn;
    victim.weapons = [{ id: 'pistol', rarity: 'gray' }, null]; // on repart avec juste le pistolet, rareté gris
    victim.vestCount = 0;
    io.to(victimId).emit('you-respawned', { position: spawn });
    io.to(victimId).emit('your-weapons', { weapons: victim.weapons });
    io.to(victimId).emit('your-vest-count', { count: victim.vestCount });
    io.emit('player-respawned', { id: victimId, position: spawn });
  }, RESPAWN_DELAY_MS);
}

io.on('connection', (socket) => {
  socket.on('join', (pseudoInput) => {
    const pseudo = String(pseudoInput || 'Joueur').slice(0, 20);
    const team = assignTeam();
    const spawn = pickTeamSpawn(team);

    // On dit au nouveau venu quelle équipe/quel point de spawn est le sien...
    socket.emit('team-assigned', { team, spawn });

    // ...puis on lui donne la liste de ceux déjà dans l'arène, et le stuff
    // déjà au sol...
    const existingPlayers = Array.from(players.entries()).map(([id, p]) => ({
      id,
      pseudo: p.pseudo,
      team: p.team,
      position: p.position,
      rotationY: p.rotationY,
      hp: p.hp,
      shieldSteps: shieldSteps(p),
    }));
    socket.emit('current-players', existingPlayers);

    const existingVests = Array.from(vests.entries()).map(([id, v]) => ({
      id,
      position: v.position,
    }));
    socket.emit('current-vests', existingVests);

    const existingWeaponPickups = Array.from(weaponPickups.entries()).map(([id, w]) => ({
      id,
      weaponId: w.weaponId,
      position: w.position,
    }));
    socket.emit('current-weapon-pickups', existingWeaponPickups);

    // ...puis on l'ajoute et on prévient tout le monde.
    const player = {
      pseudo,
      team,
      position: spawn,
      rotationY: 0,
      hp: MAX_HP,
      shield: 0,
      weapons: [{ id: 'pistol', rarity: 'gray' }, null],
      vestCount: 0,
      maxVestSlots: MAX_SHIELD_VESTS,
      money: 0,
      alive: true,
    };
    players.set(socket.id, player);
    socket.emit('your-weapons', { weapons: player.weapons });
    socket.emit('your-vest-count', { count: 0 });
    socket.emit('your-abilities', { maxVestSlots: player.maxVestSlots });
    socket.emit('your-money', { money: player.money });

    socket.broadcast.emit('player-joined', { id: socket.id, pseudo, team, position: spawn });

    console.log(
      `[+] ${pseudo} (${socket.id}) — équipe ${team} — ${players.size} joueur(s) connecté(s)`
    );
  });

  socket.on('move', ({ position, rotationY } = {}) => {
    const player = players.get(socket.id);
    if (!player || !player.alive || !position) return;

    player.position = position;
    player.rotationY = rotationY || 0;

    socket.broadcast.emit('player-moved', {
      id: socket.id,
      position: player.position,
      rotationY: player.rotationY,
    });
  });

  // Le client envoie juste un NUMÉRO DE SLOT (0 = arme 1, 1 = arme 2), jamais
  // un identifiant d'arme ou des dégâts : le serveur regarde lui-même ce que
  // ce slot contient dans son propre état (id + rareté) pour calculer la
  // cadence et les dégâts. Impossible pour un client modifié de prétendre
  // tirer avec une arme/rareté qu'il ne possède pas vraiment.
  socket.on('shoot', ({ origin, direction, slot } = {}) => {
    const shooter = players.get(socket.id);
    if (!shooter || !shooter.alive || !origin || !direction) return;
    if (slot !== 0 && slot !== 1) return;

    const equipped = shooter.weapons[slot];
    if (!equipped) return; // rien dans ce slot

    const cooldown = weaponCooldown(equipped.id);
    const now = Date.now();
    // Petite tolérance (20ms) pour la latence réseau, sans quoi une cadence
    // pile-poil correcte côté client se ferait parfois rejeter à tort.
    if (now - (shooter.lastShotAt || 0) < cooldown * 1000 - 20) return;
    shooter.lastShotAt = now;

    const obstacleDistance = nearestObstacleDistance(origin, direction);
    socket.broadcast.emit('player-shoot', {
      id: socket.id,
      origin,
      direction,
      maxLength: Math.min(obstacleDistance, 60),
    });

    const targetId = findClosestHit(socket.id, origin, direction, obstacleDistance);
    if (!targetId) return;

    const target = players.get(targetId);
    let damage = weaponDamage(equipped.id, equipped.rarity);
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, damage);
      target.shield -= absorbed;
      damage -= absorbed;
      io.to(targetId).emit('your-shield', { shield: target.shield });
      broadcastShieldSteps(targetId, target);
    }
    target.hp = Math.max(0, target.hp - damage);
    io.to(targetId).emit('your-hp', { hp: target.hp });
    socket.emit('hit-confirmed', { target: targetId });

    if (target.hp <= 0) {
      killPlayer(targetId, socket.id);
    }
  });

  socket.on('collect-vest', ({ vestId } = {}) => {
    const player = players.get(socket.id);
    const vest = vests.get(vestId);
    if (!player || !player.alive || !vest) return;
    if (player.vestCount >= player.maxVestSlots) return; // stuff déjà plein

    const dx = player.position.x - vest.position.x;
    const dy = player.position.y - vest.position.y;
    const dz = player.position.z - vest.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > VEST_COLLECT_RADIUS) return;

    vests.delete(vestId);
    io.emit('vest-removed', { id: vestId });

    player.vestCount += 1;
    io.to(socket.id).emit('your-vest-count', { count: player.vestCount });

    setTimeout(() => spawnVestAt(vest.spawnIndex), VEST_RESPAWN_MS);
  });

  // Activation d'un gilet en réserve (clic droit avec le slot gilets
  // sélectionné) : consomme 1 gilet du stuff, ajoute au bouclier actif. Le
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

  socket.on('collect-weapon', ({ pickupId } = {}) => {
    const player = players.get(socket.id);
    const pickup = weaponPickups.get(pickupId);
    if (!player || !player.alive || !pickup) return;
    if (player.weapons[1]) return; // slot 2 déjà occupé, stuff plein pour les armes

    const dx = player.position.x - pickup.position.x;
    const dy = player.position.y - pickup.position.y;
    const dz = player.position.z - pickup.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > WEAPON_PICKUP_COLLECT_RADIUS) return;

    weaponPickups.delete(pickupId);
    io.emit('weapon-pickup-removed', { id: pickupId });

    // Les armes trouvées au sol sont toujours de rareté "gray" — la rareté
    // supérieure est réservée à la boutique (voir ÉCONOMIE).
    player.weapons[1] = { id: pickup.weaponId, rarity: 'gray' };
    io.to(socket.id).emit('your-weapons', { weapons: player.weapons });

    setTimeout(() => spawnWeaponPickupAt(pickup.spawnIndex), WEAPON_PICKUP_RESPAWN_MS);
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
    players.delete(socket.id);
    io.emit('player-left', { id: socket.id });
    console.log(`[-] ${player.pseudo} (${socket.id}) — ${players.size} joueur(s) connecté(s)`);
  });
});

httpServer.listen(PORT, () => {
  VEST_SPAWN_POINTS.forEach((_, index) => spawnVestAt(index));
  WEAPON_PICKUP_POINTS.forEach((_, index) => spawnWeaponPickupAt(index));
  console.log(`Serveur Mini Warzone (Socket.io) lancé sur http://localhost:${PORT}`);
});
