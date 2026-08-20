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
let currentPhase = 'WAITING';
let hostSocketId = null; // 호스트 소켓 저장

let nightActions = {
  mafiaVotes: {},
  doctorTarget: null,
  doctorConfirmed: false,
  policeTarget: null,
  policeConfirmed: false,
  mediumTarget: null,
  mediumConfirmed: false
};

let fakeTimers = [];

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function clearFakeTimers() {
  fakeTimers.forEach(timer => clearTimeout(timer));
  fakeTimers = [];
}

function resetNightActions() {
  clearFakeTimers();
  nightActions = {
    mafiaVotes: {},
    doctorTarget: null,
    doctorConfirmed: false,
    policeTarget: null,
    policeConfirmed: false,
    mediumTarget: null,
    mediumConfirmed: false
  };
}

function getRandomDelay() {
  return Math.floor(Math.random() * 5000) + 5000;
}

function broadcastNightStatus() {
  const alivePlayers = players.filter(p => p.isAlive && p.isConnected);
  
  const mafias = alivePlayers.filter(p => p.role === 'mafia');
  const allMafiaConfirmed = mafias.length === 0 || mafias.every(m => nightActions.mafiaVotes[m.id]?.confirmed);

  io.emit('night_status_update', {
    mafiaConfirmed: allMafiaConfirmed,
    doctorConfirmed: nightActions.doctorConfirmed,
    policeConfirmed: nightActions.policeConfirmed,
    mediumConfirmed: nightActions.mediumConfirmed
  });
}

