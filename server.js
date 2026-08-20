// 처형 처리 (진영 단위 공개: 마피아 vs 시민)
  socket.on('kill_player', (playerId) => {
    const p = players.find(item => item.id === playerId);
    if (p && p.isAlive) {
      p.isAlive = false;
      
      // 구체적 직업 대신 진영(마피아 또는 시민)으로만 판정
      const sideName = (p.role === 'mafia') ? '🔴 마피아' : '⚪ 시민';
      const hostMsg = `투표 결과로 ${p.nickname}님이 처형되었습니다. (${p.nickname}의 진영: ${sideName})`;

      // 사망 당사자 알림
      io.to(p.id).emit('player_died');
      // 전체 플레이어 현황 업데이트
      io.emit('update_players', { players, isAssigned });

      // 호스트 화면의 상자 영역에만 메시지 송출
      if (hostSocketId) {
        io.to(hostSocketId).emit('phase_change', { phase: 'DAY', resultMsg: hostMsg });
      }

      // 일반 참가자들에게는 문구 변경 없이 낮 단계 상태만 유지
      socket.broadcast.emit('phase_change', { phase: 'DAY' });
    }
  });
