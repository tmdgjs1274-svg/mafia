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

let players = [];
let inviteCode = Math.random().toString(36).substring(2, 6).toUpperCase();
let isAssigned = false;

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  socket.emit('init_state', { players, inviteCode, isAssigned });

  socket.on('join_game', ({ nickname, code }) => {
    if (code !== inviteCode) {
      return socket.emit('join_error', '초대코드가 일치하지 않습니다.');
    }
    
    const isDuplicate = players.some(p => p.nickname.trim() === nickname.trim());
    if (isDuplicate) {
      return socket.emit('join_error', '이미 사용 중인 닉네임입니다.');
    }

    const player = { id: socket.id, nickname: nickname.trim(), role: null };
    players.push(player);
    socket.emit('join_success');
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('assign_roles', (roleConfig) => {
    let rolePool = [];
    Object.keys(roleConfig).forEach(role => {
      for (let i = 0; i < roleConfig[role]; i++) rolePool.push(role);
    });

    rolePool = shuffle(rolePool);

    players.forEach((p, idx) => {
      p.role = rolePool[idx] || 'citizen';
      io.to(p.id).emit('your_role', { role: p.role });
    });

    isAssigned = true;
    io.emit('roles_assigned', { players, isAssigned });
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('reset_roles', () => {
    players.forEach(p => p.role = null);
    isAssigned = false;
    io.emit('roles_reset', { players, isAssigned });
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('update_players', { players, isAssigned });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