io.on('connection', (socket) => {
  // 호스트 등록
  socket.on('register_host', () => {
    hostSocketId = socket.id;
    socket.emit('init_state', { players, inviteCode, isAssigned, currentPhase });
  });

  socket.emit('init_state', { players, inviteCode, isAssigned, currentPhase });

  socket.on('join_game', ({ nickname, code }) => {
    if (code !== inviteCode) return socket.emit('join_error', '초대코드가 일치하지 않습니다.');
    
    const cleanName = nickname.trim();
    const existingPlayer = players.find(p => p.nickname === cleanName);

    // 1. 게임 진행 중 동일 닉네임 유저가 튕긴 상태(isConnected: false)일 때 -> 재접속 요청
    if (isAssigned && existingPlayer && !existingPlayer.isConnected) {
      if (hostSocketId) {
        io.to(hostSocketId).emit('rejoin_request', {
          requestSocketId: socket.id,
          nickname: cleanName,
          oldSocketId: existingPlayer.id
        });
        return socket.emit('rejoin_waiting', '호스트의 재접속 승인을 기다리는 중입니다...');
      } else {
        return socket.emit('join_error', '호스트가 연결되어 있지 않아 재접속 승인을 받을 수 없습니다.');
      }
    }

    // 2. 게임 진행 중 신규 참가 차단
    if (isAssigned || currentPhase !== 'WAITING') {
      return socket.emit('join_error', '이미 게임이 시작되어 참가할 수 없습니다.');
    }

    // 3. 중복 닉네임 차단 (대기실 상태)
    if (existingPlayer) return socket.emit('join_error', '이미 사용 중인 닉네임입니다.');

    // 신규 입장
    const player = { id: socket.id, nickname: cleanName, role: null, isAlive: true, isConnected: true };
    players.push(player);
    socket.emit('join_success');
    io.emit('update_players', { players, isAssigned });
  });

  // 호스트의 재접속 응답 처리
  socket.on('rejoin_response', ({ requestSocketId, nickname, approved }) => {
    const player = players.find(p => p.nickname === nickname && !p.isConnected);

    if (!approved) {
      return io.to(requestSocketId).emit('join_error', '호스트가 재접속을 거절했습니다.');
    }

    if (player) {
      // 기존 소켓 ID를 신규 소켓 ID로 교체하고 연결 상태 복구
      player.id = requestSocketId;
      player.isConnected = true;

      const mafias = players.filter(p => p.role === 'mafia').map(p => p.nickname);

      // 클라이언트에 복구 정보 전송
      io.to(requestSocketId).emit('rejoin_success', {
        role: player.role,
        isAlive: player.isAlive,
        currentPhase,
        mafiaPartners: player.role === 'mafia' ? mafias : []
      });

      io.emit('update_players', { players, isAssigned });
    }
  });

  socket.on('assign_roles', (roleConfig) => {
    let rolePool = [];
    Object.keys(roleConfig).forEach(role => {
      for (let i = 0; i < roleConfig[role]; i++) rolePool.push(role);
    });

    rolePool = shuffle(rolePool);

    players.forEach((p, idx) => {
      p.role = rolePool[idx] || 'citizen';
      p.isAlive = true;
    });

    const mafias = players.filter(p => p.role === 'mafia').map(p => p.nickname);

    players.forEach(p => {
      if (p.isConnected) {
        io.to(p.id).emit('your_role', { 
          role: p.role, 
          isAlive: p.isAlive,
          mafiaPartners: p.role === 'mafia' ? mafias : []
        });
      }
    });

    isAssigned = true;
    currentPhase = 'DAY';
    resetNightActions();
    io.emit('update_players', { players, isAssigned });
    io.emit('phase_change', { phase: 'DAY', msg: '게임이 시작되었습니다! 낮 토론을 진행해주세요.' });
  });

  socket.on('start_night', () => {
    currentPhase = 'NIGHT';
    resetNightActions();

    const alivePlayers = players.filter(p => p.isAlive && p.isConnected);
    const deadCount = players.filter(p => !p.isAlive).length;

    const doc = alivePlayers.find(p => p.role === 'doctor');
    const pol = alivePlayers.find(p => p.role === 'police');
    const med = alivePlayers.find(p => p.role === 'medium');

    io.emit('phase_change', { phase: 'NIGHT', msg: '밤이 되었습니다. 각 참가자는 능력을 사용하세요.' });
    io.emit('night_started', { players });
    
    broadcastNightStatus();

    if (!doc) {
      const timer = setTimeout(() => {
        nightActions.doctorConfirmed = true;
        broadcastNightStatus();
      }, getRandomDelay());
      fakeTimers.push(timer);
    }

    if (!pol) {
      const timer = setTimeout(() => {
        nightActions.policeConfirmed = true;
        broadcastNightStatus();
      }, getRandomDelay());
      fakeTimers.push(timer);
    }

    if (!med || deadCount === 0) {
      const timer = setTimeout(() => {
        nightActions.mediumConfirmed = true;
        broadcastNightStatus();
      }, getRandomDelay());
      fakeTimers.push(timer);
    }
  });

  socket.on('mafia_vote', ({ targetId, confirmed }) => {
    const mafias = players.filter(p => p.isAlive && p.isConnected && p.role === 'mafia');

    if (confirmed) {
      const currentVotes = { ...nightActions.mafiaVotes, [socket.id]: { targetId, confirmed: true } };
      const targets = mafias.map(m => currentVotes[m.id]?.targetId).filter(Boolean);

      const isAllSelected = targets.length === mafias.length;
      const isUnanimous = isAllSelected && targets.every(t => t === targetId);

      if (!isUnanimous) {
        return socket.emit('mafia_vote_error', '모든 마피아가 동일한 대상을 지목해야 확정할 수 있습니다.');
      }
    }

    nightActions.mafiaVotes[socket.id] = { targetId, confirmed };

    const statusData = {};
    mafias.forEach(m => {
      const vote = nightActions.mafiaVotes[m.id];
      const targetPlayer = players.find(p => p.id === vote?.targetId);
      statusData[m.nickname] = {
        targetName: targetPlayer ? targetPlayer.nickname : '미선택',
        confirmed: !!vote?.confirmed
      };
    });

    mafias.forEach(m => {
      io.to(m.id).emit('mafia_vote_update', { statusData });
    });

    broadcastNightStatus();
  });

  socket.on('doctor_action', ({ targetId, confirmed }) => {
    nightActions.doctorTarget = targetId;
    nightActions.doctorConfirmed = confirmed;
    broadcastNightStatus();
  });

  socket.on('police_investigate', ({ targetId }) => {
    const target = players.find(p => p.id === targetId);
    if (target) {
      const isMafia = target.role === 'mafia';
      nightActions.policeTarget = targetId;
      nightActions.policeConfirmed = true;
      socket.emit('police_result', { targetId: target.id, targetName: target.nickname, isMafia });
      broadcastNightStatus();
    }
  });

  socket.on('medium_investigate', ({ targetId }) => {
    const target = players.find(p => p.id === targetId);
    if (target) {
      nightActions.mediumTarget = targetId;
      nightActions.mediumConfirmed = true;
      socket.emit('medium_result', { targetName: target.nickname, role: target.role });
      broadcastNightStatus();
    }
  });

  socket.on('resolve_night', () => {
    clearFakeTimers();
    currentPhase = 'DAY';

    const mafias = players.filter(p => p.isAlive && p.isConnected && p.role === 'mafia');
    const votes = Object.values(nightActions.mafiaVotes);
    
    let mafiaTargetId = null;
    if (mafias.length > 0 && votes.length === mafias.length) {
      const allConfirmed = votes.every(v => v.confirmed);
      const firstTarget = votes[0]?.targetId;
      const isUnanimous = votes.every(v => v.targetId === firstTarget);

      if (allConfirmed && isUnanimous) {
        mafiaTargetId = firstTarget;
      }
    }

    let resultMsg = "";

    if (mafiaTargetId) {
      if (String(mafiaTargetId) === String(nightActions.doctorTarget)) {
        resultMsg = "의사의 신속한 치료 덕분에 간밤에 아무도 죽지 않았습니다!";
      } else {
        const victim = players.find(p => p.id === mafiaTargetId);
        if (victim) {
          victim.isAlive = false;
          io.to(victim.id).emit('player_died');
          resultMsg = `간밤에 ${victim.nickname}님이 마피아의 공격을 받아 사망했습니다.`;
        }
      }
    } else {
      resultMsg = "마피아의 의견이 일치하지 않았거나 공격하지 않아 간밤에 아무 일도 일어나지 않았습니다.";
    }

    io.emit('update_players', { players, isAssigned });
    io.emit('phase_change', { phase: 'DAY', resultMsg });
  });

  socket.on('kill_player', (playerId) => {
    const p = players.find(item => item.id === playerId);
    if (p) {
      p.isAlive = false;
      io.to(p.id).emit('player_died');
      io.emit('update_players', { players, isAssigned });
    }
  });

  socket.on('reset_roles', () => {
    players = [];
    isAssigned = false;
    currentPhase = 'WAITING';
    resetNightActions();
    
    io.emit('roles_reset');
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('disconnect', () => {
    if (socket.id === hostSocketId) {
      hostSocketId = null;
    }
    const p = players.find(item => item.id === socket.id);
    if (p) {
      p.isConnected = false;
      io.emit('update_players', { players, isAssigned });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
