// ---------------------------------------------------------------------------
// Serveur temps réel Mini Warzone (Socket.io)
// ---------------------------------------------------------------------------
// Rôle : synchroniser les positions des joueurs, les tirs, la vie et le loot
// au sol entre tous les clients connectés. Ne gère PAS les comptes/amis/
// groupes (ça, c'est Firebase, côté client) — ce serveur ne connaît que des
// sockets, des positions, et maintenant des points de vie.
//
// En dev : lance ce serveur séparément du client (`npm run dev` ici, dans un
// 2e terminal), pendant que le client tourne sur http://localhost:5173.
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT || 3001;

const MAX_HP = 100;
// Dégâts par arme (nettement réduits par rapport à l'ancien DAMAGE_PER_HIT
// fixe de 25) et cadence de tir minimale en secondes entre deux tirs — doit
// rester identique à WEAPONS dans src/main.js, le serveur ne fait jamais
// confiance au client pour les dégâts ou la cadence.
const WEAPONS = {
  pistol: { damage: 18, cooldown: 0.35 },
  smg: { damage: 10, cooldown: 0.09 },
  rifle: { damage: 16, cooldown: 0.18 },
};
const DEFAULT_WEAPON_ID = 'pistol';
const HIT_RADIUS = 0.9; // sphère approximative autour de chaque joueur
const HEAL_AMOUNT = 30;
const LOOT_COLLECT_RADIUS = 1.8;
const RESPAWN_DELAY_MS = 3000;

const TEAMS = ['red', 'blue'];

// Correspond à la salle construite côté client (buildCustomRoom dans
// src/main.js) : équipe rouge à l'ouest (x négatif), équipe bleue à l'est
// (x positif). Si tu changes la taille de la salle côté client, ajuste ces
// coordonnées en conséquence.
const TEAM_SPAWN_POINTS = {
  red: [
    { x: -11, y: 1.7, z: -6 },
    { x: -11, y: 1.7, z: 0 },
    { x: -11, y: 1.7, z: 6 },
  ],
  blue: [
    { x: 11, y: 1.7, z: -6 },
    { x: 11, y: 1.7, z: 0 },
    { x: 11, y: 1.7, z: 6 },
  ],
};

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

// socket.id -> { pseudo, position: {x,y,z}, rotationY, hp, alive }
const players = new Map();

// lootId -> { position: {x,y,z} }
const loot = new Map();

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

function findClosestHit(shooterId, origin, direction) {
  let closestId = null;
  let closestDistance = Infinity;

  players.forEach((player, id) => {
    if (id === shooterId || !player.alive) return;
    const dist = raySphereDistance(origin, direction, player.position, HIT_RADIUS);
    if (dist !== null && dist < closestDistance) {
      closestDistance = dist;
      closestId = id;
    }
  });

  return closestId;
}

function killPlayer(victimId, killerId) {
  const victim = players.get(victimId);
  if (!victim) return;

  victim.alive = false;
  victim.hp = 0;

  io.emit('player-died', { id: victimId, killedBy: killerId || null });
  io.to(victimId).emit('you-died');

  // Le stuff du joueur tombe au sol, à ramasser par n'importe qui.
  const lootId = randomUUID();
  loot.set(lootId, { position: { ...victim.position } });
  io.emit('loot-spawned', { id: lootId, position: victim.position });

  setTimeout(() => {
    if (!players.has(victimId)) return; // parti entre-temps
    const spawn = pickTeamSpawn(victim.team);
    victim.alive = true;
    victim.hp = MAX_HP;
    victim.position = spawn;
    io.to(victimId).emit('you-respawned', { position: spawn });
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
    }));
    socket.emit('current-players', existingPlayers);

    const existingLoot = Array.from(loot.entries()).map(([id, l]) => ({
      id,
      position: l.position,
    }));
    socket.emit('current-loot', existingLoot);

    // ...puis on l'ajoute et on prévient tout le monde.
    players.set(socket.id, {
      pseudo,
      team,
      position: spawn,
      rotationY: 0,
      hp: MAX_HP,
      alive: true,
    });

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

  socket.on('shoot', ({ origin, direction, weaponId } = {}) => {
    const shooter = players.get(socket.id);
    if (!shooter || !shooter.alive || !origin || !direction) return;

    const weapon = WEAPONS[weaponId] || WEAPONS[DEFAULT_WEAPON_ID];
    const now = Date.now();
    // Petite tolérance (20ms) pour la latence réseau, sans quoi une cadence
    // pile-poil correcte côté client se ferait parfois rejeter à tort.
    if (now - (shooter.lastShotAt || 0) < weapon.cooldown * 1000 - 20) return;
    shooter.lastShotAt = now;

    socket.broadcast.emit('player-shoot', { id: socket.id, origin, direction });

    const targetId = findClosestHit(socket.id, origin, direction);
    if (!targetId) return;

    const target = players.get(targetId);
    target.hp = Math.max(0, target.hp - weapon.damage);
    io.to(targetId).emit('your-hp', { hp: target.hp });
    socket.emit('hit-confirmed', { target: targetId });

    if (target.hp <= 0) {
      killPlayer(targetId, socket.id);
    }
  });

  socket.on('collect-loot', ({ lootId } = {}) => {
    const player = players.get(socket.id);
    const item = loot.get(lootId);
    if (!player || !player.alive || !item) return;

    const dx = player.position.x - item.position.x;
    const dy = player.position.y - item.position.y;
    const dz = player.position.z - item.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > LOOT_COLLECT_RADIUS) return;

    loot.delete(lootId);
    io.emit('loot-removed', { id: lootId });

    player.hp = Math.min(MAX_HP, player.hp + HEAL_AMOUNT);
    io.to(socket.id).emit('your-hp', { hp: player.hp });
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
  console.log(`Serveur Mini Warzone (Socket.io) lancé sur http://localhost:${PORT}`);
});
