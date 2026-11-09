// ---------------------------------------------------------------------------
// Commandes d'administration (panneau admin du jeu)
// ---------------------------------------------------------------------------
// Tout ce qui permet de modifier la partie passe par ici, et par ici seulement :
// le client n'envoie QUE « telle commande sur tel joueur », jamais le résultat.
//
// Sécurité, dans l'ordre pour CHAQUE commande :
//   1. la connexion Socket.io a été authentifiée par un jeton Firebase vérifié
//      (voir io.use dans server.js) ;
//   2. le compte est relu dans Firestore (users/{uid}.admin == "true") — avec un
//      petit cache de quelques secondes pour ne pas lire à chaque clic. Retirer
//      le droit admin dans Firestore le retire donc presque aussitôt ;
//   3. un admin ne peut pas agir sur un AUTRE admin (sauf sur lui-même).
// Chaque commande est enregistrée dans un journal (console + mémoire, consultable
// dans le panneau).
// ---------------------------------------------------------------------------

const ADMIN_CHECK_CACHE_MS = 5000;
const JOURNAL_MAX = 200;
const MAX_MONEY = 2_000_000_000;
const MAX_ANNOUNCE_LENGTH = 200;

// État "mode admin" d'un joueur : nom côté client -> propriété du joueur côté serveur
const FLAG_PROPERTIES = {
  godmode: 'godmode', // insensible à tous les dégâts
  noclip: 'noclip', // traverse les murs
  fly: 'fly', // vole (pas de gravité)
  invisible: 'invisible', // invisible et intouchable pour les autres
  infiniteAmmo: 'infiniteAmmo', // munitions illimitées, sans rechargement
  oneShot: 'oneShot', // tue en un tir
  frozen: 'frozen', // ne peut plus bouger
};
const FLAG_LABELS = {
  godmode: 'Invincible',
  noclip: 'Traverse les murs',
  fly: 'Vol',
  invisible: 'Invisible',
  infiniteAmmo: 'Munitions illimitées',
  oneShot: 'Tue en un tir',
  frozen: 'Immobilisé',
};

class AdminError extends Error {}

function fail(message) {
  throw new AdminError(message);
}

function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    fail(`${label} invalide (entre ${min} et ${max}).`);
  }
  return n;
}

