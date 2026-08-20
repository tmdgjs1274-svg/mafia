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
let inviteCode = generateInviteCode();
let isAssigned = false;
let currentPhase = 'WAITING';
let hostSocketId = null;
let hasExecutedToday = false;

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

const roleNameMap = {
  mafia: '마피아',
  police: '경찰',
  doctor: '의사',
  medium: '영매',
  citizen: '시민'
};

function generateInviteCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

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

// 방 완전 초기화 함수
function createNewRoom() {
  players = [];
  inviteCode = generateInviteCode();
  isAssigned = false;
  currentPhase = 'WAITING';
  hasExecutedToday = false;
  resetNightActions();
}

function checkWinCondition() {
  if (!isAssigned) return null;

  const alivePlayers = players.filter(p => p.role && p.isAlive && p.isConnected);
  const totalAssignedMafias = players.filter(p => p.role === 'mafia').length;

  if (totalAssignedMafias === 0) return null;

  const aliveMafias = alivePlayers.filter(p => p.role === 'mafia').length;
  const aliveCitizens = alivePlayers.length - aliveMafias;

  if (aliveMafias === 0) {
    return 'CITIZEN';
  } else if (aliveMafias >= aliveCitizens) {
    return 'MAFIA';
  }

  return null;
}

function broadcastNightStatus() {
  const alivePlayers = players.filter(p => p.isAlive && p.isConnected);
  const mafias = alivePlayers.filter(p => p.role === 'mafia');
  
  const allMafiaConfirmed = mafias.length === 0 || (
    mafias.every(m => nightActions.mafiaVotes[m.id]?.confirmed)
  );

  io.emit('night_status_update', {
    mafiaConfirmed: allMafiaConfirmed,
    doctorConfirmed: nightActions.doctorConfirmed,
    policeConfirmed: nightActions.policeConfirmed,
    mediumConfirmed: nightActions.mediumConfirmed
  });
}

io.on('connection', (socket) => {
  // 호스트 등록 및 새로고침 시 새 방 개설
  socket.on('register_host', () => {
    hostSocketId = socket.id;
    createNewRoom(); // 호스트가 접속/새로고침하면 완전 새 방으로 개설
    io.emit('roles_reset'); // 기존 연결된 참가자들 초기화
    socket.emit('init_state', { players, inviteCode, isAssigned, currentPhase });
  });

  // 호스트가 수동으로 새 방을 만드는 경우
  socket.on('create_new_room', () => {
    createNewRoom();
    io.emit('roles_reset');
    socket.emit('init_state', { players, inviteCode, isAssigned, currentPhase });
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('join_game', ({ nickname, code }) => {
    if (code !== inviteCode) return socket.emit('join_error', '초대코드가 일치하지 않거나 이전 방입니다.');
    
    const cleanName = nickname.trim();
    const existingPlayer = players.find(p => p.nickname === cleanName);

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

    if (isAssigned || currentPhase !== 'WAITING') {
      return socket.emit('join_error', '이미 게임이 시작되어 참가할 수 없습니다.');
    }

    if (existingPlayer && existingPlayer.isConnected) {
      return socket.emit('join_error', '이미 사용 중인 닉네임입니다.');
    }

    const player = { id: socket.id, nickname: cleanName, role: null, isAlive: true, isConnected: true };
    players.push(player);
    socket.emit('join_success');
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('rejoin_response', ({ requestSocketId, nickname, approved }) => {
    const player = players.find(p => p.nickname === nickname && !p.isConnected);

    if (!approved) {
      return io.to(requestSocketId).emit('join_error', '호스트가 재접속을 거절했습니다.');
    }

    if (player) {
      player.id = requestSocketId;
      player.isConnected = true;

      const mafias = players.filter(p => p.role === 'mafia').map(p => p.nickname);

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
    hasExecutedToday = false;
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

    nightActions.mafiaVotes[socket.id] = { 
      targetId, 
      confirmed: !!confirmed 
    };

    const statusData = {};
    mafias.forEach(m => {
      const vote = nightActions.mafiaVotes[m.id];
      const targetPlayer = players.find(p => p.id === vote?.targetId);
      statusData[m.nickname] = {
        targetId: vote?.targetId || null,
        targetName: targetPlayer ? targetPlayer.nickname : '선택 중...',
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
      const koreanRole = roleNameMap[target.role] || target.role;
      socket.emit('medium_result', { targetName: target.nickname, role: koreanRole });
      broadcastNightStatus();
    }
  });

  socket.on('resolve_night', () => {
    clearFakeTimers();
    currentPhase = 'DAY';
    hasExecutedToday = false;

    const mafias = players.filter(p => p.isAlive && p.isConnected && p.role === 'mafia');
    
    let mafiaTargetId = null;
    if (mafias.length > 0) {
      const votes = mafias.map(m => nightActions.mafiaVotes[m.id]).filter(Boolean);
      if (votes.length === mafias.length) {
        const allConfirmed = votes.every(v => v.confirmed);
        const firstTarget = votes[0]?.targetId;
        const isUnanimous = votes.every(v => v.targetId === firstTarget);

        if (allConfirmed && isUnanimous) {
          mafiaTargetId = firstTarget;
        }
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
    
    const winner = checkWinCondition();
    if (winner) {
      io.emit('game_over', { winner });
    } else {
      io.emit('phase_change', { phase: 'DAY', resultMsg });
    }
  });

  socket.on('kill_player', (playerId) => {
    if (currentPhase !== 'DAY') return;

    if (hasExecutedToday) {
      return socket.emit('execution_error', '이번 낮에는 이미 처형을 진행했습니다.');
    }

    const p = players.find(item => item.id === playerId);
    if (p && p.isAlive) {
      p.isAlive = false;
      hasExecutedToday = true;
      
      const sideName = (p.role === 'mafia') ? '🔴 마피아' : '⚪ 시민';
      const hostMsg = `투표 결과로 ${p.nickname}님이 처형되었습니다. (${p.nickname}의 진영: ${sideName})`;

      io.to(p.id).emit('player_died');
      io.emit('update_players', { players, isAssigned });

      const winner = checkWinCondition();

      if (hostSocketId) {
        io.to(hostSocketId).emit('phase_change', { phase: 'DAY', resultMsg: hostMsg });
        io.to(hostSocketId).emit('execution_success');
      }

      socket.broadcast.emit('phase_change', { phase: 'DAY' });

      if (winner) {
        io.emit('game_over', { winner });
      }
    }
  });

  socket.on('reset_roles', () => {
    players.forEach(p => {
      p.role = null;
      p.isAlive = true;
    });
    isAssigned = false;
    currentPhase = 'WAITING';
    hasExecutedToday = false;
    resetNightActions();
    
    io.emit('roles_reset');
    io.emit('update_players', { players, isAssigned });
  });

  socket.on('disconnect', () => {
    if (socket.id === hostSocketId) {
      hostSocketId = null;
    }

    const pIdx = players.findIndex(item => item.id === socket.id);
    if (pIdx !== -1) {
      if (!isAssigned) {
        // 게임 시작 전 연결 해제 시 아예 목록에서 제거
        players.splice(pIdx, 1);
      } else {
        // 게임 중 연결 해제 시 오프라인 처리
        players[pIdx].isConnected = false;
      }
      io.emit('update_players', { players, isAssigned });

      const winner = checkWinCondition();
      if (winner) {
        io.emit('game_over', { winner });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
