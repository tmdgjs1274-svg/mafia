// server.js 중 mafia_vote 이벤트 부분

socket.on('mafia_vote', ({ targetId, confirmed, reaction }) => {
  const mafias = players.filter(p => p.isAlive && p.role === 'mafia');

  // 이전 선택과 타겟이 달라졌다면 리액션 초기화
  const prevVote = nightActions.mafiaVotes[socket.id];
  let currentReaction = reaction || null;
  
  if (prevVote && prevVote.targetId !== targetId && !reaction) {
    currentReaction = null; // 타겟 변경 시 리액션 초기화
  } else if (prevVote && prevVote.targetId === targetId && reaction === undefined) {
    currentReaction = prevVote.reaction; // 타겟 유지 시 이전 리액션 유지
  }

  nightActions.mafiaVotes[socket.id] = { 
    targetId, 
    confirmed: !!confirmed,
    reaction: currentReaction
  };

  const statusData = {};
  mafias.forEach(m => {
    const vote = nightActions.mafiaVotes[m.id];
    const targetPlayer = players.find(p => p.id === vote?.targetId);
    statusData[m.nickname] = {
      targetId: vote?.targetId || null,
      targetName: targetPlayer ? targetPlayer.nickname : '선택 중...',
      confirmed: !!vote?.confirmed,
      reaction: vote?.reaction || null
    };
  });

  mafias.forEach(m => {
    if (m.isConnected) {
      io.to(m.id).emit('mafia_vote_update', { statusData });
    }
  });

  broadcastNightStatus();
});
