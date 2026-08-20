const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 방 상태 관리
let roomState = {
    roomCode: 'MAFIA1',
    phase: 'waiting', // waiting, day, night
    dayCount: 1,
    executedThisDay: false, // 이번 낮 처형 수행 여부
    players: {} // socketId: { id, nickname, role, isAlive, connected }
};

// 라우팅
app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/client', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

io.on('connection', (socket) => {
    // 호스트 접속
    socket.on('initHost', () => {
        socket.emit('roomUpdate', roomState);
    });

    // 닉네임 중복 체크 및 입장
    socket.on('joinGame', (data) => {
        const { nickname } = data;
        const exists = Object.values(roomState.players).some(p => p.nickname === nickname);

        if (exists) {
            socket.emit('joinResponse', { success: false, message: '이미 사용 중인 닉네임입니다.' });
            return;
        }

        roomState.players[socket.id] = {
            id: socket.id,
            nickname: nickname,
            role: null,
            isAlive: true,
            connected: true
        };

        socket.emit('joinResponse', { success: true, nickname });
        io.emit('roomUpdate', roomState);
        io.emit('systemLog', `[입장] ${nickname} 님이 접속했습니다.`);
    });

    // 게임 시작 및 직업 분배
    socket.on('startGame', (rolesPreset) => {
        const playerIds = Object.keys(roomState.players);
        if (playerIds.length === 0) return;

        // 역할 셔플
        let roles = [...rolesPreset];
        while (roles.length < playerIds.length) roles.push('시민');
        roles.sort(() => Math.random() - 0.5);

        playerIds.forEach((id, idx) => {
            roomState.players[id].role = roles[idx];
            roomState.players[id].isAlive = true;
            io.to(id).emit('roleAssigned', { role: roles[idx] });
        });

        roomState.phase = 'day';
        roomState.dayCount = 1;
        roomState.executedThisDay = false;

        io.emit('roomUpdate', roomState);
        io.emit('systemLog', `[게임 시작] 1일차 낮이 시작되었습니다.`);
    });

    // 처형 로직 (에러 반환 없이 단순 처리)
    socket.on('executePlayer', (targetId) => {
        if (roomState.players[targetId] && roomState.players[targetId].isAlive) {
            roomState.players[targetId].isAlive = false;
            roomState.executedThisDay = true;

            io.emit('roomUpdate', roomState);
            io.emit('systemLog', `[처형] ${roomState.players[targetId].nickname} 님이 처형되었습니다.`);
        }
    });

    // 페이즈 전환 (낮 <-> 밤)
    socket.on('changePhase', () => {
        if (roomState.phase === 'day') {
            roomState.phase = 'night';
            io.emit('systemLog', `[전환] 밤이 되었습니다.`);
        } else {
            roomState.phase = 'day';
            roomState.dayCount += 1;
            roomState.executedThisDay = false; // 새로운 낮에 처형 권한 리셋
            io.emit('systemLog', `[전환] ${roomState.dayCount}일차 낮이 시작되었습니다.`);
        }
        io.emit('roomUpdate', roomState);
    });

    // 리셋
    socket.on('resetGame', () => {
        roomState.phase = 'waiting';
        roomState.dayCount = 1;
        roomState.executedThisDay = false;
        Object.keys(roomState.players).forEach(id => {
            roomState.players[id].role = null;
            roomState.players[id].isAlive = true;
        });

        io.emit('roomUpdate', roomState);
        io.emit('systemLog', `[시스템] 게임이 리셋되었습니다.`);
    });

    socket.on('disconnect', () => {
        if (roomState.players[socket.id]) {
            const name = roomState.players[socket.id].nickname;
            delete roomState.players[socket.id];
            io.emit('roomUpdate', roomState);
            io.emit('systemLog', `[퇴장] ${name} 님이 나갔습니다.`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
