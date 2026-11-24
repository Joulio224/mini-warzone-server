// ---------------------------------------------------------------------------
// Bots de groupe : des « joueurs » pilotés par le serveur
// ---------------------------------------------------------------------------
// Firestore : groups/{groupId}.bots = { [botId]: { name, level } }
//             groups/{groupId}.memberTeams[botId] = 'red'|... (mode Équipes)
// Un bot est une entrée normale de `players` (id = "bot:<groupId>:<botId>") avec
// isBot = true : il apparaît donc chez les clients comme n'importe quel joueur
// (player-joined / player-moved / player-shoot / kill-feed / scoreboard...) et
// subit exactement les mêmes dégâts, la même zone, le même éliminatoire.
// Il n'a pas de socket : les io.to(botId).emit(...) du serveur tombent dans le vide.
//
// Les bots n'existent que pendant une partie lancée ET tant qu'au moins un humain
// du groupe est connecté (voir syncGroup / removeGroupBots, appelés par server.js).
// ---------------------------------------------------------------------------

const TICK_MS = 50;
const MAX_BOTS_PER_GROUP = 8;
const MAX_BOTS_TOTAL = 24;
const EYE_HEIGHT = 1.7;
const STEP_HEIGHT = 0.35;
const PLAYER_RADIUS = 0.4;
const MAP_LIMIT = 73;
const BOT_KEY_RE = /^[a-z0-9_]{3,24}$/;

// Niveaux : tout ce qui change entre « facile » et « très fort ».
//  speed        vitesse de déplacement (m/s) — le joueur marche à 5,5
//  reactionMs   délai entre le moment où il te voit et son premier tir
//  aimErrorDeg  imprécision de visée (degrés) ; augmente si la cible bouge
//  headChance   probabilité de viser la tête plutôt que le torse
//  viewRange    distance (m) à laquelle il repère un ennemi (si rien ne bloque la vue)
//  weapon       [id, rareté] de l'arme principale (le pistolet reste en slot 0)
//  shield       bouclier de départ (25 = un gilet)
//  burst        taille min/max d'une rafale ; pauseMs : pause entre deux rafales
//  strafe       se déplace latéralement pendant le combat
export const BOT_LEVELS = {
  easy: {
    label: 'Facile', speed: 3.0, reactionMs: 950, aimErrorDeg: 7.5, headChance: 0, viewRange: 30,
    weapon: null, shield: 0, burst: [1, 2], pauseMs: [800, 1500], strafe: false, preferredRange: 16,
  },
  normal: {
    label: 'Normal', speed: 3.9, reactionMs: 550, aimErrorDeg: 4.5, headChance: 0.08, viewRange: 42,
    weapon: ['smg', 'gray'], shield: 0, burst: [2, 5], pauseMs: [500, 1000], strafe: false, preferredRange: 14,
  },
  strong: {
    label: 'Fort', speed: 4.7, reactionMs: 300, aimErrorDeg: 2.2, headChance: 0.22, viewRange: 58,
    weapon: ['rifle', 'blue'], shield: 25, burst: [3, 6], pauseMs: [300, 700], strafe: true, preferredRange: 18,
  },
  insane: {
    label: 'Très fort', speed: 5.4, reactionMs: 150, aimErrorDeg: 0.9, headChance: 0.4, viewRange: 75,
    weapon: ['rifle', 'red'], shield: 50, burst: [4, 8], pauseMs: [200, 450], strafe: true, preferredRange: 20,
  },
};
export const BOT_LEVEL_IDS = Object.keys(BOT_LEVELS);

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// Palette des bots : on les reconnaît à leur couleur de haut selon le niveau.
const BOT_LEVEL_COLORS = { easy: '#5f8a4a', normal: '#4f86c6', strong: '#c8641e', insane: '#8a2f2f' };

