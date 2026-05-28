/**
 * 传画接龙 — 后端服务器
 * Express + Socket.IO 实现多人联机绘画猜词接力游戏
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const words = require('./words');
const wordLibraries = words.libraries || [];
let currentWordLib = '【简体中文】默认'; // 当前活动的词库名称

// ============================================================
// Express 配置
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024 // 5MB 限制，用于画作 base64
});

app.use(express.static('public'));

// ============================================================
// 内存数据存储
// ============================================================
const rooms = new Map(); // roomId -> Room 对象

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

function getRandomWords(count) {
  const shuffled = [...words].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function pickRandomWord() {
  return words[Math.floor(Math.random() * words.length)];
}

// ============================================================
// 链条生成算法
// ============================================================
function generateChains(players) {
  const N = players.length;
  const K = Math.floor(N / 2);
  const chains = [];

  for (let i = 0; i < N; i++) {
    const steps = [];
    for (let j = 0; j < 2 * K; j++) {
      const playerIndex = (i + j) % N;
      steps.push({
        playerId: players[playerIndex].id,
        nickname: players[playerIndex].nickname,
        type: j % 2 === 0 ? 'draw' : 'guess'
      });
    }
    chains.push({
      startPlayerId: players[i].id,
      startNickname: players[i].nickname,
      steps
    });
  }
  return { chains, K };
}

// ============================================================
// 房间对象工厂
// ============================================================
function createRoom(id, socket, nickname, password) {
  return {
    id,
    name: `${nickname}的房间`,
    password: password || null,
    players: [{
      id: socket.id,
      nickname,
      isOwner: true,
      connected: true
    }],
    state: 'lobby',
    config: {
      drawTime: 60,
      guessTime: 20,
      wordLib: '【简体中文】默认'
    },
    K: 0,
    chains: [],
    currentRound: 0,
    currentChainIndex: 0,
    reviewStepIndex: 0,
    timer: null,
    // 选词
    wordCandidates: new Map(), // playerId -> [word1, word2, word3]
    selectedWords: new Map(),   // playerId -> word
    // 每轮提交跟踪
    submissions: new Set(),     // 当前轮已提交 playerId
    // 存储所有画作和猜词 [chainIndex][stepIndex]
    chainDrawings: [], // 偶数步骤的画作
    chainGuesses: [],  // 奇数步骤的猜测
    // 投票
    votesAccuracy: new Map(),   // playerId -> 'correct'|'incorrect'
    votesArtwork: new Map(),    // playerId -> votedPlayerId
    scoreA: new Map(),          // playerId -> 准确度得分(被投√)
    scoreB: new Map(),          // playerId -> 画作得分(被投)
    // 聊天记录
    chat: []
  };
}

// ============================================================
// 广播辅助
// ============================================================
function broadcastRoomUpdate(room) {
  const data = {
    id: room.id,
    name: room.name,
    players: room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      isOwner: p.isOwner,
      connected: p.connected,
      settling: p.settling || false
    })),
    state: room.state,
    config: room.config,
    K: room.K,
    wordLibs: wordLibraries,
    chat: room.chat.slice(-50) // 最近50条聊天
  };
  io.to(room.id).emit('room_update', data);
}

function systemToast(room, message, duration = 3000) {
  io.to(room.id).emit('system_toast', { message, duration });
}

// ============================================================
// 倒计时管理
// ============================================================
function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

// ============================================================
// 下一阶段推进
// ============================================================
function nextStage(room) {
  clearRoomTimer(room);
  room.submissions = new Set();

  const totalRounds = 2 * room.K;
  const round = room.currentRound;

  // 判断是否所有轮次已完成
  if (round >= totalRounds) {
    startReviewPhase(room);
    return;
  }

  const isDraw = round % 2 === 0;
  room.state = isDraw ? `draw_${round}` : `guess_${round}`;

  // 为每个玩家计算本轮任务
  const roundType = isDraw ? 'draw' : 'guess';
  const timeout = isDraw ? room.config.drawTime : room.config.guessTime;

  // 广播 round_start 给对应玩家
  const chainStepIndex = Math.floor(round / 2); // 第几次画或猜

  room.chains.forEach((chain, chainIndex) => {
    const step = chain.steps[round];
    if (!step) return;

    const playerSocket = findPlayerSocket(step.playerId);
    if (!playerSocket) return;

    if (isDraw) {
      // 作画轮：发送要画的词
      // 找出本轮用作画这个词
      let wordToDraw;
      if (round === 0) {
        // 第一轮作画：使用起点选择的词
        wordToDraw = room.selectedWords.get(chain.startPlayerId) || pickRandomWord();
      } else {
        // 后续作画轮：使用上一步猜词结果
        const prevGuess = room.chainGuesses[chainIndex] && room.chainGuesses[chainIndex][chainStepIndex - 1];
        wordToDraw = prevGuess ? prevGuess.word : pickRandomWord();
      }

      // 保存这个词到 chainDrawings 的元数据中
      if (!room.chainDrawings[chainIndex]) room.chainDrawings[chainIndex] = [];
      room.chainDrawings[chainIndex][chainStepIndex] = { word: wordToDraw, data: null };

      playerSocket.emit('round_start', {
        round: round + 1,
        totalRounds,
        type: 'draw',
        timeout,
        yourTask: { word: wordToDraw },
        chainIndex
      });
    } else {
      // 猜词轮：发送上家画作
      const prevDraw = room.chainDrawings[chainIndex] && room.chainDrawings[chainIndex][chainStepIndex];
      const imageData = prevDraw ? prevDraw.data : null;

      playerSocket.emit('round_start', {
        round: round + 1,
        totalRounds,
        type: 'guess',
        timeout,
        yourTask: {
          imageBase64: imageData,
          fromPlayer: chain.steps[round - 1].nickname
        },
        chainIndex
      });
    }
  });

  // 广播轮次开始（不含具体内容）
  io.to(room.id).emit('system_toast', {
    message: `第 ${round + 1}/${totalRounds} 轮 — ${isDraw ? '✏️ 作画' : '💭 猜词'}开始！`,
    duration: 3000
  });

  // 设置超时
  room.timer = setTimeout(() => {
    handleRoundTimeout(room);
  }, timeout * 1000);
}

// 查找玩家 socket（通过房间内玩家 id 查找）
function findPlayerSocket(playerId) {
  for (const [sid, socket] of io.of('/').sockets) {
    if (sid === playerId) return socket;
  }
  return null;
}

// ============================================================
// 轮次超时处理
// ============================================================
function handleRoundTimeout(room) {
  const isDraw = room.currentRound % 2 === 0;
  const round = room.currentRound;
  const chainStepIndex = Math.floor(round / 2);

  // 对未提交的玩家做自动处理
  room.chains.forEach((chain, chainIndex) => {
    const step = chain.steps[round];
    if (!step) return;

    if (!room.submissions.has(step.playerId)) {
      if (isDraw) {
        // 自动提交空白画布
        if (!room.chainDrawings[chainIndex]) room.chainDrawings[chainIndex] = [];
        if (!room.chainDrawings[chainIndex][chainStepIndex] ||
            room.chainDrawings[chainIndex][chainStepIndex].data === null) {
          // 创建一个空白画布的 base64
          const blankDataUrl = createBlankCanvas();
          if (!room.chainDrawings[chainIndex]) room.chainDrawings[chainIndex] = [];
          room.chainDrawings[chainIndex][chainStepIndex] = {
            word: room.chainDrawings[chainIndex][chainStepIndex]?.word || pickRandomWord(),
            data: blankDataUrl
          };
        }
      } else {
        // 自动猜词：随机选一个
        const guessedWord = pickRandomWord();
        if (!room.chainGuesses[chainIndex]) room.chainGuesses[chainIndex] = [];
        room.chainGuesses[chainIndex][chainStepIndex] = {
          word: guessedWord,
          playerId: step.playerId,
          nickname: step.nickname,
          isSystemGenerated: true,
          isTimeout: true
        };
      }
      room.submissions.add(step.playerId);
    }
  });

  advanceToNextRound(room);
}

// ============================================================
// 进入下一轮
// ============================================================
function advanceToNextRound(room) {
  clearRoomTimer(room);
  io.to(room.id).emit('round_end');
  room.currentRound++;
  nextStage(room);
}

// 生成空白画布的 base64
function createBlankCanvas() {
  // 简单的纯白画布 base64 (1x1 white pixel PNG)
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
}

// ============================================================
// 回顾阶段
// ============================================================
function emitReviewStep(room, data) {
  if (!room.reviewLog) room.reviewLog = [];
  room.reviewLog.push(JSON.parse(JSON.stringify(data)));
  io.to(room.id).emit('review_step', data);
}

function startReviewPhase(room) {
  room.state = 'review';
  room.currentChainIndex = 0;
  room.reviewStepIndex = 0;

  io.to(room.id).emit('review_start', {
    totalChains: room.chains.length
  });
  systemToast(room, '📜 所有轮次结束，开始回顾链条！', 3000);

  // 延迟一点开始回顾
  setTimeout(() => {
    processNextReviewStep(room);
  }, 2000);
}

function processNextReviewStep(room) {
  // 防止旧游戏的残留定时器干扰新游戏
  if (room.state !== 'review') return;
  if (room.currentChainIndex >= room.chains.length) {
    // 所有链条回顾完毕，进入结算
    finishGame(room);
    return;
  }

  const chain = room.chains[room.currentChainIndex];
  const totalSteps = chain.steps.length;

  // 发送回顾步骤
  if (room.reviewStepIndex === 0) {
    // 链条开场
    emitReviewStep(room, {
      chainIndex: room.currentChainIndex,
      totalChains: room.chains.length,
      stepIndex: 0,
      type: 'chain_intro',
      data: {
        startPlayer: chain.startNickname,
        chainLength: totalSteps
      }
    });
    room.reviewStepIndex++;
    scheduleNextReview(room, 6000);
    return;
  }

  if (room.reviewStepIndex === 1) {
    // 初始词 + 发起者画作
    const initWord = room.chainDrawings[room.currentChainIndex]?.[0]?.word || '（未知）';
    const initDrawing = room.chainDrawings[room.currentChainIndex]?.[0]?.data || null;

    emitReviewStep(room, {
      chainIndex: room.currentChainIndex,
      totalChains: room.chains.length,
      stepIndex: 1,
      type: 'init_word_and_draw',
      data: {
        word: initWord,
        drawing: initDrawing,
        player: room.chainDrawings[room.currentChainIndex]?.[0]
          ? chain.steps[0].nickname : chain.startNickname
      }
    });
    room.reviewStepIndex++;
    scheduleNextReview(room, 6000);
    return;
  }

  // 后续步骤：交替展示猜词和画作
  const stepIdx = room.reviewStepIndex;
  const chainStepIdx = stepIdx - 1; // 对应 chain.steps 中的索引

  if (chainStepIdx < totalSteps) {
    const step = chain.steps[chainStepIdx];
    const isDraw = step.type === 'draw';
    const isLastStep = chainStepIdx === totalSteps - 1;

    if (isDraw) {
      // 展示画作
      const drawIndex = Math.floor(chainStepIdx / 2);
      const drawData = room.chainDrawings[room.currentChainIndex]?.[drawIndex];
      emitReviewStep(room, {
        chainIndex: room.currentChainIndex,
        totalChains: room.chains.length,
        stepIndex: stepIdx,
        type: isLastStep ? 'final_draw' : 'draw_step',
        data: {
          word: drawData?.word || '（未知）',
          drawing: drawData?.data || null,
          player: step.nickname
        }
      });
    } else {
      // 展示猜词
      const guessIndex = Math.floor((chainStepIdx - 1) / 2);
      const guessData = room.chainGuesses[room.currentChainIndex]?.[guessIndex];
      const isSystem = guessData?.isSystemGenerated || false;

      emitReviewStep(room, {
        chainIndex: room.currentChainIndex,
        totalChains: room.chains.length,
        stepIndex: stepIdx,
        type: isLastStep ? 'final_guess' : (isSystem ? 'guess_timeout' : 'guess_normal'),
        data: {
          word: guessData?.word || '（未知）',
          player: step.nickname,
          isSystemGenerated: isSystem,
          drawing: null
        }
      });
    }

    room.reviewStepIndex++;

    if (isLastStep) {
      // 最后一步停留后进入投票（不调 scheduleNextReview，否则会重置重播一遍）
      room.reviewStepIndex = 0;
      const nextChain = room.currentChainIndex + 1;
      if (nextChain <= room.chains.length) {
        setTimeout(() => {
          startVotingPhase(room);
        }, 6000);
      }
    } else {
      scheduleNextReview(room, 6000);
    }
  } else {
    // 所有步骤已展示，进入投票
    startVotingPhase(room);
  }
}

function scheduleNextReview(room, delay) {
  setTimeout(() => {
    processNextReviewStep(room);
  }, delay);
}

// ============================================================
// 投票阶段
// ============================================================
function startVotingPhase(room) {
  if (room.state !== 'review') return;
  const chainIndex = room.currentChainIndex;

  // 重置投票
  room.votesAccuracy = new Map();
  room.votesArtwork = new Map();

  // 获取最终结果数据
  const chain = room.chains[chainIndex];
  const initWord = room.chainDrawings[chainIndex]?.[0]?.word || '';

  const totalSteps = chain.steps.length;
  const lastStep = chain.steps[totalSteps - 1];
  let finalGuess = '';
  let isSystem = false;

  if (lastStep.type === 'guess') {
    const guessIndex = Math.floor((totalSteps - 2) / 2);
    const guessData = room.chainGuesses[chainIndex]?.[guessIndex];
    finalGuess = guessData?.word || '';
    isSystem = guessData?.isSystemGenerated || false;
  }

  room.votePhase = 'accuracy';
  // Step 1: 正误投票 (20s)
  io.to(room.id).emit('vote_request', {
    type: 'accuracy',
    chainIndex,
    timeout: 20,
    data: {
      initWord,
      finalGuess,
      isSystemGenerated: isSystem,
      drawerNickname: lastStep?.nickname || ''
    }
  });

  systemToast(room, `🔍 为链条 ${chainIndex + 1} 的最终猜词投票！`, 3000);

  room.timerStart = Date.now();
  room.timer = setTimeout(() => {
    handleAccuracyVoteTimeout(room);
  }, 20000);
}

function handleAccuracyVoteTimeout(room) {
  clearRoomTimer(room);

  // 计算正误投票结果
  let correctVotes = 0;
  const chainIndex = room.currentChainIndex;
  room.votesAccuracy.forEach((vote) => {
    if (vote === 'correct') correctVotes++;
  });

  // 为最后猜词者加分 a = 每票 1 分
  const chain = room.chains[chainIndex];
  const lastStep = chain.steps[chain.steps.length - 1];
  const guesserId = lastStep.playerId;

  if (!room.scoreA.has(guesserId)) room.scoreA.set(guesserId, 0);
  room.scoreA.set(guesserId, room.scoreA.get(guesserId) + correctVotes);

  // 进入画作人气投票
  systemToast(room, '🎨 现在为各画作投票！选择你最喜欢的画作！', 3000);

  // 收集所有画作
  const artworks = [];
  for (let stepIdx = 0; stepIdx < chain.steps.length; stepIdx += 2) {
    const drawIndex = Math.floor(stepIdx / 2);
    const drawData = room.chainDrawings[chainIndex]?.[drawIndex];
    if (drawData) {
      artworks.push({
        playerId: chain.steps[stepIdx].playerId,
        nickname: chain.steps[stepIdx].nickname,
        drawing: drawData.data,
        prompt: drawData.word || ""
      });
    }
  }

  room.votePhase = 'artwork';
  io.to(room.id).emit('vote_request', {
    type: 'artwork',
    chainIndex,
    timeout: 20,
    data: { artworks }
  });
  room.timerStart = Date.now();

  room.timer = setTimeout(() => {
    handleArtworkVoteTimeout(room);
  }, 20000);
}

function handleArtworkVoteTimeout(room) {
  if (room.state !== 'review') return;
  clearRoomTimer(room);

  // 计算画作投票结果
  const chainIndex = room.currentChainIndex;
  room.votesArtwork.forEach((votedPlayerId) => {
    if (!room.scoreB.has(votedPlayerId)) room.scoreB.set(votedPlayerId, 0);
    room.scoreB.set(votedPlayerId, room.scoreB.get(votedPlayerId) + 1);
  });

  // 广播本链投票结果
  io.to(room.id).emit('chain_end', {
    chainIndex,
    accuracyVotes: correctVotes,
    artworkVotes: Object.fromEntries(room.votesArtwork)
  });

  room.votePhase = null;
  // 显示 5 秒结果后进入下一条链
  setTimeout(() => {
    room.currentChainIndex++;
    room.reviewStepIndex = 0;
    if (room.currentChainIndex >= room.chains.length) {
      finishGame(room);
    } else {
      processNextReviewStep(room);
    }
  }, 5000);
}

// 在 timeout handler 中需要 correctVotes 变量
let correctVotes = 0;

function handleAccuracyVoteTimeout(room) {
  if (room.state !== 'review') return;
  clearRoomTimer(room);

  correctVotes = 0;
  const chainIndex = room.currentChainIndex;
  room.votesAccuracy.forEach((vote) => {
    if (vote === 'correct') correctVotes++;
  });

  // 为最后猜词者加分 a = 每票 1 分
  const chain = room.chains[chainIndex];
  const lastStep = chain.steps[chain.steps.length - 1];
  const guesserId = lastStep.playerId;
  if (!room.scoreA.has(guesserId)) room.scoreA.set(guesserId, 0);
  room.scoreA.set(guesserId, room.scoreA.get(guesserId) + correctVotes);

  // 进入画作人气投票
  systemToast(room, '🎨 现在为各画作投票！选择你最喜欢的画作！', 3000);

  const artworks = [];
  for (let stepIdx = 0; stepIdx < chain.steps.length; stepIdx += 2) {
    const drawIndex = Math.floor(stepIdx / 2);
    const drawData = room.chainDrawings[chainIndex]?.[drawIndex];
    if (drawData) {
      artworks.push({
        playerId: chain.steps[stepIdx].playerId,
        nickname: chain.steps[stepIdx].nickname,
        drawing: drawData.data,
        prompt: drawData.word || ""
      });
    }
  }

  room.votePhase = 'artwork';
  io.to(room.id).emit('vote_request', {
    type: 'artwork',
    chainIndex,
    timeout: 20,
    data: { artworks }
  });
  room.timerStart = Date.now();

  room.timer = setTimeout(() => {
    handleArtworkVoteTimeout(room);
  }, 20000);
}

// ============================================================
// 游戏结算
// ============================================================
function finishGame(room) {
  room.state = 'finished';
  clearRoomTimer(room);

  // 计算最高分
  let maxA = 0;
  const topA = [];
  room.scoreA.forEach((score, playerId) => {
    if (score > maxA) { maxA = score; topA.length = 0; }
    if (score >= maxA) {
      const player = room.players.find(p => p.id === playerId);
      if (player) topA.push(player.nickname);
    }
  });

  let maxB = 0;
  const topB = [];
  room.scoreB.forEach((score, playerId) => {
    if (score > maxB) { maxB = score; topB.length = 0; }
    if (score >= maxB) {
      const player = room.players.find(p => p.id === playerId);
      if (player) topB.push(player.nickname);
    }
  });

  // 构建得分数据
  const scoreAData = {};
  room.scoreA.forEach((score, playerId) => {
    const player = room.players.find(p => p.id === playerId);
    if (player) scoreAData[player.nickname] = score;
  });
  const scoreBData = {};
  room.scoreB.forEach((score, playerId) => {
    const player = room.players.find(p => p.id === playerId);
    if (player) scoreBData[player.nickname] = score;
  });

  // 标记所有玩家为结算中
  room.players.forEach(p => { p.settling = true; });

  io.to(room.id).emit('game_finished', {
    scoreA: scoreAData,
    scoreB: scoreBData,
    titles: {
      accuracyBest: topA,
      artworkBest: topB
    }
  });

  systemToast(room, '🏆 游戏结束！查看最终排名！', 5000);

  // 立即清除所有游戏数据，保留玩家列表
  room.K = 0;
  room.currentRound = 0;
  room.chains = [];
  room.chainDrawings = [];
  room.chainGuesses = [];
  room.scoreA = new Map();
  room.scoreB = new Map();
  room.selectedWords = new Map();
  room.wordCandidates = new Map();
  room.submissions = new Set();
  room.currentChainIndex = 0;
  room.reviewStepIndex = 0;
  room.reviewLog = [];
  room.votePhase = null;
  room.votesAccuracy = new Map();
  room.votesArtwork = new Map();
  room.timerStart = null;
  room.config = { drawTime: room.config.drawTime, guessTime: room.config.guessTime, wordLib: room.config.wordLib || '【简体中文】默认' };
}

// ============================================================
// Socket.IO 事件处理
// ============================================================
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id} 已连接`);

  // ----- 创建房间 -----
  socket.on('create_room', (data, callback) => {
    try {
      const { nickname, roomName, password } = data;
      if (!nickname || nickname.trim().length === 0) {
        return callback?.({ error: '昵称不能为空' });
      }
      if (nickname.length > 12) {
        return callback?.({ error: '昵称最多12个字符' });
      }

      const roomId = generateRoomId();
      const room = createRoom(roomId, socket, nickname.trim(), password);

      rooms.set(roomId, room);
      socket.join(roomId);

      console.log(`[创建房间] ${roomId} 房主: ${nickname}`);
      callback?.({ success: true, roomId });

      socket.emit('create_success', { roomId, nickname: nickname.trim() });
      broadcastRoomUpdate(room);
    } catch (err) {
      console.error('[创建房间错误]', err);
      callback?.({ error: '创建房间失败' });
      socket.emit('room_error', { message: '创建房间失败' });
    }
  });

  // ----- 加入房间 -----
  socket.on('join_room', (data, callback) => {
    try {
      const { roomId, nickname, password } = data;
      if (!nickname || nickname.trim().length === 0) {
        return callback?.({ error: '昵称不能为空' });
      }
      if (nickname.length > 12) {
        return callback?.({ error: '昵称最多12个字符' });
      }

      const room = rooms.get(roomId);
      if (!room) return callback?.({ error: '房间不存在' });
      if (room.password && room.password !== password) {
        return callback?.({ error: '密码错误' });
      }
      if (room.state !== 'lobby') {
        return callback?.({ error: '游戏已开始，无法加入' });
      }
      if (room.players.length >= 12) {
        return callback?.({ error: '房间已满（最多12人）' });
      }

      // 处理重复昵称：按加入顺序标记 (2), (3)...
      let finalNick = nickname.trim();
      const existingNicks = room.players.map(p => p.nickname);
      if (existingNicks.includes(finalNick)) {
        let suffix = 2;
        while (existingNicks.includes(finalNick + '(' + suffix + ')')) suffix++;
        finalNick = finalNick + '(' + suffix + ')';
      }
      room.players.push({
        id: socket.id,
        nickname: finalNick,
        isOwner: false,
        connected: true
      });

      socket.join(roomId);
      console.log(`[加入房间] ${roomId} ${nickname}`);

      callback?.({ success: true, roomId, nickname: finalNick });
      socket.emit('join_success', { roomId, nickname: finalNick });

      broadcastRoomUpdate(room);
      io.to(room.id).emit('player_joined', {
        nickname: nickname.trim(),
        playerCount: room.players.length
      });
      systemToast(room, `${nickname} 加入了房间`, 3000);
    } catch (err) {
      console.error('[加入房间错误]', err);
      callback?.({ error: '加入房间失败' });
      socket.emit('room_error', { message: '加入房间失败' });
    }
  });

  // ----- 更新游戏配置（房主）-----
  socket.on('update_config', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isOwner) return;

    if (data.drawTime !== undefined) {
      room.config.drawTime = Math.max(10, Math.min(120, parseInt(data.drawTime) || 60));
    }
    if (data.guessTime !== undefined) {
      room.config.guessTime = Math.max(10, Math.min(60, parseInt(data.guessTime) || 20));
    }

    broadcastRoomUpdate(room);
  });

  // ----- 退出房间 -----
  socket.on('leave_room', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;
    const player = room.players[playerIndex];
    const wasOwner = player.isOwner;

    room.players.splice(playerIndex, 1);
    socket.leave(room.id);

    if (room.players.length === 0) {
      rooms.delete(room.id);
      console.log(`[清理房间] ${room.id} 已无玩家`);
    } else {
      // 房主转移
      if (wasOwner) {
        room.players[0].isOwner = true;
        systemToast(room, `${room.players[0].nickname} 成为新房主`, 3000);
      }
      io.to(room.id).emit('player_left', {
        nickname: player.nickname,
        playerCount: room.players.length
      });
      broadcastRoomUpdate(room);
    }

    socket.emit('leave_room_ok');
    console.log(`[退出房间] ${player.nickname} 离开 ${room.id}`);
  });

  // ----- 选择词库（房主）-----
  socket.on('select_wordlib', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isOwner) return;
    const { wordLib } = data;
    if (wordLib && wordLibraries.find(l => l.name === wordLib)) {
      room.config.wordLib = wordLib;
      currentWordLib = wordLib;
      // 直接切换词库，无需清除缓存
      const ok = words.setCurrentLib(wordLib);
      if (ok) {
        console.log(`[词库] 切换到 "${wordLib}" (${words.length} 词)`);
      }
      systemToast(room, `📖 词库已切换为「${wordLib}」`, 3000);
      broadcastRoomUpdate(room);
    }
  });

  // ----- 房主转移 -----
  socket.on('transfer_owner', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isOwner) return;

    // 移除当前房主身份
    player.isOwner = false;
    // 找下一个在线玩家当房主
    const nextOwner = room.players.find(p => p.id !== socket.id && p.connected);
    if (nextOwner) {
      nextOwner.isOwner = true;
      systemToast(room, `${nextOwner.nickname} 成为新房主`, 3000);
    }
    broadcastRoomUpdate(room);
  });

  // ----- 返回房间（重置游戏状态）-----
  socket.on('back_to_room', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const nick = player?.nickname || '未知';

    // 强制清除所有游戏数据（无论当前状态）
    room.state = 'lobby';
    room.K = 0;
    room.currentRound = 0;
    room.chains = [];
    room.chainDrawings = [];
    room.chainGuesses = [];
    room.scoreA = new Map();
    room.scoreB = new Map();
    room.selectedWords = new Map();
    room.wordCandidates = new Map();
    room.submissions = new Set();
    room.currentChainIndex = 0;
    room.reviewStepIndex = 0;
    room.reviewLog = [];
    room.votePhase = null;
    room.votesAccuracy = new Map();
    room.votesArtwork = new Map();
    room.timerStart = null;
    if (player) player.settling = false;
    clearRoomTimer(room);

    broadcastRoomUpdate(room);
    socket.emit('back_to_room_ok');
    socket.to(room.id).emit('player_returned', { nickname: nick });
    systemToast(room, `🔄 ${nick} 已返回大厅`, 2000);
  });

  // ----- 开始游戏 -----
  socket.on('start_game', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isOwner) return;
    if (room.players.length < 2) {
      systemToast(room, '至少需要2名玩家才能开始游戏', 3000);
      return;
    }

    // 生成链条
    const { chains, K } = generateChains(room.players);
    room.chains = chains;
    room.K = K;
    room.currentRound = 0;
    room.chainDrawings = [];
    room.chainGuesses = [];
    room.scoreA = new Map();
    room.scoreB = new Map();
    room.wordCandidates = new Map();
    room.selectedWords = new Map();
    room.submissions = new Set();
    room.reviewLog = [];
    room.votePhase = null;
    room.votesAccuracy = new Map();
    room.votesArtwork = new Map();

    // 通知游戏开始
    io.to(room.id).emit('game_started', { K });
    systemToast(room, `🎮 游戏开始！共 ${chains.length} 条链条，每条 ${2*K} 步！`, 3000);

    // 进入选词阶段
    startWordSelection(room);
  });

  // ----- 选词 -----
  function startWordSelection(room) {
    room.state = 'word_select';
    room.selectedWords = new Map();

    room.chains.forEach((chain) => {
      const candidates = getRandomWords(3);
      room.wordCandidates.set(chain.startPlayerId, candidates);

      const playerSocket = findPlayerSocket(chain.startPlayerId);
      if (playerSocket && playerSocket.connected) {
        playerSocket.emit('word_select', {
          candidates,
          timeout: 10,
          chainIndex: room.chains.indexOf(chain)
        });
      } else {
        // 玩家离线，自动选第一个
        room.selectedWords.set(chain.startPlayerId, candidates[0]);
      }
    });

    systemToast(room, '📝 起点玩家正在选词...', 2000);

    // 10秒超时
    room.timer = setTimeout(() => {
      room.chains.forEach((chain) => {
        if (!room.selectedWords.has(chain.startPlayerId)) {
          const candidates = room.wordCandidates.get(chain.startPlayerId);
          if (candidates && candidates.length > 0) {
            room.selectedWords.set(
              chain.startPlayerId,
              candidates[Math.floor(Math.random() * candidates.length)]
            );
          }
        }
      });
      startDrawingRound(room);
    }, 10000);
  }

  socket.on('select_word', (word) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'word_select') return;

    if (!word) return;

    const chain = room.chains.find(c => c.startPlayerId === socket.id);
    if (!chain) return;

    room.selectedWords.set(socket.id, word);

    // 检查是否所有起点都已选词
    let allSelected = true;
    room.chains.forEach(c => {
      if (!room.selectedWords.has(c.startPlayerId)) allSelected = false;
    });

    if (allSelected) {
      clearRoomTimer(room);
      startDrawingRound(room);
    } else {
      // 广播选择进度
      const selected = room.selectedWords.size;
      const total = room.chains.length;
      // 只通知选词玩家本人
      socket.emit('submit_progress', { submitted: selected, total });
    }
  });

  // ----- 开始作画轮 -----
  function startDrawingRound(room) {
    room.submissions = new Set();
    nextStage(room);
  }

  // ----- 提交画作 -----
  socket.on('submit_drawing', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const round = room.currentRound;
    if (round % 2 !== 0) return; // 不是作画轮

    const chainStepIndex = Math.floor(round / 2);
    const chain = room.chains.find(c => {
      const step = c.steps[round];
      return step && step.playerId === socket.id;
    });
    if (!chain) return;

    const chainIndex = room.chains.indexOf(chain);
    if (!room.chainDrawings[chainIndex]) room.chainDrawings[chainIndex] = [];
    // 检查是否已提交：data 为非空字符串才视为已提交，null/undefined/空均可继续
    const existing = room.chainDrawings[chainIndex][chainStepIndex];
    if (existing && existing.data && existing.data.length > 10) return;

    // data 是客户端传来的 base64 字符串
    const existingData = room.chainDrawings[chainIndex][chainStepIndex];
    room.chainDrawings[chainIndex][chainStepIndex] = {
      word: existingData?.word || pickRandomWord(),
      data: data  // 裸 base64 字符串
    };

    room.submissions.add(socket.id);

    // 广播进度
    broadcastSubmitProgress(room);

    // 检查是否全部提交
    checkAllSubmitted(room);
  });

  // ----- 提交猜词 -----
  socket.on('submit_guess', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const round = room.currentRound;
    if (round % 2 !== 1) return; // 不是猜词轮

    const chainStepIndex = Math.floor((round - 1) / 2);
    const chain = room.chains.find(c => {
      const step = c.steps[round];
      return step && step.playerId === socket.id;
    });
    if (!chain) return;

    const chainIndex = room.chains.indexOf(chain);
    if (room.chainGuesses[chainIndex] && room.chainGuesses[chainIndex][chainStepIndex]) return; // 已提交

    if (!room.chainGuesses[chainIndex]) room.chainGuesses[chainIndex] = [];
    // data 是客户端传来的猜测词语字符串
    room.chainGuesses[chainIndex][chainStepIndex] = {
      word: data,
      playerId: socket.id,
      nickname: room.players.find(p => p.id === socket.id)?.nickname || '未知',
      isSystemGenerated: false,
      isTimeout: false
    };

    room.submissions.add(socket.id);

    broadcastSubmitProgress(room);
    checkAllSubmitted(room);
  });

  // ----- 投票（正误）-----
  socket.on('vote_accuracy', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const { chainIndex, vote } = data;
    if (room.currentChainIndex !== chainIndex) return;
    if (room.votesAccuracy.has(socket.id)) return; // 已投票

    room.votesAccuracy.set(socket.id, vote);
    // 生成可视化投票状态条：√=相似 ×=不相似 口=未投票
    // 可视化投票状态：✅=相似 ❎=不相似 口=未投票
    let voteBar = '';
    room.players.forEach(p => {
      const v = room.votesAccuracy.get(p.id);
      if (v === 'correct') voteBar += '✅';
      else if (v === 'incorrect') voteBar += '❎';
      else voteBar += '☐';
    });
    io.to(room.id).emit('vote_progress', {
      voted: room.votesAccuracy.size,
      total: room.players.length,
      voteBar
    });

    // 全部投完且剩余 >5s 则缩短为5s
    const elapsed = Date.now() - (room.timerStart || Date.now());
    const remaining = Math.max(0, 20000 - elapsed);
    if (room.votesAccuracy.size >= room.players.length && room.timer && remaining > 5000) {
      clearRoomTimer(room);
      room.timer = setTimeout(() => handleAccuracyVoteTimeout(room), 5000);
      io.to(room.id).emit('timer_sync', { remaining: 5 });
    }
  });

  // ----- 投票（画作人气）-----
  socket.on('vote_artwork', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const { chainIndex, votedPlayerId } = data;
    if (room.currentChainIndex !== chainIndex) return;
    if (room.votesArtwork.has(socket.id)) return; // 已投票

    room.votesArtwork.set(socket.id, votedPlayerId);
    // 找出投票者昵称
    const voter = room.players.find(p => p.id === socket.id);
    const voterNickname = voter ? voter.nickname : '未知';
    io.to(room.id).emit('vote_progress', {
      voted: room.votesArtwork.size,
      total: room.players.length,
      votedPlayerId,
      voterNickname
    });

    // 全部投完且剩余 >5s 则缩短为5s
    const elapsed = Date.now() - (room.timerStart || Date.now());
    const remaining = Math.max(0, 20000 - elapsed);
    if (room.votesArtwork.size >= room.players.length && room.timer && remaining > 5000) {
      clearRoomTimer(room);
      room.timer = setTimeout(() => handleArtworkVoteTimeout(room), 5000);
      io.to(room.id).emit('timer_sync', { remaining: 5 });
    }
  });

  // ----- 聊天 -----
  socket.on('chat_msg', (text) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    text = (text || '').trim();
    if (text.length === 0 || text.length > 200) return;

    const msg = {
      nickname: player.nickname,
      text,
      timestamp: Date.now()
    };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.splice(0, 50);

    io.to(room.id).emit('chat_msg_broadcast', msg);
  });

  // ----- 断线处理 -----
  socket.on('disconnect', () => {
    const oldId = socket.id;
    console.log(`[断线] ${oldId} 已断开`);

    for (const [roomId, room] of rooms) {
      const playerIndex = room.players.findIndex(p => p.id === oldId);
      if (playerIndex === -1) continue;

      const player = room.players[playerIndex];
      player.connected = false;

      // 保存断线信息供重连用（游戏中的房间保留玩家数据）
      if (!room._disconnected) room._disconnected = new Map();
      room._disconnected.set(oldId, { playerId: oldId, nickname: player.nickname });

      if (room.state === 'lobby') {
        room.players.splice(playerIndex, 1);
        if (room.players.length === 0) {
          rooms.delete(roomId);
          console.log(`[清理房间] ${roomId} 已无玩家`);
          return;
        }
        if (player.isOwner && room.players.length > 0) {
          room.players[0].isOwner = true;
          systemToast(room, `${room.players[0].nickname} 成为新房主`, 3000);
        }
        io.to(roomId).emit('player_left', {
          nickname: player.nickname,
          playerCount: room.players.length
        });
        broadcastRoomUpdate(room);
      } else {
        // 游戏中保留玩家数据
        io.to(roomId).emit('player_left', {
          nickname: player.nickname,
          playerCount: room.players.filter(p => p.connected).length
        });
        systemToast(room, `${player.nickname} 断线了😢`, 3000);
        broadcastRoomUpdate(room);
      }
      return;
    }
  });

  // ----- 重连到房间 -----
  socket.on('reconnect_to_room', (data) => {
    const { roomId, nickname } = data;
    if (!roomId || !nickname) return;

    const room = rooms.get(roomId);
    if (!room) return socket.emit('room_error', { message: '房间已不存在' });

    // 找该昵称的玩家
    const player = room.players.find(p => p.nickname === nickname);
    if (!player) return socket.emit('room_error', { message: '找不到你的角色' });

    // 先保存旧 ID，再更新 socket.id
    const oldPlayerId = player.id;
    player.id = socket.id;
    player.connected = true;
    socket.join(roomId);

    // 迁移得分记录：旧 ID → 新 ID
    [room.scoreA, room.scoreB].forEach(scoreMap => {
      if (!scoreMap) return;
      if (scoreMap.has(oldPlayerId)) {
        scoreMap.set(socket.id, scoreMap.get(oldPlayerId));
        scoreMap.delete(oldPlayerId);
      }
    });

    // 迁移投票记录：旧 ID → 新 ID
    [room.votesAccuracy, room.votesArtwork].forEach(voteMap => {
      if (!voteMap) return;
      if (voteMap.has(oldPlayerId)) {
        voteMap.set(socket.id, voteMap.get(oldPlayerId));
        voteMap.delete(oldPlayerId);
      }
    });

    // 迁移选词记录：旧 ID → 新 ID
    if (room.selectedWords && room.selectedWords.has(oldPlayerId)) {
      room.selectedWords.set(socket.id, room.selectedWords.get(oldPlayerId));
      room.selectedWords.delete(oldPlayerId);
    }
    // 迁移提交记录
    if (room.submissions && room.submissions.has(oldPlayerId)) {
      room.submissions.delete(oldPlayerId);
      room.submissions.add(socket.id);
    }

    // 更新所有链条步骤中的 playerId 为新 ID，确保 submit_drawing/guess 能匹配
    room.chains.forEach(chain => {
      chain.steps.forEach(step => {
        if (step.playerId === oldPlayerId) step.playerId = socket.id;
      });
      if (chain.startPlayerId === oldPlayerId) chain.startPlayerId = socket.id;
    });

    console.log(`[重连] ${nickname} 回到房间 ${roomId}`);

    if (room.state === 'lobby' || room.state === 'finished') {
      socket.emit('join_success', { roomId });
      if (room.state === 'finished') {
        // 如果在结算页，重发结算数据
        let maxA = 0, maxB = 0;
        const topA = [], topB = [];
        room.scoreA.forEach((s, pid) => { const p = room.players.find(x => x.id === pid); if (s > maxA) { maxA = s; topA.length = 0; } if (s >= maxA && p) topA.push(p.nickname); });
        room.scoreB.forEach((s, pid) => { const p = room.players.find(x => x.id === pid); if (s > maxB) { maxB = s; topB.length = 0; } if (s >= maxB && p) topB.push(p.nickname); });
        socket.emit('game_finished', {
          titles: { accuracyBest: topA, artworkBest: topB }
        });
      }
    } else {
      // 游戏中：发送当前状态让客户端恢复
      let totalRounds = 2 * room.K;
      socket.emit('reconnect_game', {
        roomId,
        state: room.state,
        K: room.K,
        currentRound: room.currentRound,
        totalRounds,
        config: room.config
      });

      // 根据当前状态发送对应任务
      if (room.state === 'word_select') {
        // 选词阶段：重发 word_select（如果该玩家是起点）
        room.chains.forEach((chain, ci) => {
          if (chain.startNickname === nickname) {
            const candidates = room.wordCandidates.get(chain.startPlayerId);
            if (candidates) {
              socket.emit('word_select', { candidates, timeout: 5, chainIndex: ci });
            }
          }
        });
      } else if (room.state.startsWith('draw_') || room.state.startsWith('guess_')) {
        // 作画/猜词阶段：重发 round_start
        const round = room.currentRound;
        const isDraw = round % 2 === 0;
        const chainStepIndex = Math.floor(round / 2);
        room.chains.forEach((chain, chainIndex) => {
          const step = chain.steps[round];
          // 用昵称匹配而非 socket.id（重连后 socket.id 已变化）
          if (!step || step.nickname !== nickname) return;
          if (isDraw) {
            let wordToDraw;
            if (round === 0) {
              wordToDraw = room.selectedWords.get(chain.startPlayerId) || pickRandomWord();
            } else {
              const prevGuess = room.chainGuesses[chainIndex] && room.chainGuesses[chainIndex][chainStepIndex - 1];
              wordToDraw = prevGuess ? prevGuess.word : pickRandomWord();
            }
            // 检查是否已有提交的画作，重连时保留
            const existingDraw = room.chainDrawings[chainIndex]?.[chainStepIndex]?.data || null;
            socket.emit('round_start', {
              round: round + 1, totalRounds, type: 'draw',
              timeout: room.config.drawTime,
              yourTask: { word: wordToDraw, existingDrawing: existingDraw },
              chainIndex
            });
          } else {
            const prevDraw = room.chainDrawings[chainIndex] && room.chainDrawings[chainIndex][chainStepIndex];
            socket.emit('round_start', {
              round: round + 1, totalRounds, type: 'guess',
              timeout: room.config.guessTime,
              yourTask: { imageBase64: prevDraw?.data || null, fromPlayer: chain.steps[round - 1]?.nickname || '' },
              chainIndex
            });
          }
        });
      } else if (room.state === 'review') {
        // 回顾阶段：重发 review_start，并回放已展示的步骤
        socket.emit('review_start', { totalChains: room.chains.length });
        // 重放当前链条已发送的 review_step（快速回放，1 秒间隔）
        if (room.reviewLog && room.reviewLog.length > 0) {
          const currentChainSteps = room.reviewLog.filter(
            r => r.chainIndex === room.currentChainIndex
          );
          currentChainSteps.forEach((step, idx) => {
            setTimeout(() => {
              socket.emit('review_step', step);
            }, idx * 1000);
          });
        }
        // 如果在投票阶段，重发 vote_request
        if (room.votePhase === 'accuracy') {
          const chainIndex = room.currentChainIndex;
          const chain = room.chains[chainIndex];
          const initWord = room.chainDrawings[chainIndex]?.[0]?.word || '';
          const totalSteps = chain.steps.length;
          const lastStep = chain.steps[totalSteps - 1];
          let finalGuess = '', isSystem = false;
          if (lastStep.type === 'guess') {
            const guessIndex = Math.floor((totalSteps - 2) / 2);
            const gd = room.chainGuesses[chainIndex]?.[guessIndex];
            finalGuess = gd?.word || '';
            isSystem = gd?.isSystemGenerated || false;
          }
          socket.emit('vote_request', {
            type: 'accuracy', chainIndex, timeout: 20,
            data: { initWord, finalGuess, isSystemGenerated: isSystem, drawerNickname: lastStep?.nickname || '' }
          });
          // 同步已有投票进度
          let voteBar = '';
          room.players.forEach(p => {
            const v = room.votesAccuracy.get(p.id);
            if (v === 'correct') voteBar += '✅';
            else if (v === 'incorrect') voteBar += '❎';
            else voteBar += '☐';
          });
          socket.emit('vote_progress', { voted: room.votesAccuracy.size, total: room.players.length, voteBar });
        } else if (room.votePhase === 'artwork') {
          const chainIndex = room.currentChainIndex;
          const chain = room.chains[chainIndex];
          const artworks = [];
          for (let si = 0; si < chain.steps.length; si += 2) {
            const di = Math.floor(si / 2);
            const dd = room.chainDrawings[chainIndex]?.[di];
            if (dd) artworks.push({
              playerId: chain.steps[si].playerId,
              nickname: chain.steps[si].nickname,
              drawing: dd.data,
              prompt: dd.word || ''
            });
          }
          socket.emit('vote_request', {
            type: 'artwork', chainIndex, timeout: 20,
            data: { artworks }
          });
          // 同步已有画作投票
          room.votesArtwork.forEach((votedPlayerId, voterId) => {
            const voter = room.players.find(p => p.id === voterId);
            const target = room.players.find(p => p.id === votedPlayerId);
            if (voter && target) {
              socket.emit('vote_progress', {
                voted: room.votesArtwork.size, total: room.players.length,
                votedPlayerId, voterNickname: voter.nickname
              });
            }
          });
        }
      }
    }
    broadcastRoomUpdate(room);
    systemToast(room, `${nickname} 重新连接了`, 3000);
  });

  // ----- 重连处理 -----
  socket.on('reconnect_request', (data, callback) => {
    const { roomId, previousId } = data;
    const room = rooms.get(roomId);
    if (!room) return callback?.({ error: '房间已不存在' });

    const player = room.players.find(p => p.id === previousId);
    if (!player) return callback?.({ error: '未找到玩家' });

    player.id = socket.id;
    player.connected = true;
    socket.join(roomId);

    callback?.({ success: true, roomData: room });
    broadcastRoomUpdate(room);
  });

  // ----- 返回大厅 -----
  socket.on('back_to_lobby', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isOwner) return;

    room.state = 'lobby';
    room.currentRound = 0;
    room.chains = [];
    room.chainDrawings = [];
    room.chainGuesses = [];
    room.scoreA = new Map();
    room.scoreB = new Map();
    room.submissions = new Set();

    clearRoomTimer(room);
    broadcastRoomUpdate(room);
    systemToast(room, '🔄 已返回大厅，可以重新开始', 3000);
  });
});

// ============================================================
// 辅助函数
// ============================================================

function findRoomBySocket(socket) {
  for (const room of rooms.values()) {
    if (room.players.find(p => p.id === socket.id)) return room;
  }
  return null;
}

function broadcastSubmitProgress(room) {
  const submitted = room.submissions.size;
  const total = room.chains.length; // 每轮每个链条有1人参与，即总玩家数
  io.to(room.id).emit('submit_progress', { submitted, total });
}

function checkAllSubmitted(room) {
  const allSubmitted = room.submissions.size >= room.chains.length;
  if (allSubmitted) {
    advanceToNextRound(room);
  }
}

// ============================================================
// 启动服务器
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎨 传画接龙服务器已启动`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`  📝 当前词库: ${currentWordLib} (${words.length} 词)`);
  console.log(`  📚 可用词库: ${wordLibraries.map(l=>l.name+'('+l.count+'词)').join(', ')}\n`);
});
