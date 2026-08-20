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
let currentPhase = 'WAITING'; // WAITING, DAY, NIGHT

// 밤 능력 관련 저장소
let nightActions = {
  mafiaVotes: {},  // { mafiaSocketId: targetSocketId }
  doctorTarget: null,
  policeTarget: null,
  mediumTarget: null
};

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function resetNightActions() {
  nightActions = { mafiaVotes: {}, doctorTarget: null, policeTarget: null, mediumTarget: null };
}

io.on('connection', (socket) => {
  socket.emit('init_state', { players, inviteCode, isAssigned, currentPhase });

  socket.on('join_game', ({ nickname, code }) => {
    if (code !== inviteCode) return socket.emit('join_error', '초대코드가 일치하지 않습니다.');
    
    const isDuplicate = players.some(p => p.nickname.trim() === nickname.trim());
    if (isDuplicate) return socket.emit('join_error', '이미 사용 중인 닉네임입니다.');

    const player = { id: socket.id, nickname: nickname.trim(), role: null, isAlive: true };
    players.push(player);
    socket.emit('join_success');
    io.emit('update_players', { players, isAssigned });
  });

  // 역할 분배
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
      io.to(p.id).emit('your_role', { 
        role: p.role, 
        isAlive: p.isAlive,
        mafiaPartners: p.role === 'mafia' ? mafias : []
      });
    });

    isAssigned = true;
    currentPhase = 'DAY';
    resetNightActions();
    io.emit('update_players', { players, isAssigned });
    io.emit('phase_change', { phase: 'DAY', msg: '게임이 시작되었습니다! 낮 토론을 시작하세요.' });
  });

  // 밤 시작 (참가자 화면 능력 활성화)
  socket.on('start_night', () => {
    currentPhase = 'NIGHT';
    resetNightActions();
    io.emit('phase_change', { phase: 'NIGHT', msg: '밤이 되었습니다. 참가자들은 휴대폰에서 능력을 사용해주세요.' });
    io.emit('night_started', { players });
  });

  // [능력 1] 마피아 실시간 투표
  socket.on('mafia_vote', ({ targetId }) => {
    nightActions.mafiaVotes[socket.id] = targetId;

    // 마피아 플레이어들에게 실시간 투표 현황 전달
    const mafias = players.filter(p => p.role === 'mafia');
    const voteStatus = Object.values(nightActions.mafiaVotes);

    mafias.forEach(m => {
      io.to(m.id).emit('mafia_vote_update', { 
        votes: nightActions.mafiaVotes,
        totalMafias: mafias.length
      });
    });
  });

  // [능력 2] 의사 살릴 사람 지목
  socket.on('doctor_select', ({ targetId }) => {
    nightActions.doctorTarget = targetId;
    socket.emit('action_confirmed', '치료 대상 선택 완료');
  });

  // [능력 3] 경찰 조사
  socket.on('police_investigate', ({ targetId }) => {
    const target = players.find(p => p.id === targetId);
    if (target) {
      const isMafia = target.role === 'mafia';
      socket.emit('police_result', { targetName: target.nickname, isMafia });
    }
  });

  // [능력 4] 영매 사망자 조사
  socket.on('medium_investigate', ({ targetId }) => {
    const target = players.find(p => p.id === targetId);
    if (target) {
      socket.emit('medium_result', { targetName: target.nickname, role: target.role });
    }
  });

  // 아침 진행 및 밤 결과 처리
  socket.on('resolve_night', () => {
    currentPhase = 'DAY';

    // 마피아 최종 타겟 산출 (가장 표를 많이 받은 타겟)
    const votes = Object.values(nightActions.mafiaVotes);
    let mafiaTargetId = null;
    if (votes.length > 0) {
      const countMap = {};
      votes.forEach(id => countMap[id] = (countMap[id] || 0) + 1);
      mafiaTargetId = Object.keys(countMap).reduce((a, b) => countMap[a] > countMap[b] ? a : b);
    }

    let resultMsg = "";
    let killedPlayer = null;

    if (mafiaTargetId) {
      if (mafiaTargetId === nightActions.doctorTarget) {
        resultMsg = "의사의 치료가 성공하여 간밤에 아무도 죽지 않았습니다!";
      } else {
        const victim = players.find(p => p.id === mafiaTargetId);
        if (victim) {
          victim.isAlive = false;
          killedPlayer = victim;
          io.to(victim.id).emit('player_died');
          resultMsg = `간밤에 ${victim.nickname}님이 마피아의 공격을 받아 사망했습니다.`;
        }
      }
    } else {
      resultMsg = "간밤에 마피아가 아무도 지목하지 않아 평화로웠습니다.";
    }

    io.emit('update_players', { players, isAssigned });
    io.emit('phase_change', { phase: 'DAY', resultMsg });
  });

  // 낮 투표 처형
  socket.on('kill_player', (playerId) => {
    const p = players.find(item => item.id === playerId);
    if (p) {
      p.isAlive = false;
      io.to(p.id).emit('player_died');
      io.emit('update_players', { players, isAssigned });
      io.emit('execution_result', { nickname: p.nickname });
    }
  });

  // 게임 리셋
  socket.on('reset_roles', () => {
    players.forEach(p => { p.role = null; p.isAlive = true; });
    isAssigned = false;
    currentPhase = 'WAITING';
    resetNightActions();
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
