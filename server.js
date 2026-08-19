const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/', (req, res) => res.redirect('/play'));

let players = []; // { id, nickname, role, isAlive }
let gameState = { phase: 'lobby', dayCount: 1, votes: {}, nightActions: {} };

function resetGame() {
  gameState = { phase: 'lobby', dayCount: 1, votes: {}, nightActions: {} };
  players.forEach(p => { p.role = null; p.isAlive = true; });
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  socket.emit('init_state', { players, gameState });

  socket.on('join_game', (nickname) => {
    if (gameState.phase !== 'lobby') {
      return socket.emit('error_msg', '이미 게임이 진행 중입니다.');
    }
    const player = { id: socket.id, nickname: nickname || `플레이어_${socket.id.slice(0, 4)}`, role: null, isAlive: true };
    players.push(player);
    io.emit('update_players', players);
  });

  socket.on('start_game', (roleConfig) => {
    const totalRoles = Object.values(roleConfig).reduce((a, b) => a + b, 0);
    if (players.length === 0) return socket.emit('error_msg', '참가자가 없습니다.');
    
    let rolePool = [];
    Object.keys(roleConfig).forEach(role => {
      for (let i = 0; i < roleConfig[role]; i++) rolePool.push(role);
    });

    while (rolePool.length < players.length) rolePool.push('citizen');
    rolePool = shuffle(rolePool).slice(0, players.length);

    players.forEach((p, idx) => {
      p.role = rolePool[idx];
      p.isAlive = true;
      io.to(p.id).emit('your_role', { role: p.role, nickname: p.nickname });
    });

    gameState.phase = 'night';
    gameState.dayCount = 1;
    gameState.nightActions = {};
    io.emit('phase_change', gameState);
  });

  socket.on('night_action', ({ targetId }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;
    gameState.nightActions[player.role] = targetId;
    socket.emit('action_confirmed', targetId);
  });

  socket.on('process_night', () => {
    const mafiaTarget = gameState.nightActions['mafia'];
    const doctorTarget = gameState.nightActions['doctor'];
    let killedId = null;

    if (mafiaTarget && mafiaTarget !== doctorTarget) {
      killedId = mafiaTarget;
      const targetPlayer = players.find(p => p.id === killedId);
      if (targetPlayer) targetPlayer.isAlive = false;
    }

    gameState.phase = 'day';
    gameState.votes = {};
    io.emit('phase_change', gameState);
    io.emit('night_result', { killedId, players });
  });

  socket.on('cast_vote', (targetId) => {
    const voter = players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) return;
    gameState.votes[socket.id] = targetId;
    io.emit('update_votes', gameState.votes);
  });

  socket.on('process_vote', () => {
    const voteCounts = {};
    Object.values(gameState.votes).forEach(targetId => {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let executedId = null;
    let maxVotes = 0;
    Object.entries(voteCounts).forEach(([targetId, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        executedId = targetId;
      }
    });

    if (executedId) {
      const p = players.find(player => player.id === executedId);
      if (p) p.isAlive = false;
    }

    gameState.phase = 'night';
    gameState.dayCount += 1;
    gameState.nightActions = {};
    io.emit('phase_change', gameState);
    io.emit('vote_result', { executedId, players });
  });

  socket.on('reset_game', () => {
    resetGame();
    io.emit('game_reset', players);
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('update_players', players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