export function createAdminTools(ctx) {
  const {
    io,
    players,
    groundWeapons,
    groundVests,
    firebaseDb,
    WEAPON_DEFS,
    RARITIES,
    GRENADE_DEFS,
    MAX_HP,
    makeWeapon,
    killPlayer,
    respawnPlayer,
    broadcastScoreboard,
    broadcastShieldSteps,
    maxShieldFor,
    spawnGroundWeapon,
    groundHeightAt,
    pickTeamSpawn,
    resetPlayerHistory,
  } = ctx;

  const journal = []; // { t, admin, action, target, detail, ok }
  let timeOverride = null; // phase du jour imposée à tous (0..1), ou null = horloge normale
  const adminCheckCache = new Map(); // uid -> { at, isAdmin }

  // --- Vérification d'identité ---------------------------------------------
  async function isStillAdmin(socket) {
    if (!socket.data.isAdmin) return false;
    const uid = socket.data.firebaseUid;
    const cached = adminCheckCache.get(uid);
    const now = Date.now();
    if (cached && now - cached.at < ADMIN_CHECK_CACHE_MS) return cached.isAdmin;
    try {
      const doc = await firebaseDb.collection('users').doc(uid).get();
      const isAdmin = String(doc.data()?.admin).toLowerCase() === 'true';
      adminCheckCache.set(uid, { at: now, isAdmin });
      if (!isAdmin) socket.data.isAdmin = false;
      return isAdmin;
    } catch (error) {
      console.error('[ADMIN] Vérification impossible :', error.message);
      return false; // en cas de doute, on refuse
    }
  }

  // --- Ce que voit le panneau ----------------------------------------------
  function flagsOf(player) {
    const flags = {};
    Object.entries(FLAG_PROPERTIES).forEach(([name, prop]) => {
      flags[name] = Boolean(player[prop]);
    });
    flags.speed = player.speedMultiplier || 1;
    return flags;
  }

  function snapshot() {
    return Array.from(players.entries()).map(([id, p]) => ({
      id,
      uid: p.uid,
      pseudo: p.pseudo,
      isAdmin: Boolean(p.isAdmin),
      alive: p.alive,
      team: p.team,
      mode: p.mode,
      hp: p.hp,
      shield: p.shield,
      money: p.money,
      kills: p.kills,
      deaths: p.deaths,
      vestCount: p.vestCount,
      maxVestSlots: p.maxVestSlots,
      weapons: p.weapons.map((w) => (w ? { id: w.id, rarity: w.rarity, ammo: w.ammo } : null)),
      grenades: { ...p.grenades },
      position: p.position ? { x: p.position.x, y: p.position.y, z: p.position.z } : null,
      flags: flagsOf(p),
    }));
  }

  function sendPlayers(socket) {
    if (socket.data.isAdmin) socket.emit('admin-player-list', { players: snapshot(), timeOverride });
  }

  function broadcastPlayers() {
    for (const id of players.keys()) {
      const socket = io.sockets.sockets.get(id);
      if (socket?.data.isAdmin) sendPlayers(socket);
    }
  }

  // L'état "mode admin" que le client du joueur concerné doit appliquer (vol,
  // traversée des murs, vitesse, immobilisation...).
  function sendState(playerId) {
    const player = players.get(playerId);
    if (player) io.to(playerId).emit('admin-state', flagsOf(player));
  }

  function logAction(admin, action, target, detail, ok) {
    const entry = { t: Date.now(), admin: admin?.pseudo || '?', action, target: target?.pseudo || null, detail, ok };
    journal.push(entry);
    if (journal.length > JOURNAL_MAX) journal.shift();
    console.log(`[ADMIN] ${entry.admin} → ${action}${entry.target ? ` sur ${entry.target}` : ''}${detail ? ` (${detail})` : ''}${ok ? '' : ' — REFUSÉ'}`);
  }

  // --- Outils ----------------------------------------------------------------
  function weaponSlotOf(weaponId) {
    return WEAPON_DEFS[weaponId].slot;
  }

  function teleport(playerId, position) {
    const player = players.get(playerId);
    if (!player) return;
    player.position = { x: position.x, y: position.y, z: position.z };
    resetPlayerHistory(player);
    io.to(playerId).emit('admin-teleport', { position: player.position });
  }

  function setFlag(player, playerId, flag, value) {
    const prop = FLAG_PROPERTIES[flag];
    if (!prop) fail('Mode inconnu.');
    const next = typeof value === 'boolean' ? value : !player[prop];
    player[prop] = next;

    if (flag === 'invisible') {
      // Les autres joueurs masquent / réaffichent le modèle ; hitbox ignorée côté tirs
      io.except(playerId).emit('player-hidden', { id: playerId, hidden: next });
      if (!next) io.except(playerId).emit('player-moved', { id: playerId, position: player.position, rotationY: player.rotationY || 0 });
    }
    sendState(playerId);
    return next;
  }

  // Les joueurs « ordinaires » : les actions de masse destructrices (tuer, expulser,
  // immobiliser tout le monde) ne touchent jamais un administrateur, toi compris.
  function regularPlayers() {
    return Array.from(players.entries()).filter(([, p]) => !p.isAdmin);
  }

  // --- Commandes sur un joueur -------------------------------------------------
  // Chacune reçoit { admin, adminId, target, targetId, payload } et renvoie le
  // message de confirmation (ou lève fail(...)).
  const playerActions = {
    // Argent
    'give-money': ({ target, targetId, payload }) => {
      const amount = integer(payload.amount, 1, 1_000_000, 'Montant');
      target.money = Math.min(MAX_MONEY, target.money + amount);
      io.to(targetId).emit('your-money', { money: target.money });
      return `+${amount} € pour ${target.pseudo}.`;
    },
    'take-money': ({ target, targetId, payload }) => {
      const amount = integer(payload.amount, 1, 1_000_000, 'Montant');
      target.money = Math.max(0, target.money - amount);
      io.to(targetId).emit('your-money', { money: target.money });
      return `−${amount} € pour ${target.pseudo}.`;
    },
    'set-money': ({ target, targetId, payload }) => {
      target.money = integer(payload.amount, 0, MAX_MONEY, 'Montant');
      io.to(targetId).emit('your-money', { money: target.money });
      return `Argent de ${target.pseudo} fixé à ${target.money} €.`;
    },

    // Armes
    'give-weapon': ({ target, targetId, payload }) => {
      const weaponId = String(payload.weaponId || '');
      const rarity = String(payload.rarity || 'gray');
      if (!WEAPON_DEFS[weaponId]) fail('Arme invalide.');
      if (!RARITIES.includes(rarity)) fail('Rareté invalide.');
      const slot = payload.slot === undefined || payload.slot === null ? weaponSlotOf(weaponId) : integer(payload.slot, 0, 1, 'Emplacement');
      target.weapons[slot] = makeWeapon(weaponId, rarity);
      io.to(targetId).emit('your-weapons', { weapons: target.weapons });
      return `${weaponId} (${rarity}) donné à ${target.pseudo}.`;
    },
    'remove-weapon': ({ target, targetId, payload }) => {
      if (payload.slot !== undefined && payload.slot !== null) {
        const slot = integer(payload.slot, 0, 1, 'Emplacement');
        target.weapons[slot] = null;
      } else {
        const weaponId = String(payload.weaponId || '');
        if (!WEAPON_DEFS[weaponId]) fail('Arme invalide.');
        target.weapons = target.weapons.map((w) => (w?.id === weaponId ? null : w));
      }
      if (!target.weapons.some(Boolean)) target.weapons[0] = makeWeapon('pistol', 'gray'); // jamais les mains vides
      io.to(targetId).emit('your-weapons', { weapons: target.weapons });
      return `Arme retirée à ${target.pseudo}.`;
    },
    'refill-ammo': ({ target, targetId }) => {
      target.weapons.forEach((w) => {
        if (w) w.ammo = WEAPON_DEFS[w.id].magSize;
      });
      io.to(targetId).emit('your-weapons', { weapons: target.weapons });
      return `Chargeurs de ${target.pseudo} remplis.`;
    },
    'spawn-pickup': ({ target, payload }) => {
      const weaponId = String(payload.weaponId || '');
      const rarity = String(payload.rarity || 'gray');
      if (!WEAPON_DEFS[weaponId]) fail('Arme invalide.');
      if (!RARITIES.includes(rarity)) fail('Rareté invalide.');
      spawnGroundWeapon(makeWeapon(weaponId, rarity), target.position.x + 1, target.position.y - 0.7, target.position.z);
      return `${weaponId} (${rarity}) déposé à côté de ${target.pseudo}.`;
    },

    // Gilets, bouclier, grenades
    'give-vests': ({ target, targetId, payload }) => {
      const count = integer(payload.count, 0, 5, 'Nombre de gilets');
      target.vestCount = Math.min(count, target.maxVestSlots);
      io.to(targetId).emit('your-vest-count', { count: target.vestCount });
      return `${target.pseudo} a maintenant ${target.vestCount} gilet(s) en réserve.`;
    },
    'unlock-vest-slot': ({ target, targetId, payload }) => {
      target.maxVestSlots = integer(payload.slots, 2, 5, 'Emplacements');
      io.to(targetId).emit('your-abilities', { maxVestSlots: target.maxVestSlots });
      return `${target.pseudo} a ${target.maxVestSlots} emplacements de gilet.`;
    },
    'set-shield': ({ target, targetId, payload }) => {
      const max = maxShieldFor(target);
      const value = payload.full === false ? integer(payload.value, 0, max, 'Bouclier') : max;
      target.shield = value;
      io.to(targetId).emit('your-shield', { shield: target.shield });
      broadcastShieldSteps(targetId, target);
      return `Bouclier de ${target.pseudo} à ${value}/${max}.`;
    },
    'give-grenades': ({ target, targetId, payload }) => {
      const kind = String(payload.kind || '');
      if (!GRENADE_DEFS[kind]) fail('Type de grenade invalide.');
      target.grenades[kind] = integer(payload.count, 0, 9, 'Nombre');
      io.to(targetId).emit('your-grenades', { ...target.grenades });
      return `${target.pseudo} a ${target.grenades[kind]} ${kind === 'frag' ? 'grenade(s)' : 'fumigène(s)'}.`;
    },

    // Santé et vie
    'heal': ({ target, targetId }) => {
      if (!target.alive) fail('Ce joueur est mort : ressuscite-le d\'abord.');
      target.hp = MAX_HP;
      io.to(targetId).emit('your-hp', { hp: target.hp });
      return `${target.pseudo} soigné.`;
    },
    'set-hp': ({ target, targetId, payload }) => {
      if (!target.alive) fail('Ce joueur est mort.');
      target.hp = integer(payload.value, 1, MAX_HP, 'Points de vie');
      io.to(targetId).emit('your-hp', { hp: target.hp });
      return `${target.pseudo} : ${target.hp} PV.`;
    },
    'kill': ({ target, targetId }) => {
      if (!target.alive) fail('Ce joueur est déjà mort.');
      killPlayer(targetId, null, { id: 'admin', rarity: null });
      return `${target.pseudo} éliminé.`;
    },
    'revive': ({ target, targetId }) => {
      if (target.alive) fail('Ce joueur est déjà en vie.');
      respawnPlayer(targetId);
      return `${target.pseudo} ressuscité.`;
    },
    'reset-stats': ({ target }) => {
      target.kills = 0;
      target.deaths = 0;
      broadcastScoreboard();
      return `Score de ${target.pseudo} remis à zéro.`;
    },

    // Modes
    'set-flag': ({ target, targetId, payload }) => {
      const flag = String(payload.flag || '');
      const value = typeof payload.value === 'boolean' ? payload.value : undefined;
      const next = setFlag(target, targetId, flag, value);
      return `${FLAG_LABELS[flag]} : ${next ? 'activé' : 'désactivé'} pour ${target.pseudo}.`;
    },
    'set-speed': ({ target, targetId, payload }) => {
      const value = Number(payload.value);
      if (!Number.isFinite(value) || value < 0.25 || value > 5) fail('Vitesse invalide (0,25 à 5).');
      target.speedMultiplier = value;
      sendState(targetId);
      return `Vitesse de ${target.pseudo} : ×${value}.`;
    },

    // Déplacements
    'bring': ({ admin, adminId, target, targetId }) => {
      if (targetId === adminId) fail('Tu es déjà là.');
      teleport(targetId, { x: admin.position.x + 1.2, y: admin.position.y, z: admin.position.z });
      return `${target.pseudo} téléporté vers toi.`;
    },
    'goto': ({ admin, adminId, target, targetId }) => {
      if (targetId === adminId) fail('Tu es déjà là.');
      teleport(adminId, { x: target.position.x + 1.2, y: target.position.y, z: target.position.z });
      return `Téléporté vers ${target.pseudo}.`;
    },
    'tp-spawn': ({ target, targetId }) => {
      const { position } = pickTeamSpawn(target.team, target.groupId);
      teleport(targetId, position);
      return `${target.pseudo} renvoyé à son point de départ.`;
    },
    'tp-coords': ({ target, targetId, payload }) => {
      const x = Number(payload.x);
      const z = Number(payload.z);
      if (![x, z].every(Number.isFinite) || Math.abs(x) > 80 || Math.abs(z) > 80) fail('Coordonnées invalides (−80 à 80).');
      const y = groundHeightAt(x, 50, z) + 1.7;
      teleport(targetId, { x, y, z });
      return `${target.pseudo} téléporté en (${x}, ${z}).`;
    },

    // Messages et expulsion
    'message': ({ target, targetId, payload }) => {
      const text = String(payload.text || '').trim().slice(0, MAX_ANNOUNCE_LENGTH);
      if (!text) fail('Message vide.');
      io.to(targetId).emit('admin-announce', { text, private: true });
      return `Message envoyé à ${target.pseudo}.`;
    },
    'kick': ({ target, targetId, payload }) => {
      const reason = String(payload.reason || '').trim().slice(0, 120);
      kickSocket(targetId, reason);
      return `${target.pseudo} expulsé.`;
    },
  };

  function kickSocket(playerId, reason = '') {
    io.to(playerId).emit('admin-kicked', { reason });
    // laisse le temps au message d'arriver avant de couper
    setTimeout(() => io.sockets.sockets.get(playerId)?.disconnect(true), 250);
  }

  // --- Commandes pour toute la partie ---------------------------------------------
  const globalActions = {
    'announce': ({ payload, admin }) => {
      const text = String(payload.text || '').trim().slice(0, MAX_ANNOUNCE_LENGTH);
      if (!text) fail('Annonce vide.');
      io.emit('admin-announce', { text, from: admin.pseudo });
      return 'Annonce envoyée à tous les joueurs.';
    },
    'set-time': ({ payload }) => {
      if (payload.phase === null || payload.phase === undefined) {
        timeOverride = null;
      } else {
        const phase = Number(payload.phase);
        if (!Number.isFinite(phase) || phase < 0 || phase > 1) fail('Heure invalide.');
        timeOverride = phase;
      }
      io.emit('admin-time', { phase: timeOverride });
      return timeOverride === null ? 'Heure : cycle normal.' : `Heure du jour imposée (${timeOverride.toFixed(2)}).`;
    },
    'kill-all': () => {
      let n = 0;
      regularPlayers().forEach(([id, p]) => {
        if (!p.alive) return;
        killPlayer(id, null, { id: 'admin', rarity: null });
        n += 1;
      });
      return `${n} joueur(s) éliminé(s).`;
    },
    'revive-all': () => {
      let n = 0;
      players.forEach((p, id) => {
        if (p.alive) return;
        respawnPlayer(id);
        n += 1;
      });
      return `${n} joueur(s) ressuscité(s).`;
    },
    'heal-all': () => {
      players.forEach((p, id) => {
        if (!p.alive) return;
        p.hp = MAX_HP;
        io.to(id).emit('your-hp', { hp: p.hp });
      });
      return 'Tout le monde est soigné.';
    },
    'money-all': ({ payload }) => {
      const amount = integer(payload.amount, 1, 1_000_000, 'Montant');
      players.forEach((p, id) => {
        p.money = Math.min(MAX_MONEY, p.money + amount);
        io.to(id).emit('your-money', { money: p.money });
      });
      return `+${amount} € pour tous les joueurs.`;
    },
    'refill-ammo-all': () => {
      players.forEach((p, id) => {
        p.weapons.forEach((w) => {
          if (w) w.ammo = WEAPON_DEFS[w.id].magSize;
        });
        io.to(id).emit('your-weapons', { weapons: p.weapons });
      });
      return 'Chargeurs de tous les joueurs remplis.';
    },
    'freeze-all': ({ payload }) => {
      const value = payload.value !== false;
      regularPlayers().forEach(([id, p]) => {
        p.frozen = value;
        sendState(id);
      });
      return value ? 'Tous les joueurs sont immobilisés.' : 'Tous les joueurs sont libérés.';
    },
    'clear-loot': () => {
      const n = groundWeapons.size + groundVests.size;
      groundWeapons.forEach((_, id) => io.emit('weapon-pickup-removed', { id }));
      groundVests.forEach((_, id) => io.emit('vest-removed', { id }));
      groundWeapons.clear();
      groundVests.clear();
      return `${n} objet(s) au sol supprimé(s).`;
    },
    'reset-scores': () => {
      players.forEach((p) => {
        p.kills = 0;
        p.deaths = 0;
      });
      broadcastScoreboard();
      return 'Tableau des scores remis à zéro.';
    },
    'kick-all': ({ payload }) => {
      const reason = String(payload.reason || '').trim().slice(0, 120);
      let n = 0;
      regularPlayers().forEach(([id]) => {
        kickSocket(id, reason);
        n += 1;
      });
      return `${n} joueur(s) expulsé(s).`;
    },
  };

  // --- Branchement sur une connexion Socket.io -------------------------------------
  function registerSocket(socket) {
    socket.on('admin-list-players', async () => {
      if (await isStillAdmin(socket)) sendPlayers(socket);
    });

    socket.on('admin-journal', async () => {
      if (await isStillAdmin(socket)) socket.emit('admin-journal', journal.slice(-100).reverse());
    });

    socket.on('admin-action', async (payload = {}) => {
      const reply = (ok, message) => socket.emit('admin-action-result', { ok, message, action: String(payload.action || '') });
      const admin = players.get(socket.id);
      const action = String(payload.action || '');

      if (!admin || !(await isStillAdmin(socket)) || !admin.isAdmin) {
        logAction(admin, action, null, 'accès refusé', false);
        reply(false, 'Accès administrateur refusé.');
        return;
      }

      try {
        if (globalActions[action]) {
          const message = globalActions[action]({ admin, adminId: socket.id, payload });
          logAction(admin, action, null, payload.text || payload.amount || '', true);
          reply(true, message);
          broadcastPlayers();
          return;
        }

        const handler = playerActions[action];
        if (!handler) fail('Commande inconnue.');
        const targetId = String(payload.targetId || '');
        const target = players.get(targetId);
        if (!target) fail('Joueur introuvable ou déconnecté.');
        if (target.isAdmin && targetId !== socket.id) fail('Impossible d\'agir sur un autre administrateur.');
        const message = handler({ admin, adminId: socket.id, target, targetId, payload });
        logAction(admin, action, target, payload.flag || payload.weaponId || payload.amount || payload.value || '', true);
        reply(true, message);
        broadcastPlayers();
      } catch (error) {
        if (!(error instanceof AdminError)) console.error('[ADMIN] Erreur inattendue :', error);
        logAction(admin, action, null, error.message, false);
        reply(false, error instanceof AdminError ? error.message : 'Erreur interne.');
      }
    });
  }

  return {
    registerSocket,
    broadcastPlayers,
    sendPlayers,
    getTimeOverride: () => timeOverride,
    // Sert à vérifier une sanction en cours (voir io.use dans server.js)
    kickSocket,
  };
}
