// 처형 처리 (호스트 화면에만 결과 안내)
  socket.on('kill_player', (playerId) => {
    const p = players.find(item => item.id === playerId);
    if (p && p.isAlive) {
      p.isAlive = false;
      
      const roleNameMap = {
        mafia: '🔴 마피아',
        police: '🔵 경찰',
        doctor: '🟢 의사',
        medium: '🟣 영매',
        citizen: '⚪ 시민'
      };

      const revealedRole = roleNameMap[p.role] || p.role;
      const hostMsg = `투표 결과로 ${p.nickname}님이 처형되었습니다. (${p.nickname}의 직업: ${revealedRole})`;

      // 처형된 본인에게 사망 상태 알림
      io.to(p.id).emit('player_died');

      // 플레이어 리스트 상태 업데이트
      io.emit('update_players', { players, isAssigned });

      // 호스트에게만 캡처 영역 안내 문구 전달
      if (hostSocketId) {
        io.to(hostSocketId).emit('phase_change', { phase: 'DAY', resultMsg: hostMsg });
      }

      // 일반 참가자 화면에는 문구 변경 없이 낮 상태 유지
      socket.broadcast.to(hostSocketId ? undefined : '').emit('phase_change', { phase: 'DAY' });
    }
  });
