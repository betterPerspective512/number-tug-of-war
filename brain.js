// brain.js — MathTug server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Constants ────────────────────────────────────────────────
const GRACE_SECONDS = 30;
const TOTAL_QUESTIONS = 10;   // questions per round
const ANSWER_TIMEOUT  = 12;   // seconds per question
const TUG_STEPS       = 5;    // points to win (rope steps)
const COUNTDOWN_FROM  = 3;

// ─── Room Store ───────────────────────────────────────────────
const rooms = {};
const gracePending = {};

// ─── ID Helper ────────────────────────────────────────────────
function generateRoomId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ─── Question Generator ───────────────────────────────────────
//   Uses a seeded-style approach: for each question we pick
//   an operation type AND difficulty tier at random, so
//   consecutive rooms/lobbies never start with the same type.
const OPS = ['add', 'sub', 'mul', 'div', 'pow', 'sqrt', 'mod', 'mixed'];

function generateQuestion() {
    const op = OPS[Math.floor(Math.random() * OPS.length)];
    let question, answer, choices;

    switch (op) {
        case 'add': {
            const a = rnd(1, 99), b = rnd(1, 99);
            question = `${a} + ${b}`;
            answer = a + b;
            break;
        }
        case 'sub': {
            const a = rnd(10, 99), b = rnd(1, a);
            question = `${a} − ${b}`;
            answer = a - b;
            break;
        }
        case 'mul': {
            const a = rnd(2, 15), b = rnd(2, 15);
            question = `${a} × ${b}`;
            answer = a * b;
            break;
        }
        case 'div': {
            const b = rnd(2, 12), a = b * rnd(2, 12);
            question = `${a} ÷ ${b}`;
            answer = a / b;
            break;
        }
        case 'pow': {
            const base = rnd(2, 9), exp = rnd(2, 3);
            question = `${base}^${exp}`;
            answer = Math.pow(base, exp);
            break;
        }
        case 'sqrt': {
            const root = rnd(2, 12);
            const sq = root * root;
            question = `√${sq}`;
            answer = root;
            break;
        }
        case 'mod': {
            const a = rnd(10, 99), b = rnd(2, 9);
            question = `${a} mod ${b}`;
            answer = a % b;
            break;
        }
        case 'mixed': {
            // a + b * c style
            const a = rnd(1, 20), b = rnd(1, 10), c = rnd(1, 10);
            question = `${a} + ${b} × ${c}`;
            answer = a + b * c;
            break;
        }
        default: {
            const a = rnd(1, 50), b = rnd(1, 50);
            question = `${a} + ${b}`;
            answer = a + b;
        }
    }

    choices = generateChoices(answer);
    return { question, answer, choices, op };
}

function rnd(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateChoices(correct) {
    const set = new Set([correct]);
    const offsets = [
        ...shuffleArray([-3, -2, -1, 1, 2, 3, 4, -4, 5, -5, 7, -6])
    ];
    let i = 0;
    while (set.size < 4) {
        const candidate = correct + offsets[i++ % offsets.length];
        if (candidate > 0 || correct <= 0) set.add(candidate);
        else set.add(correct + Math.abs(offsets[i++ % offsets.length]));
        if (i > 50) break;
    }
    return shuffleArray([...set]);
}

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─── Room Factory ─────────────────────────────────────────────
function createRoom() {
    return {
        players: [],          // [{id, name, score, ready}]
        gameState: 'waiting', // waiting | lobby | countdown | playing | game_over
        tugPosition: 0,       // -5 to +5 (negative = p1 winning, positive = p2 winning)
        currentQuestion: null,
        questionIndex: 0,
        questionTimer: null,
        timeLeft: ANSWER_TIMEOUT,
        answeredBy: null,     // socket.id of who answered current q
        questions: [],
        pausedForDisconnect: false,
    };
}

// ─── Room Helpers ─────────────────────────────────────────────
function bothReady(room) {
    return room.players.length === 2 && room.players.every(p => p.ready);
}

function startCountdown(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.gameState = 'countdown';
    io.to(roomId).emit('gameStateUpdate', 'countdown');

    let count = COUNTDOWN_FROM;
    const tick = () => {
        if (!rooms[roomId]) return;
        if (count > 0) {
            io.to(roomId).emit('countdown', count);
            count--;
            setTimeout(tick, 1000);
        } else {
            io.to(roomId).emit('countdown', 'GO!');
            setTimeout(() => startGame(roomId), 700);
        }
    };
    setTimeout(tick, 500);
}

function startGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Pre-generate all questions for this round so they're consistent
    room.questions = Array.from({ length: TOTAL_QUESTIONS }, generateQuestion);
    room.questionIndex = 0;
    room.tugPosition = 0;
    room.players.forEach(p => { p.score = 0; });
    room.gameState = 'playing';

    io.to(roomId).emit('gameStateUpdate', 'playing');
    io.to(roomId).emit('tugUpdate', { position: 0 });
    sendNextQuestion(roomId);
}

function sendNextQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.questionIndex >= room.questions.length) {
        endGame(roomId, null);
        return;
    }

    clearTimeout(room.questionTimer);
    room.answeredBy = null;
    room.timeLeft = ANSWER_TIMEOUT;
    room.currentQuestion = room.questions[room.questionIndex];

    io.to(roomId).emit('newQuestion', {
        question: room.currentQuestion.question,
        choices: room.currentQuestion.choices,
        index: room.questionIndex,
        total: TOTAL_QUESTIONS,
        timeLeft: ANSWER_TIMEOUT
    });

    // Tick timer
    const tick = () => {
        if (!rooms[roomId] || room.answeredBy !== null) return;
        room.timeLeft--;
        io.to(roomId).emit('questionTimer', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            // Time out — emit miss, move to next
            io.to(roomId).emit('questionResult', {
                correct: false,
                correctAnswer: room.currentQuestion.answer,
                scorerId: null,
                message: '⌛ Time\'s up! No one scored.'
            });
            room.questionIndex++;
            setTimeout(() => sendNextQuestion(roomId), 1800);
        } else {
            room.questionTimer = setTimeout(tick, 1000);
        }
    };
    room.questionTimer = setTimeout(tick, 1000);
}

function endGame(roomId, forcedWinnerId) {
    const room = rooms[roomId];
    if (!room) return;
    clearTimeout(room.questionTimer);
    room.gameState = 'game_over';

    let winner = null;
    if (forcedWinnerId) {
        winner = room.players.find(p => p.id === forcedWinnerId);
    } else {
        const [p1, p2] = room.players;
        if (!p1 || !p2) return;
        if (p1.score > p2.score) winner = p1;
        else if (p2.score > p1.score) winner = p2;
        // else draw
    }

    io.to(roomId).emit('gameOver', {
        winnerId: winner ? winner.id : null,
        winnerName: winner ? winner.name : null,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
    });
}

