// ---------------------------------------------------------------------------
// Serveur temps réel Mini Warzone (Socket.io)
// ---------------------------------------------------------------------------
// Rôle : synchroniser les positions des joueurs et les tirs entre tous les
// clients connectés. Ne gère PAS les comptes/amis/groupes (ça, c'est Firebase,
// côté client) — ce serveur ne connaît que des sockets et des positions.
//
// En dev : lance ce serveur séparément du client (`npm run dev` ici, dans un
// 2e terminal), pendant que le client tourne sur http://localhost:5173.
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = process.env.PORT || 3001;

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

// socket.id -> { pseudo, position: {x,y,z}, rotationY }
const players = new Map();

io.on('connection', (socket) => {
  socket.on('join', (pseudoInput) => {
    const pseudo = String(pseudoInput || 'Joueur').slice(0, 20);

    // On donne au nouveau venu la liste de ceux déjà dans l'arène...
    const existingPlayers = Array.from(players.entries()).map(([id, p]) => ({
      id,
      pseudo: p.pseudo,
      position: p.position,
      rotationY: p.rotationY,
    }));
    socket.emit('current-players', existingPlayers);

    // ...puis on l'ajoute et on prévient tout le monde.
    players.set(socket.id, {
      pseudo,
      position: { x: 0, y: 1.7, z: 5 },
      rotationY: 0,
    });

    socket.broadcast.emit('player-joined', { id: socket.id, pseudo });

    console.log(`[+] ${pseudo} (${socket.id}) — ${players.size} joueur(s) connecté(s)`);
  });

  socket.on('move', ({ position, rotationY } = {}) => {
    const player = players.get(socket.id);
    if (!player || !position) return;

    player.position = position;
    player.rotationY = rotationY || 0;

    socket.broadcast.emit('player-moved', {
      id: socket.id,
      position: player.position,
      rotationY: player.rotationY,
    });
  });

  socket.on('shoot', ({ origin, direction } = {}) => {
    if (!players.has(socket.id) || !origin || !direction) return;
    socket.broadcast.emit('player-shoot', { id: socket.id, origin, direction });
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