export function createBotManager(deps) {
  const {
    io, players, groupStates, getCollisionWorld, getZoneGeometry,
    MAX_HP, HEADSHOT_MULTIPLIER, SHIELD_PER_VEST,
    makeWeapon, weaponDef, weaponDamage, falloffFactor,
    traceShotPath, dealDamage, isFriendlyFire, assignTeam, pickTeamSpawn,
    sanitizeTeamChoice, sanitizeMode, sanitizeAppearance,
    startReload, shieldSteps, broadcastShieldSteps,
    groundHeightAt, resetPlayerHistory, broadcastScoreboard, broadcastAdminPlayers,
  } = deps;

  const botIdFor = (groupId, key) => `bot:${groupId}:${key}`;
  const isBotOf = (p, groupId) => p.isBot && p.groupId === groupId;
  let timer = null;

  // --- Création / suppression ---------------------------------------------------
  function equip(bot) {
    const level = BOT_LEVELS[bot.botLevel] || BOT_LEVELS.normal;
    bot.weapons = [makeWeapon('pistol', 'gray'), level.weapon ? makeWeapon(level.weapon[0], level.weapon[1]) : null];
    bot.shield = Math.min(level.shield, SHIELD_PER_VEST * bot.maxVestSlots);
    broadcastShieldSteps(bot.id, bot);
    // L'arme la plus forte est utilisée en priorité
    bot.ai.slot = bot.weapons[1] ? 1 : 0;
  }

  function spawnBot(groupId, groupData, key, cfg) {
    const id = botIdFor(groupId, key);
    if (players.has(id)) return;
    const level = BOT_LEVEL_IDS.includes(cfg?.level) ? cfg.level : 'normal';
    const pseudo = `Bot ${String(cfg?.name || 'X').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 14) || 'X'}`;

    // Équipe : choisie dans le lobby en mode Équipes ; à défaut, équilibrage automatique
    let team;
    let mode;
    if (groupData.mode === 'team') {
      team = sanitizeTeamChoice(groupData.memberTeams?.[key]) || assignTeam();
      mode = 'team';
    } else {
      team = assignTeam();
      mode = sanitizeMode('solo', null);
    }
    const { position: spawn, spawnIndex } = pickTeamSpawn(team, groupId);
    const color = BOT_LEVEL_COLORS[level];
    const appearance = sanitizeAppearance({
      topColor: color, bottomColor: '#1c1d20', skin: '#b8bcc2', hair: 'rase', hairColor: '#1d1f22',
      headgear: 'casque', headgearColor: '#3b3f46',
    });

    const bot = {
      id,
      isBot: true,
      botKey: key,
      botLevel: level,
      uid: id,
      isAdmin: false,
      pseudo,
      team,
      mode,
      groupId,
      spawnIndex,
      appearance,
      position: spawn,
      positionHistory: [{ t: Date.now(), position: spawn }],
      rotationY: rand(0, Math.PI * 2),
      hp: MAX_HP,
      shield: 0,
      weapons: [makeWeapon('pistol', 'gray'), null],
      grenades: { frag: 0, smoke: 0 },
      reload: null,
      lastThrowAt: 0,
      lastPingAt: 0,
      vestCount: 0,
      maxVestSlots: 2,
      money: 0,
      kills: 0,
      deaths: 0,
      alive: true,
      godmode: false, noclip: false, fly: false, invisible: false,
      infiniteAmmo: false, oneShot: false, frozen: false,
      speedMultiplier: 1,
      respawnTimer: null,
      eliminated: false,
      lastDamageAt: 0,
      ai: {
        slot: 0, target: null, seenSince: 0, lastSeenAt: 0, lastSeenPos: null,
        waypoint: null, strafeDir: Math.random() < 0.5 ? 1 : -1, strafeUntil: 0,
        stuckMs: 0, burstLeft: 0, pauseUntil: 0, nextShotAt: 0, nextThinkAt: 0,
      },
    };
    players.set(id, bot);
    equip(bot);
    io.emit('player-joined', { id, pseudo, team, mode, position: spawn, appearance, groupId });
    broadcastScoreboard();
    broadcastAdminPlayers();
    startLoop();
  }

  function removeBot(id) {
    const bot = players.get(id);
    if (!bot) return;
    clearTimeout(bot.respawnTimer);
    if (bot.reload) {
      clearTimeout(bot.reload.timer);
      bot.reload = null;
    }
    players.delete(id);
    io.emit('player-left', { id });
    broadcastScoreboard();
    broadcastAdminPlayers();
  }

  function removeGroupBots(groupId) {
    Array.from(players.entries())
      .filter(([, p]) => isBotOf(p, groupId))
      .forEach(([id]) => removeBot(id));
    if (!hasBots()) stopLoop();
  }

  function hasBots() {
    for (const p of players.values()) if (p.isBot) return true;
    return false;
  }

  // Aligne les bots présents sur ce que dit Firestore (ajout / retrait / niveau / équipe).
  // À appeler quand le groupe change et quand un humain arrive.
  function syncGroup(groupId) {
    const state = groupStates.get(groupId);
    const data = state?.data;
    const humans = Array.from(players.values()).filter((p) => p.groupId === groupId && !p.isBot);
    if (!data || data.match?.status !== 'running' || state.over || humans.length === 0) {
      removeGroupBots(groupId);
      return;
    }

    const wanted = new Map();
    const raw = data.bots && typeof data.bots === 'object' ? data.bots : {};
    for (const [key, cfg] of Object.entries(raw)) {
      if (!BOT_KEY_RE.test(key) || !cfg || typeof cfg !== 'object') continue;
      if (wanted.size >= MAX_BOTS_PER_GROUP) break;
      wanted.set(key, cfg);
    }

    // Retirés ou dont le niveau / l'équipe a changé : on les recrée proprement
    players.forEach((p, id) => {
      if (!isBotOf(p, groupId)) return;
      const cfg = wanted.get(p.botKey);
      const teamWanted = data.mode === 'team' ? sanitizeTeamChoice(data.memberTeams?.[p.botKey]) : null;
      const teamChanged = data.mode === 'team' ? Boolean(teamWanted) && teamWanted !== p.team : p.mode === 'team';
      if (!cfg || cfg.level !== p.botLevel || teamChanged) removeBot(id);
    });

    let total = Array.from(players.values()).filter((p) => p.isBot).length;
    wanted.forEach((cfg, key) => {
      if (players.has(botIdFor(groupId, key))) return;
      if (total >= MAX_BOTS_TOTAL) return;
      spawnBot(groupId, data, key, cfg);
      total += 1;
    });
  }

  // Après un respawn (killPlayer → respawnPlayer remet pistolet seul) : on rééquipe.
  function onRespawn(bot) {
    if (!bot?.isBot) return;
    equip(bot);
    bot.ai.target = null;
    bot.ai.burstLeft = 0;
    bot.ai.waypoint = null;
  }

  // --- IA ------------------------------------------------------------------------
  function eyeOrigin(bot) {
    return { x: bot.position.x, y: bot.position.y, z: bot.position.z };
  }

  function hasLineOfSight(from, to, maxDist) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.01 || dist > maxDist) return false;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    return deps.nearestObstacleDistance(from, dir) >= dist - 0.4;
  }

  function isEnemy(bot, other) {
    if (other === bot || !other.alive || other.invisible || other.eliminated) return false;
    return !isFriendlyFire(bot, other);
  }

  // Cible : l'ennemi visible le plus proche dans le rayon de vue du niveau
  function acquireTarget(bot, level, now) {
    let best = null;
    let bestDist = Infinity;
    players.forEach((other, id) => {
      if (!isEnemy(bot, other)) return;
      const dist = Math.hypot(other.position.x - bot.position.x, other.position.y - bot.position.y, other.position.z - bot.position.z);
      if (dist >= bestDist || dist > level.viewRange) return;
      const chest = { x: other.position.x, y: other.position.y - 0.8, z: other.position.z };
      if (!hasLineOfSight(eyeOrigin(bot), chest, level.viewRange)) return;
      best = id;
      bestDist = dist;
    });
    const ai = bot.ai;
    if (best) {
      if (ai.target !== best) {
        ai.target = best;
        ai.seenSince = now;
        ai.burstLeft = 0;
      }
      const t = players.get(best);
      ai.lastSeenAt = now;
      ai.lastSeenPos = { x: t.position.x, z: t.position.z };
      return t;
    }
    ai.target = null;
    return null;
  }

  function targetSpeed(target) {
    const h = target.positionHistory;
    if (!h || h.length < 2) return 0;
    const a = h[Math.max(0, h.length - 4)];
    const b = h[h.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.02) return 0;
    return Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) / dt;
  }

  // Tire une rafale « un coup à la fois » : même chaîne que le handler 'shoot' de
  // server.js (cadence, chargeur, balistique, dégâts, friendly fire), avec une visée
  // imprécise selon le niveau.
  function fire(bot, level, target, now) {
    const ai = bot.ai;
    const slot = bot.weapons[ai.slot] ? ai.slot : 0;
    const weapon = bot.weapons[slot];
    if (!weapon) return;
    const def = weaponDef(weapon.id);
    if (bot.reload) return;
    if (!(weapon.ammo > 0)) {
      startReload(bot.id, slot);
      return;
    }
    if (now < ai.nextShotAt) return;
    ai.nextShotAt = now + def.cooldown * 1000 * rand(1.0, 1.25);
    bot.lastShotAt = now;
    weapon.ammo -= 1;

    const origin = eyeOrigin(bot);
    const aimHead = Math.random() < level.headChance;
    const aimPoint = {
      x: target.position.x,
      y: target.position.y - (aimHead ? 0.05 : 0.8),
      z: target.position.z,
    };
    let dx = aimPoint.x - origin.x;
    let dy = aimPoint.y - origin.y;
    let dz = aimPoint.z - origin.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist; dy /= dist; dz /= dist;

    // Imprécision : angle aléatoire qui grossit si la cible court
    const err = (level.aimErrorDeg * (1 + Math.min(targetSpeed(target), 7) * 0.18) * Math.PI) / 180;
    const aimDir = jitter({ x: dx, y: dy, z: dz }, err * Math.sqrt(Math.random()));

    const pellets = [];
    for (let i = 0; i < Math.max(1, def.pellets); i += 1) {
      pellets.push(def.pellets > 1 ? jitter(aimDir, def.spread.hip * Math.sqrt(Math.random())) : jitter(aimDir, def.spread.hip * 0.6 * Math.sqrt(Math.random())));
    }

    const perTarget = new Map();
    const tracers = [];
    pellets.forEach((dir) => {
      const path = traceShotPath(bot.id, origin, dir, def, now);
      tracers.push({ direction: dir, maxLength: path.maxLength });
      const hit = path.hit;
      if (!hit) return;
      const victim = players.get(hit.id);
      if (!victim || isFriendlyFire(bot, victim)) return;
      let damage = weaponDamage(weapon.id, weapon.rarity);
      damage = Math.round(damage * falloffFactor(def.falloff, hit.distance));
      if (hit.headshot) damage = Math.round(damage * HEADSHOT_MULTIPLIER);
      const entry = perTarget.get(hit.id) || { damage: 0, headshot: false };
      entry.damage += damage;
      entry.headshot = entry.headshot || hit.headshot;
      perTarget.set(hit.id, entry);
    });

    io.emit('player-shoot', {
      id: bot.id,
      weaponId: weapon.id,
      origin,
      direction: tracers[0].direction,
      maxLength: tracers[0].maxLength,
      shots: tracers,
    });
    const weaponForFeed = { id: weapon.id, rarity: weapon.rarity };
    perTarget.forEach((entry, targetId) => {
      dealDamage(bot.id, targetId, entry.damage, {
        headshot: entry.headshot, weapon: weaponForFeed, source: { x: origin.x, z: origin.z },
      });
    });

    ai.burstLeft -= 1;
    if (ai.burstLeft <= 0) ai.pauseUntil = now + rand(level.pauseMs[0], level.pauseMs[1]);
  }

  // Dévie un vecteur unitaire d'au plus `angle` radians (direction au hasard)
  function jitter(dir, angle) {
    if (angle <= 0) return dir;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dir.y) > 0.9) { ux = 1; uy = 0; }
    // base orthonormée (a, b) perpendiculaire à dir
    let ax = dir.y * uz - dir.z * uy;
    let ay = dir.z * ux - dir.x * uz;
    let az = dir.x * uy - dir.y * ux;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const bx = dir.y * az - dir.z * ay;
    const by = dir.z * ax - dir.x * az;
    const bz = dir.x * ay - dir.y * ax;
    const theta = Math.random() * Math.PI * 2;
    const t = Math.tan(angle);
    const ox = dir.x + (ax * Math.cos(theta) + bx * Math.sin(theta)) * t;
    const oy = dir.y + (ay * Math.cos(theta) + by * Math.sin(theta)) * t;
    const oz = dir.z + (az * Math.cos(theta) + bz * Math.sin(theta)) * t;
    const len = Math.hypot(ox, oy, oz) || 1;
    return { x: ox / len, y: oy / len, z: oz / len };
  }

  function randomWaypoint(bot) {
    for (let i = 0; i < 12; i += 1) {
      const x = rand(-MAP_LIMIT + 3, MAP_LIMIT - 3);
      const z = rand(-MAP_LIMIT + 3, MAP_LIMIT - 3);
      // On évite les points « dans le vide » : il faut un sol praticable
      const floor = groundHeightAt(x, bot.position.y - EYE_HEIGHT + 1.0, z);
      if (Math.abs(floor - (bot.position.y - EYE_HEIGHT)) < 3) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  // Déplacement horizontal avec collisions murs (même slideMove que le client) et marches
  function moveBot(bot, dirX, dirZ, speed, dt) {
    const footY = bot.position.y - EYE_HEIGHT;
    const prevX = bot.position.x;
    const prevZ = bot.position.z;
    let newX = prevX + dirX * speed * dt;
    let newZ = prevZ + dirZ * speed * dt;
    newX = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, newX));
    newZ = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, newZ));
    const world = getCollisionWorld();
    if (world) {
      const slid = world.slideMove(prevX, prevZ, newX, newZ, footY + STEP_HEIGHT, bot.position.y - 0.15, PLAYER_RADIUS);
      newX = slid.x;
      newZ = slid.z;
    }
    const floor = groundHeightAt(newX, footY + 1.0, newZ);
    if (floor - footY > 0.6) return 0; // trop haut pour être enjambé : on reste là
    bot.position = { x: newX, y: floor + EYE_HEIGHT, z: newZ };
    return Math.hypot(newX - prevX, newZ - prevZ);
  }

  function updateBot(bot, now, dt) {
    const ai = bot.ai;
    const level = BOT_LEVELS[bot.botLevel] || BOT_LEVELS.normal;
    if (!bot.alive || bot.frozen) return;

    const target = acquireTarget(bot, level, now);
    let goal = null;
    let speedFactor = 1;
    let faceX = null;
    let faceZ = null;
    let strafe = 0;

    // 1) Zone qui rétrécit : on y retourne en priorité
    const zoneState = groupStates.get(bot.groupId)?.zone;
    if (zoneState) {
      const g = getZoneGeometry();
      const out = Math.hypot(bot.position.x - g.cx, bot.position.z - g.cz) - (zoneState.radius - 4);
      if (out > 0) {
        goal = { x: g.cx, z: g.cz };
        speedFactor = 1.15;
      }
    }

    if (target) {
      faceX = target.position.x;
      faceZ = target.position.z;
      const dx = target.position.x - bot.position.x;
      const dz = target.position.z - bot.position.z;
      const dist = Math.hypot(dx, dz);
      if (!goal) {
        if (dist > level.preferredRange + 4) goal = { x: target.position.x, z: target.position.z };
        else if (dist < 6) { goal = { x: bot.position.x - dx, z: bot.position.z - dz }; speedFactor = 0.8; }
        else if (level.strafe) {
          if (now > ai.strafeUntil) { ai.strafeDir = -ai.strafeDir; ai.strafeUntil = now + rand(600, 1600); }
          strafe = ai.strafeDir;
        }
      }
      // Tir : réaction écoulée, rafale en cours
      if (now - ai.seenSince >= level.reactionMs && now >= ai.pauseUntil) {
        if (ai.burstLeft <= 0) ai.burstLeft = randInt(level.burst[0], level.burst[1]);
        fire(bot, level, target, now);
      }
    } else {
      // Plus de cible : recharger si le chargeur est bien entamé
      const w = bot.weapons[ai.slot];
      if (w && !bot.reload && w.ammo < weaponDef(w.id).magSize * 0.5) startReload(bot.id, ai.slot);
      if (!goal && ai.lastSeenPos && now - ai.lastSeenAt < 4000) goal = ai.lastSeenPos;
    }

    if (!goal && !strafe) {
      if (!ai.waypoint || Math.hypot(ai.waypoint.x - bot.position.x, ai.waypoint.z - bot.position.z) < 2.5) ai.waypoint = randomWaypoint(bot);
      goal = ai.waypoint;
      speedFactor = 0.85;
    }

    let dirX = 0;
    let dirZ = 0;
    if (strafe && faceX !== null) {
      const toX = faceX - bot.position.x;
      const toZ = faceZ - bot.position.z;
      const len = Math.hypot(toX, toZ) || 1;
      dirX = (-toZ / len) * strafe;
      dirZ = (toX / len) * strafe;
    } else if (goal) {
      const toX = goal.x - bot.position.x;
      const toZ = goal.z - bot.position.z;
      const len = Math.hypot(toX, toZ);
      if (len > 0.3) { dirX = toX / len; dirZ = toZ / len; }
    }

    if (dirX !== 0 || dirZ !== 0) {
      // Bloqué contre un mur : on tente de contourner, puis on change de destination
      const intended = level.speed * speedFactor * dt;
      let moved = moveBot(bot, dirX, dirZ, level.speed * speedFactor, dt);
      if (moved < intended * 0.35) {
        const side = ai.strafeDir;
        moved = Math.max(moved, moveBot(bot, -dirZ * side, dirX * side, level.speed * speedFactor, dt));
        ai.stuckMs += dt * 1000;
        if (ai.stuckMs > 700) {
          ai.waypoint = randomWaypoint(bot);
          ai.strafeDir = -ai.strafeDir;
          ai.stuckMs = 0;
        }
      } else {
        ai.stuckMs = 0;
      }
    }

    // Orientation : vers la cible, sinon vers où il marche
    let lookX = dirX;
    let lookZ = dirZ;
    if (faceX !== null) { lookX = faceX - bot.position.x; lookZ = faceZ - bot.position.z; }
    if (lookX !== 0 || lookZ !== 0) {
      const wanted = Math.atan2(-lookX, -lookZ);
      let diff = wanted - bot.rotationY;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      bot.rotationY += diff * Math.min(1, dt * 10);
    }

    bot.positionHistory.push({ t: now, position: bot.position });
    const cutoff = now - 400;
    while (bot.positionHistory.length > 1 && bot.positionHistory[0].t < cutoff) bot.positionHistory.shift();

    io.emit('player-moved', { id: bot.id, position: bot.position, rotationY: bot.rotationY });
  }

  let lastTick = 0;
  function tick() {
    const now = Date.now();
    const dt = Math.min(0.2, (now - (lastTick || now - TICK_MS)) / 1000);
    lastTick = now;
    players.forEach((p) => {
      if (p.isBot) {
        try { updateBot(p, now, dt); } catch (error) { console.error('[bot] erreur IA :', error); }
      }
    });
  }

  function startLoop() {
    if (timer) return;
    lastTick = 0;
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  }
  function stopLoop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { syncGroup, removeGroupBots, onRespawn, BOT_LEVELS };
}