// ─── Socket Logic ─────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.on('connect_error', (err) => console.error(err));

    // ── Create Room ──────────────────────────────────
    socket.on('createRoom', (name) => {
        if (!name?.trim()) { socket.emit('errorMsg', 'Enter a valid name.'); return; }

        const roomId = generateRoomId();
        rooms[roomId] = createRoom();
        rooms[roomId].players.push({ id: socket.id, name: name.trim(), score: 0, ready: false });

        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('roomCreated', { roomId });
        socket.emit('updateStatus', `Room ${roomId} created. Share the code!`);
        console.log(`Room ${roomId} created by ${name}`);
    });

    // ── Join Room ────────────────────────────────────
    socket.on('joinRoom', ({ name, roomId }) => {
        if (!name?.trim()) { socket.emit('errorMsg', 'Enter a valid name.'); return; }

        const clean = roomId?.trim().toUpperCase();
        const room = rooms[clean];
        if (!room) { socket.emit('errorMsg', `Room "${clean}" not found.`); return; }
        if (room.players.length >= 2) { socket.emit('errorMsg', 'Room is full!'); return; }
        if (room.gameState !== 'waiting') { socket.emit('errorMsg', 'Game already started.'); return; }

        room.players.push({ id: socket.id, name: name.trim(), score: 0, ready: false });
        socket.join(clean);
        socket.roomId = clean;

        room.gameState = 'lobby';
        io.to(clean).emit('gameStateUpdate', 'lobby');
        io.to(clean).emit('playersInfo', {
            player1: room.players[0].name,
            player2: room.players[1].name,
            p1id: room.players[0].id,
            p2id: room.players[1].id,
        });
        io.to(clean).emit('updateStatus', 'Both players in! Hit Ready when set.');
        console.log(`${name} joined room ${clean}`);
    });

    // ── Ready Up ─────────────────────────────────────
    socket.on('setReady', () => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== 'lobby') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.ready = true;

        io.to(socket.roomId).emit('readyUpdate', {
            p1ready: room.players[0]?.ready || false,
            p2ready: room.players[1]?.ready || false,
        });

        if (bothReady(room)) {
            startCountdown(socket.roomId);
        }
    });

    // ── Answer ───────────────────────────────────────
    socket.on('submitAnswer', (answer) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'playing' || room.answeredBy !== null) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const correct = answer === room.currentQuestion.answer;

        if (correct) {
            room.answeredBy = socket.id;
            clearTimeout(room.questionTimer);

            player.score++;
            // Move tug: p1 correct => position--, p2 correct => position++
            const pIdx = room.players.indexOf(player);
            room.tugPosition += (pIdx === 0 ? -1 : 1);

            io.to(roomId).emit('questionResult', {
                correct: true,
                correctAnswer: room.currentQuestion.answer,
                scorerId: socket.id,
                scorerName: player.name,
                message: `✓ ${player.name} got it!`
            });

            io.to(roomId).emit('tugUpdate', {
                position: room.tugPosition,
                scorerId: socket.id
            });

            // Check tug-win condition
            if (Math.abs(room.tugPosition) >= TUG_STEPS) {
                setTimeout(() => endGame(roomId, socket.id), 1200);
                return;
            }

            room.questionIndex++;
            setTimeout(() => sendNextQuestion(roomId), 1600);
        } else {
            // Wrong — only tell the sender
            socket.emit('wrongAnswer', { answer });
        }
    });

    // ── Play Again ───────────────────────────────────
    socket.on('playAgain', () => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== 'game_over') return;

        room.gameState = 'lobby';
        room.tugPosition = 0;
        room.questionIndex = 0;
        room.questions = [];
        room.players.forEach(p => { p.score = 0; p.ready = false; });

        io.to(socket.roomId).emit('clearBoard');
        io.to(socket.roomId).emit('gameStateUpdate', 'lobby');
        io.to(socket.roomId).emit('readyUpdate', { p1ready: false, p2ready: false });
        io.to(socket.roomId).emit('updateStatus', 'New round! Hit Ready when set.');
    });

    // ── Rejoin ───────────────────────────────────────
    socket.on('rejoinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) { socket.emit('errorMsg', 'Room no longer exists.'); return; }

        const player = room.players.find(p => p.name === playerName);
        if (!player) { socket.emit('errorMsg', 'Your slot is gone.'); return; }

        // Cancel grace
        const grace = gracePending[player.id];
        if (grace) { clearTimeout(grace.graceTimer); delete gracePending[player.id]; }

        const oldId = player.id;
        player.id = socket.id;
        socket.roomId = roomId;
        socket.join(roomId);

        console.log(`${playerName} rejoined ${roomId} (${oldId} → ${socket.id})`);

        socket.emit('rejoinSuccess', {
            gameState: room.gameState,
            player1: room.players[0]?.name,
            player2: room.players[1]?.name,
            p1id: room.players[0]?.id,
            p2id: room.players[1]?.id,
            tugPosition: room.tugPosition,
        });

        if (room.gameState === 'playing' && room.pausedForDisconnect) {
            room.pausedForDisconnect = false;
            io.to(roomId).emit('updateStatus', `${playerName} reconnected. Resuming!`);
            sendNextQuestion(roomId);
        } else {
            socket.emit('updateStatus', `Welcome back, ${playerName}!`);
        }
    });

    // ── Disconnect ───────────────────────────────────
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const isActive = room.players.length === 2 && room.gameState !== 'waiting';

        if (isActive && room.gameState !== 'game_over') {
            clearTimeout(room.questionTimer);
            room.pausedForDisconnect = true;

            io.to(roomId).emit('updateStatus', `⚠ ${player.name} disconnected. Waiting ${GRACE_SECONDS}s…`);
            io.to(roomId).emit('playerDisconnected', { playerName: player.name, graceSeconds: GRACE_SECONDS });

            gracePending[socket.id] = {
                roomId,
                playerName: player.name,
                graceTimer: setTimeout(() => {
                    delete gracePending[socket.id];
                    if (!rooms[roomId]) return;
                    room.players = room.players.filter(p => p.name !== player.name);
                    clearTimeout(room.questionTimer);
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        room.gameState = 'waiting';
                        room.pausedForDisconnect = false;
                        io.to(roomId).emit('clearBoard');
                        io.to(roomId).emit('gameStateUpdate', 'waiting');
                        io.to(roomId).emit('updateStatus', `${player.name} left. Waiting for new player…`);
                    }
                }, GRACE_SECONDS * 1000)
            };
        } else {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                room.gameState = 'waiting';
                io.to(roomId).emit('clearBoard');
                io.to(roomId).emit('gameStateUpdate', 'waiting');
                io.to(roomId).emit('updateStatus', 'Opponent left. Waiting for new player…');
            }
        }
        console.log(`Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MathTug running → http://localhost:${PORT}`));
