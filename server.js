/**
 * 传画接龙 — 后端服务器
 * Express + Socket.IO 实现多人联机绘画猜词接力游戏
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const words = require('./words');
const wordLibraries = words.libraries || [];
let currentWordLib = '【简体中文】默认'; // 当前活动的词库名称

// ============================================================
// 在线人数追踪（自维护计数，避免 Socket.IO 连接计数在刷新时出现偏差）
// ============================================================
let onlineCount = 0;

// ============================================================
// Render 防休眠：有玩家在线时每10分钟自ping，无人时自动停止
// ============================================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
let keepAliveTimer = null;

function startKeepAlive() {
  if (!SELF_URL || keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    http.get(`${SELF_URL}/`, (res) => {
      console.log(`[保活] 自 ping 成功 (${res.statusCode})`);
    }).on('error', (err) => {
      console.log(`[保活] 自 ping 失败: ${err.message}`);
    });
  }, 10 * 60 * 1000);
  console.log('[保活] 已启动 (每 10 分钟自 ping)');
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    console.log('[保活] 已停止 (无玩家在线)');
  }
}

// ============================================================
// 延迟追踪
// ============================================================
const socketLatency = new Map(); // socket.id -> { latency: ms, time: timestamp }

function getLatency(socketId) {
  const d = socketLatency.get(socketId);
  return d ? d.latency : -1;
}

// ============================================================
// Express 配置
// ============================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024,
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 3000,
  pingInterval: 5000,
  connectionStateRecovery: { maxDisconnectionDuration: 0 }
});

// 定期校正在线人数（每 10 秒与实际 Socket 数同步）
setInterval(() => {
  const actual = io.of('/').sockets.size;
  if (onlineCount !== actual) {
    console.log(`[在线校正] ${onlineCount} → ${actual}`);
    onlineCount = actual;
    io.emit('global_online', { count: onlineCount });
  }
}, 10000);

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 无人房间清理：游戏中全员掉线后保留 15 分钟等待重连，超时销毁房间
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const connectedCount = room.players.filter(p => p.connected).length;
    if (connectedCount === 0) {
      if (!room._emptySince) room._emptySince = now;
      else if (now - room._emptySince > 15 * 60 * 1000) {
        clearRoomTimer(room);
        rooms.delete(roomId);
        console.log(`[清理房间] ${roomId} 已无在线玩家超过15分钟，已销毁`);
      }
    } else {
      room._emptySince = null;
    }
  }
}, 60 * 1000);

// 每 5 秒向所有连接发送 ping 测量
setInterval(() => {
  for (const [sid, socket] of io.of('/').sockets) {
    if (socket.connected) {
      try { socket.emit('ping_measure', { t: Date.now() }); } catch(e) {}
    }
  }
  const cutoff = Date.now() - 30000;
  for (const [sid, data] of socketLatency) {
    if (data.time < cutoff) socketLatency.delete(sid);
  }
}, 5000);

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

function getRandomWords(count, wordList) {
  const list = wordList || words;
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function pickRandomWord(wordList) {
  const list = wordList || words;
  return list[Math.floor(Math.random() * list.length)];
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
function createRoom(id, socket, nickname, password, avatar) {
  return {
    id,
    name: `${nickname}的房间`,
    password: password || null,
    players: [{
      id: socket.id,
      nickname,
      avatar: avatar || '😀',
      isOwner: true,
      connected: true
    }],
    state: 'lobby',
    config: {
      drawTime: 60,
      guessTime: 20,
      wordLib: '【简体中文】默认',
      cleverIdea: false,
      youDrawIGuess: false,   // 你画我猜模式（与默认模式平行）
      wordCount: 3            // 你画我猜：可选词数 1-6，默认 3
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
    // 你画我猜模式数据
    ydig: null,                 // 当前局 ydig 状态对象（未开启时为 null）
    scoreYdigGuess: new Map(),  // playerId -> 作为猜手获得的得分
    scoreYdigDraw: new Map(),   // playerId -> 作为画手获得的得分（被猜对得分+相符票）
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
      avatar: p.avatar || '😀',
      isOwner: p.isOwner,
      connected: p.connected,
      settling: p.settling || false,
      latency: p.connected ? getLatency(p.id) : -2
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
function getRemaining(room, defaultDur) {
  if (room.timerStart) {
    const elapsed = Date.now() - room.timerStart;
    return Math.max(1, Math.floor((defaultDur * 1000 - elapsed) / 1000));
  }
  return defaultDur;
}

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

  // 必须先设置 timerStart，后面的 round_start 需要用它计算剩余时间
  room.timerStart = Date.now();
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
        wordToDraw = room.selectedWords.get(chain.startPlayerId) || pickRandomWord(room._wordList);
      } else {
        // 后续作画轮：使用上一步猜词结果
        const prevGuess = room.chainGuesses[chainIndex] && room.chainGuesses[chainIndex][chainStepIndex - 1];
        wordToDraw = prevGuess ? prevGuess.word : pickRandomWord(room._wordList);
      }

      // 保存这个词到 chainDrawings 的元数据中
      if (!room.chainDrawings[chainIndex]) room.chainDrawings[chainIndex] = [];
      room.chainDrawings[chainIndex][chainStepIndex] = { word: wordToDraw, data: null };

      // 找到前一步和后一步的玩家
      const prevStepPlayer = chain.steps[round - 1]?.nickname;
      const nextStepPlayer = chain.steps[round + 1]?.nickname;
      // 检查初始词是否为系统代选
      const isAuto = round === 0 && room.selectedWords && !room._wordWasPlayerSelected?.has(chain.startPlayerId);
      const drawDeadline = room.timerStart + room.config.drawTime * 1000;
      playerSocket.emit('round_start', {
        round: round + 1,
        totalRounds,
        type: 'draw',
        timeout: getRemaining(room, room.config.drawTime),
        deadline: drawDeadline,
        yourTask: { word: wordToDraw, isSystemGenerated: isAuto },
        chainIndex,
        prevPlayer: prevStepPlayer,
        nextPlayer: nextStepPlayer
      });
    } else {
      // 猜词轮：发送上家画作
      const prevDraw = room.chainDrawings[chainIndex] && room.chainDrawings[chainIndex][chainStepIndex];
      const imageData = prevDraw ? prevDraw.data : null;

      const prevStepPlayer = chain.steps[round - 1]?.nickname;
      const nextStepPlayer = chain.steps[round + 1]?.nickname;
      const guessDeadline = room.timerStart + room.config.guessTime * 1000;
      playerSocket.emit('round_start', {
        round: round + 1,
        totalRounds,
        type: 'guess',
        timeout: getRemaining(room, room.config.guessTime),
        deadline: guessDeadline,
        yourTask: {
          imageBase64: imageData,
          fromPlayer: chain.steps[round - 1].nickname
        },
        chainIndex,
        prevPlayer: prevStepPlayer,
        nextPlayer: nextStepPlayer
      });
    }
  });

  // 广播轮次开始（不含具体内容）
  io.to(room.id).emit('system_toast', {
    message: `第 ${round + 1}/${totalRounds} 轮 — ${isDraw ? '✏️ 作画' : '💭 猜词'}开始！`,
    duration: 3000
  });

  // 设置超时
  room.timerStart = Date.now();
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
            word: room.chainDrawings[chainIndex][chainStepIndex]?.word || pickRandomWord(room._wordList),
            data: blankDataUrl,
            isBlank: true
          };
        }
      } else {
        // 自动猜词：随机选一个
        const guessedWord = pickRandomWord(room._wordList);
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

// 生成空白画布的 base64（与正常画布同尺寸的 600x400 纯白 SVG，
// 通过 isBlank 标记识别，不再依赖长度判断）
function createBlankCanvas() {
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="600" height="400" fill="#ffffff"/></svg>');
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
        chainLength: totalSteps,
        initWord: room.chainDrawings[room.currentChainIndex]?.[0]?.word || ''
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
  room.timerStart = Date.now(); // 必须在 getRemaining 之前设置
  // Step 1: 正误投票 (20s)
  io.to(room.id).emit('vote_request', {
    type: 'accuracy',
    chainIndex,
    timeout: getRemaining(room, 20),
    data: {
      initWord,
      finalGuess,
      isSystemGenerated: isSystem,
      drawerNickname: lastStep?.nickname || '',
      players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id) }))
    }
  });

  systemToast(room, `🔍 为链条 ${chainIndex + 1} 的最终猜词投票！`, 3000);

  room.timerStart = Date.now();
  room.timer = setTimeout(() => {
    handleAccuracyVoteTimeout(room);
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
    accuracyVotes: room.correctVotes || 0,
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

function handleAccuracyVoteTimeout(room) {
  if (room.state !== 'review') return;
  clearRoomTimer(room);

  room.correctVotes = 0;
  const chainIndex = room.currentChainIndex;
  room.votesAccuracy.forEach((vote) => {
    if (vote === 'correct') room.correctVotes++;
  });

  // 为最后猜词者加分 a = 每票 1 分
  const chain = room.chains[chainIndex];
  const lastStep = chain.steps[chain.steps.length - 1];
  const guesserId = lastStep.playerId;
  if (!room.scoreA.has(guesserId)) room.scoreA.set(guesserId, 0);
  room.scoreA.set(guesserId, room.scoreA.get(guesserId) + (room.correctVotes || 0));

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
        prompt: drawData.word || "",
        isBlank: drawData.isBlank || false
      });
    }
  }

  room.votePhase = 'artwork';
  room.timerStart = Date.now();
  io.to(room.id).emit('vote_request', {
    type: 'artwork',
    chainIndex,
    timeout: getRemaining(room, 20),
    data: { artworks }
  });
  
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
  resetRoomAfterGame(room);
}

// 游戏结束后重置房间到大厅（保留玩家列表与配置），普通/灵机一动/你画我猜共用
function resetRoomAfterGame(room) {
  // 房间状态设为大厅，允许新玩家加入
  room.state = 'lobby';

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
  room.ydig = null;
  room.scoreYdigGuess = new Map();
  room.scoreYdigDraw = new Map();
  room._disconnected = new Map();
  room.timerStart = null;
  // 保留全部设置（含模式开关与可选词数），确保重开后能继续选择模式/参数
  room.config = {
    drawTime: room.config.drawTime,
    guessTime: room.config.guessTime,
    wordLib: room.config.wordLib || '【简体中文】默认',
    cleverIdea: room.config.cleverIdea || false,
    youDrawIGuess: room.config.youDrawIGuess || false,
    wordCount: Math.max(1, Math.min(6, parseInt(room.config.wordCount) || 3))
  };
}

// ============================================================
// Socket.IO 事件处理
// ============================================================
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id} 已连接`);

  // 广播全局在线人数
  io.emit('global_online', { count: ++onlineCount });
  if (onlineCount === 1) startKeepAlive(); // 第一个玩家上线，启动保活
  socket.on('pong_measure', (data) => {
    const sent = data.t || 0;
    const latency = Date.now() - sent;
    socketLatency.set(socket.id, { latency, time: Date.now() });
    // 将延迟发回给客户端，用于首页显示
    socket.emit('your_latency', { latency });
  });

  // ----- 创建房间 -----
  socket.on('create_room', (data, callback) => {
    try {
      const { nickname, roomName, password, avatar } = data;
      if (!nickname || nickname.trim().length === 0) {
        return callback?.({ error: '昵称不能为空' });
      }
      if (nickname.length > 12) {
        return callback?.({ error: '昵称最多12个字符' });
      }

      const roomId = generateRoomId();
      // 头像只允许极短字符串（表情符号），防止注入
      const safeAvatar = (typeof avatar === 'string' && avatar.length <= 8) ? avatar : '😀';
      const room = createRoom(roomId, socket, nickname.trim(), password, safeAvatar);

      rooms.set(roomId, room);
      socket.join(roomId);

      console.log(`[创建房间] ${roomId} 房主: ${nickname}`);
      callback?.({ success: true, roomId });

      socket.emit('create_success', { roomId, nickname: nickname.trim(), avatar: safeAvatar });
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
      const { roomId, nickname, password, avatar } = data;
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

      // 头像只允许极短字符串（表情符号），防止注入
      const safeAvatar = (typeof avatar === 'string' && avatar.length <= 8) ? avatar : '😀';

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
        avatar: safeAvatar,
        isOwner: false,
        connected: true
      });

      socket.join(roomId);
      console.log(`[加入房间] ${roomId} ${nickname}`);

      callback?.({ success: true, roomId, nickname: finalNick });
      socket.emit('join_success', { roomId, nickname: finalNick, avatar: safeAvatar });

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
      room.config.drawTime = Math.max(10, Math.min(180, parseInt(data.drawTime) || 60));
    }
    if (data.guessTime !== undefined) {
      room.config.guessTime = Math.max(10, Math.min(60, parseInt(data.guessTime) || 20));
    }
    if (data.cleverIdea !== undefined) {
      room.config.cleverIdea = !!data.cleverIdea;
    }
    if (data.youDrawIGuess !== undefined) {
      room.config.youDrawIGuess = !!data.youDrawIGuess;
      // 你画我猜是独立游戏模式：开启时强制关闭灵机一动（该选项仅默认模式可用）
      if (room.config.youDrawIGuess) room.config.cleverIdea = false;
    }
    if (data.wordCount !== undefined) {
      room.config.wordCount = Math.max(1, Math.min(6, parseInt(data.wordCount) || 3));
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

    // 仅清除该玩家的结算标记，不改变房间状态
    if (player) player.settling = false;

    // 仅在非进行中的阶段（大厅/结算后）重置回顾数据与计时器；
    // 进行中（选词/作画/猜词/灵机一动/回顾投票）不触碰计时器，防止任意玩家调用导致整轮卡死
    const inProgress = room.state !== 'lobby' && room.state !== 'finished';
    if (!inProgress) {
      room.reviewLog = [];
      room.reviewStepIndex = 0;
      if (room._disconnected) room._disconnected.clear();
      clearRoomTimer(room);
    }

    socket.emit('back_to_room_ok');
    socket.to(room.id).emit('player_returned', { nickname: nick });
    broadcastRoomUpdate(room);
  });

  // ----- 开始游戏 -----
  socket.on('start_game', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isOwner) return;
    // 防止重复点击开始导致两个游戏流程叠加
    if (room.state !== 'lobby') return;
    // 移除离线玩家
    room.players = room.players.filter(p => p.connected);
    if (room.players.length < 2) {
      systemToast(room, '至少需要2名玩家才能开始游戏', 3000);
      broadcastRoomUpdate(room);
      return;
    }
    // 检查是否有玩家仍在结算中（未确认返回房间）
    if (room.players.some(p => p.settling)) {
      systemToast(room, '有玩家尚未确认返回，请等待所有玩家返回后再开始', 3000);
      return;
    }

    // 随机打乱玩家顺序，让链条关系每次不同
    room.players.sort(() => Math.random() - 0.5);
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
    room.reviewStepIndex = 0;
    room.votePhase = null;
    room.votesAccuracy = new Map();
    room.votesArtwork = new Map();
    room.ydig = null;
    room.scoreYdigGuess = new Map();
    room.scoreYdigDraw = new Map();
    if (room._disconnected) room._disconnected.clear();

    // 通知游戏开始
    const mode = room.config.youDrawIGuess ? 'ydig' : 'classic';
    io.to(room.id).emit('game_started', { K, mode, totalRounds: room.players.length });
    systemToast(room, mode === 'ydig'
      ? `🎮 你画我猜开始！共 ${room.players.length} 轮，大家轮流当画手！`
      : `🎮 游戏开始！共 ${chains.length} 条链条，每条 ${2*K} 步！`, 3000);

    // 根据房间配置加载对应词库（每次游戏开始时冻结词库快照，避免多房间互相影响）
    const libName = room.config.wordLib || '【简体中文】默认';
    words.setCurrentLib(libName);
    room._wordList = [...words]; // 冻结当前词库副本到房间
    // 模式分支：你画我猜 > 灵机一动 > 默认
    if (room.config.youDrawIGuess) {
      startYdigGame(room);
    } else if (room.config.cleverIdea) {
      startCleverIdeaPhase(room);
    } else {
      startWordSelection(room);
    }
  });

  // ----- 灵机一动阶段：每个玩家提供一个初始词给下家 -----
  function startCleverIdeaPhase(room) {
    room.state = 'clever_idea';
    room._cleverWords = new Map(); // playerId -> word

    // 给每位玩家发提示输入（按链条顺序，player i 给 player (i+1) % N 提供词）
    room.players.forEach((p, i) => {
      const nextPlayer = room.players[(i + 1) % room.players.length];
      const playerSocket = findPlayerSocket(p.id);
      if (playerSocket && playerSocket.connected) {
        playerSocket.emit('clever_idea_input', {
          timeout: Math.max(10, room.config.guessTime),
          forPlayer: nextPlayer.nickname
        });
      } else {
        // 离线玩家：系统随机生成
        room._cleverWords.set(p.id, pickRandomWord(room._wordList));
      }
    });

    // 超时处理
    room.timerStart = Date.now();
    room.timer = setTimeout(() => {
      room.players.forEach(p => {
        if (!room._cleverWords.has(p.id)) {
          room._cleverWords.set(p.id, pickRandomWord(room._wordList));
        }
      });
      // 广播最终进度
      const finalStatus = room.players.map(p => ({
        id: p.id, nickname: p.nickname, avatar: p.avatar,
        done: true
      }));
      io.to(room.id).emit('clever_progress', {
        submitted: room.players.length, total: room.players.length, players: finalStatus
      });
      // 进入正式选词阶段，将灵机一动的词设为候选之一
      if (!room.wordCandidates || room.wordCandidates.size === 0) {
        room.wordCandidates = new Map();
        room.chains.forEach((chain) => {
          const candidates = getRandomWords(3, room._wordList);
          room.wordCandidates.set(chain.startPlayerId, candidates);
        });
      }
      applyCleverWordsToSelection(room);
    }, Math.max(10, room.config.guessTime) * 1000);
  }

  // 将灵机一动的词整合到选词候选
  function applyCleverWordsToSelection(room) {
    room.state = 'word_select';
    room.selectedWords = new Map();
    // 玩家 i 提供的词 -> 给玩家 (i+1) % N
    room.players.forEach((p, i) => {
      const prevPlayer = room.players[(i - 1 + room.players.length) % room.players.length];
      const cleverWord = room._cleverWords.get(prevPlayer.id);
      if (cleverWord) {
        // 替换候选中的第一个为灵机一动词
        const candidates = room.wordCandidates.get(p.id);
        if (candidates && candidates.length > 0) {
          candidates[0] = cleverWord;
          // 打乱顺序，让玩家看不出哪个是上家提供的
          candidates.sort(() => Math.random() - 0.5);
        }
      }
    });
    // 将候选词重新发送给玩家
    room.chains.forEach((chain, ci) => {
      const playerSocket = findPlayerSocket(chain.startPlayerId);
      if (playerSocket && playerSocket.connected) {
        const candidates = room.wordCandidates.get(chain.startPlayerId);
        if (candidates) {
          playerSocket.emit('word_select', {
            candidates,
            timeout: room.config.guessTime,
            chainIndex: ci
          });
        }
      }
    });
    // 灵机一动路径此前缺少选词超时兜底：玩家不选词会导致游戏永久卡死
    scheduleWordSelectTimeout(room);
  }

  // ----- 灵机一动提交 -----
  socket.on('submit_clever_word', (data) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'clever_idea') return;

    // 兼容裸字符串与 { word } 对象（约定：一律传对象）
    const word = typeof data === 'string' ? data : (data && data.word);
    const cleaned = (typeof word === 'string' ? word : '').trim();
    // 客户端限 10 字符；超长/非法的输入按未提交处理（随机生成）
    const cleverWord = (cleaned && cleaned.length <= 20) ? cleaned : pickRandomWord(room._wordList);
    room._cleverWords.set(socket.id, cleverWord);

    // 广播提交进度
    const cleverStatus = room.players.map(p => ({
      id: p.id, nickname: p.nickname, avatar: p.avatar,
      done: room._cleverWords.has(p.id)
    }));
    io.to(room.id).emit('clever_progress', {
      submitted: room._cleverWords.size,
      total: room.players.length,
      players: cleverStatus
    });

    // 检查是否全部提交
    let allDone = true;
    room.players.forEach(p => {
      if (!room._cleverWords.has(p.id)) allDone = false;
    });

    if (allDone) {
      clearRoomTimer(room);
      // 先生成候选词，再整合
      room.wordCandidates = new Map();
      room.chains.forEach((chain) => {
        const candidates = getRandomWords(3, room._wordList);
        room.wordCandidates.set(chain.startPlayerId, candidates);
      });
      applyCleverWordsToSelection(room);
    } else {
      // 广播进度
      const submitted = room._cleverWords.size;
      const total = room.players.length;
      socket.emit('submit_progress', { submitted, total });
    }
  });

  // ----- 选词 -----
  function startWordSelection(room) {
    room.state = 'word_select';
    room.selectedWords = new Map();

    room.chains.forEach((chain) => {
      const candidates = getRandomWords(3, room._wordList);
      room.wordCandidates.set(chain.startPlayerId, candidates);

      const playerSocket = findPlayerSocket(chain.startPlayerId);
      if (playerSocket && playerSocket.connected) {
        playerSocket.emit('word_select', {
          candidates,
          timeout: room.config.guessTime,
          chainIndex: room.chains.indexOf(chain)
        });
      } else {
        // 玩家离线，自动选第一个
        room.selectedWords.set(chain.startPlayerId, candidates[0]);
      }
    });

    systemToast(room, '📝 起点玩家正在选词...', 2000);

    // 超时（使用猜词时间）
    scheduleWordSelectTimeout(room);
  }

  socket.on('select_word', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    // 兼容裸字符串与 { word } 对象（约定：一律传对象）
    const word = typeof data === 'string' ? data : (data && data.word);
    if (!word) return;

    // 你画我猜：仅画手可从本轮候选词中选择
    if (room.state === 'ydig_word_select') {
      const yd = room.ydig;
      if (!yd || socket.id !== yd.drawerId) return;
      if (!yd.candidates.includes(word)) return; // 只允许候选词之一
      yd.word = word;
      clearRoomTimer(room);
      startYdigHintPhase(room);
      return;
    }

    if (room.state !== 'word_select') return;

    const chain = room.chains.find(c => c.startPlayerId === socket.id);
    if (!chain) return;
    // 只允许选择候选词之一（防止绕过词库注入任意内容）
    const candidates = room.wordCandidates.get(socket.id);
    if (!candidates || !candidates.includes(word)) return;

    room.selectedWords.set(socket.id, word);
    room.selectedWords.set(chain.startPlayerId, word);
    if (!room._wordWasPlayerSelected) room._wordWasPlayerSelected = new Map();
    room._wordWasPlayerSelected.set(chain.startPlayerId, true);

    // 广播选词进度给所有玩家
    const selectStatus = room.players.map(p => ({
      id: p.id, nickname: p.nickname, avatar: p.avatar,
      done: room.selectedWords.has(p.id) || room.selectedWords.has(room.chains.find(c => c.startPlayerId === p.id)?.startPlayerId)
    }));
    io.to(room.id).emit('word_select_progress', {
      selected: room.selectedWords.size,
      total: room.chains.length,
      players: selectStatus
    });

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

  // 选词超时兜底：未选词的起点玩家自动代选并进入作画轮（普通/灵机一动共用）
  function scheduleWordSelectTimeout(room) {
    clearRoomTimer(room);
    room.timerStart = Date.now();
    room.timer = setTimeout(() => {
      if (room.state !== 'word_select') return;
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
    }, room.config.guessTime * 1000);
  }

  // ============================================================
  // 你画我猜模式：N 名玩家轮流当画手，其余人实时观看并抢答猜词
  // ============================================================
  function startYdigGame(room) {
    // 随机确定画手顺序，每人恰好一轮
    const order = room.players.map(p => p.id);
    order.sort(() => Math.random() - 0.5);
    room.ydig = {
      round: 0,
      totalRounds: room.players.length,
      order,
      usedDrawers: new Set(),
      wordCount: Math.max(1, Math.min(6, room.config.wordCount || 3)), // 开局冻结，避免局中被改
      drawTime: Math.max(10, Math.min(180, room.config.drawTime || 60)), // 开局冻结
      drawerId: null,
      candidates: [],
      word: '',
      hint: '',
      wordLength: 0,
      guesses: [],                // [{nickname, word, correct, score}]
      lastGuessByPlayer: new Map(), // playerId -> 上一次猜词
      correctIds: new Set(),      // 已猜对的玩家
      snapshot: null              // 最近画布快照（重连用）
    };
    startNextYdigRound(room);
  }

  function startNextYdigRound(room) {
    const yd = room.ydig;
    if (!yd || yd.round >= yd.totalRounds) {
      finishYdigGame(room);
      return;
    }
    yd.drawerId = yd.order[yd.round];
    yd.usedDrawers.add(yd.drawerId);
    yd.candidates = getRandomWords(yd.wordCount, room._wordList);
    yd.word = '';
    yd.hint = '';
    yd.wordLength = 0;
    yd.guesses = [];
    yd.lastGuessByPlayer = new Map();
    yd.correctIds = new Set();
    yd.snapshot = null;

    room.state = 'ydig_word_select';
    room.timerStart = Date.now();
    const drawerSocket = findPlayerSocket(yd.drawerId);
    if (drawerSocket && drawerSocket.connected) {
      drawerSocket.emit('ydig_word_select', {
        candidates: yd.candidates,
        timeout: 10,
        round: yd.round + 1,
        totalRounds: yd.totalRounds
      });
      systemToast(room, `🎯 第 ${yd.round + 1}/${yd.totalRounds} 轮：${getNickname(room, yd.drawerId)} 正在选词...`, 3000);
      // 选词超时：自动选第一个候选
      room.timer = setTimeout(() => {
        if (room.state !== 'ydig_word_select') return;
        yd.word = yd.candidates[0];
        startYdigHintPhase(room);
      }, 10 * 1000);
    } else {
      // 画手离线：自动选词继续，时间照常推进（等待其重连，时间到后进入评价）
      yd.word = yd.candidates[0];
      startYdigHintPhase(room);
    }
  }

  function startYdigHintPhase(room) {
    const yd = room.ydig;
    room.state = 'ydig_hint';
    const drawerSocket = findPlayerSocket(yd.drawerId);
    if (drawerSocket && drawerSocket.connected) {
      drawerSocket.emit('ydig_hint_input', { timeout: 10 });
    }
    room.timerStart = Date.now();
    // 10 秒未填提示：按无提示进入作画
    room.timer = setTimeout(() => {
      if (room.state !== 'ydig_hint') return;
      startYdigDrawPhase(room);
    }, 10 * 1000);
  }

  function startYdigDrawPhase(room) {
    const yd = room.ydig;
    if (!yd.word) yd.word = yd.candidates[0];
    yd.wordLength = Array.from(yd.word).length; // 按字符数统计（中文 1 个字符=1 字）
    room.state = 'ydig_draw';
    const drawerNick = getNickname(room, yd.drawerId);
    // 全员广播：答案字数 + 提示（答案本身只发给画手）
    io.to(room.id).emit('ydig_round_start', {
      round: yd.round + 1,
      totalRounds: yd.totalRounds,
      drawer: drawerNick,
      drawerId: yd.drawerId,
      wordLength: yd.wordLength,
      hint: yd.hint,
      drawTime: yd.drawTime
    });
    systemToast(room, `🎨 ${drawerNick} 开始作画！答案 ${yd.wordLength} 个字${yd.hint ? `，提示：${yd.hint}` : ''}`, 3000);
    const drawerSocket = findPlayerSocket(yd.drawerId);
    if (drawerSocket && drawerSocket.connected) {
      drawerSocket.emit('ydig_draw_start', { word: yd.word, drawTime: yd.drawTime });
    }
    room.timerStart = Date.now();
    // 作画时间到 → 本轮结束进入评价
    room.timer = setTimeout(() => {
      if (room.state !== 'ydig_draw') return;
      endYdigDrawRound(room);
    }, yd.drawTime * 1000);
  }

  function endYdigDrawRound(room) {
    if (room.state !== 'ydig_draw') return;
    clearRoomTimer(room);
    const yd = room.ydig;
    io.to(room.id).emit('ydig_round_end', {
      round: yd.round + 1,
      totalRounds: yd.totalRounds,
      word: yd.word,
      hint: yd.hint,
      correctCount: yd.correctIds.size,
      drawer: getNickname(room, yd.drawerId)
    });
    // 明确广播本轮词汇，避免玩家错过答案
    systemToast(room, `🎉 本轮答案是「${yd.word}」！${yd.correctIds.size > 0 ? `${yd.correctIds.size} 人猜对` : '没人猜对'}`, 4000);
    // 进入评价：复用相符/不相符投票，20 秒（全员投完自动缩短到 5 秒）
    room.state = 'ydig_review';
    room.votePhase = 'accuracy';
    room.votesAccuracy = new Map();
    room.timerStart = Date.now();
    io.to(room.id).emit('vote_request', {
      type: 'accuracy',
      mode: 'ydig',
      chainIndex: yd.round,
      timeout: 20,
      data: {
        mode: 'ydig',
        drawer: getNickname(room, yd.drawerId),
        drawerId: yd.drawerId,
        word: yd.word,
        hint: yd.hint,
        wordLength: yd.wordLength,
        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id) }))
      }
    });
    systemToast(room, `🗳️ 大家评价一下 ${getNickname(room, yd.drawerId)} 的画作吧！相符 +1 分`, 3000);
    room.timer = setTimeout(() => handleYdigReviewTimeout(room), 20000);
  }

  function handleYdigReviewTimeout(room) {
    if (room.state !== 'ydig_review') return;
    clearRoomTimer(room);
    const yd = room.ydig;
    let correctVotes = 0;
    room.votesAccuracy.forEach(v => { if (v === 'correct') correctVotes++; });
    addScore(room.scoreYdigDraw, yd.drawerId, correctVotes);
    io.to(room.id).emit('chain_end', { chainIndex: yd.round, mode: 'ydig', accuracyVotes: correctVotes, artworkVotes: {} });
    systemToast(room, `✅ 本轮画手 ${getNickname(room, yd.drawerId)} 获得 ${correctVotes} 张相符票`, 3000);
    // 展示 5 秒结果后进入下一轮
    room.timer = setTimeout(() => {
      yd.round++;
      if (yd.round >= yd.totalRounds) {
        finishYdigGame(room);
      } else {
        startNextYdigRound(room);
      }
    }, 5000);
  }

  function finishYdigGame(room) {
    room.state = 'finished';
    clearRoomTimer(room);
    // 猜手榜 / 画手榜 / MVP（总分=猜手分+画手分）
    const guessData = scoreMapToNames(room, room.scoreYdigGuess);
    const drawData = scoreMapToNames(room, room.scoreYdigDraw);
    const totalMap = new Map();
    room.players.forEach(p => {
      totalMap.set(p.id, (room.scoreYdigGuess.get(p.id) || 0) + (room.scoreYdigDraw.get(p.id) || 0));
    });
    const mvpData = scoreMapToNames(room, totalMap);
    room.players.forEach(p => { p.settling = true; });
    io.to(room.id).emit('game_finished', {
      mode: 'ydig',
      scoreA: guessData.scores,
      scoreB: drawData.scores,
      scoreMVP: mvpData.scores,
      titles: { accuracyBest: guessData.names, artworkBest: drawData.names, mvp: mvpData.names }
    });
    systemToast(room, '🏆 你画我猜结束！查看最终排名！', 5000);
    resetRoomAfterGame(room);
  }

  // ----- 提交画作 -----
  socket.on('submit_drawing', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    // data 是客户端传来的 base64 或 { image } 对象
    const rawImg = typeof data === 'string' ? data : (data && data.image);
    // 校验画作数据：必须是合法的 image data URL，且不能过大（防止注入非法内容）
    if (typeof rawImg !== 'string' || !rawImg.startsWith('data:image/') || rawImg.length > 5 * 1024 * 1024) {
      return;
    }
    const imgData = rawImg;

    const round = room.currentRound;
    const inReview = room.state === 'review';

    // 定位该玩家应写入的画作槽位
    let targetChain = null;
    let targetChainIndex = -1;
    let targetStepIndex = -1;
    let isCurrentSubmission = false;

    if (!inReview && round % 2 === 0) {
      // 当前是作画轮：正常提交（每名玩家每轮恰好一个任务）
      const chain = room.chains.find(c => c.steps[round] && c.steps[round].playerId === socket.id);
      if (chain) {
        targetChain = chain;
        targetChainIndex = room.chains.indexOf(chain);
        targetStepIndex = Math.floor(round / 2);
        isCurrentSubmission = true;
      }
    }

    // 补交：猜词轮/回顾阶段，从该玩家最近的作画轮往前找空白画布并覆盖
    if (!targetChain) {
      let r = inReview
        ? (room.chains[0]?.steps.length || 0) - 2 // 最后一步是猜词，倒数第二步是作画
        : round - 1;                              // 猜词轮的前一轮是作画轮
      for (; r >= 0; r -= 2) {
        const chain = room.chains.find(c => c.steps[r] && c.steps[r].playerId === socket.id);
        if (!chain) continue;
        const ci = room.chains.indexOf(chain);
        const existing = room.chainDrawings[ci]?.[Math.floor(r / 2)];
        // 仅当已有数据为空白画布（超时代填，isBlank 标记）时才覆盖
        if (existing && existing.isBlank) {
          targetChain = chain;
          targetChainIndex = ci;
          targetStepIndex = Math.floor(r / 2);
          break;
        }
      }
    }

    if (!targetChain) return;

    if (!room.chainDrawings[targetChainIndex]) room.chainDrawings[targetChainIndex] = [];
    const existingData = room.chainDrawings[targetChainIndex][targetStepIndex];
    room.chainDrawings[targetChainIndex][targetStepIndex] = {
      word: existingData?.word || pickRandomWord(room._wordList),
      data: imgData
    };

    // 补交路径（猜词轮/回顾阶段）：不计数，回顾阶段则推送画作更新
    if (!isCurrentSubmission) {
      if (room.state === 'review') {
        io.to(room.id).emit('review_drawing_update', {
          chainIndex: targetChainIndex,
          stepIndex: targetStepIndex,
          drawing: imgData
        });
      }
      return;
    }

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

    // 兼容裸字符串与 { word } 对象（约定：一律传对象），并校验长度（服务端放宽到 50 防止绕过）
    const raw = typeof data === 'string' ? data : (data && typeof data.word === 'string' ? data.word : '');
    const guess = raw.trim();
    if (guess.length > 50) return;

    const chainStepIndex = Math.floor((round - 1) / 2);
    const chain = room.chains.find(c => {
      const step = c.steps[round];
      return step && step.playerId === socket.id;
    });
    if (!chain) return;

    const chainIndex = room.chains.indexOf(chain);
    if (!room.chainGuesses[chainIndex]) room.chainGuesses[chainIndex] = [];
    // 超时代选后再收到玩家真实输入则覆盖（仅玩家有内容时覆盖）
    if (guess !== '' && room.chainGuesses[chainIndex][chainStepIndex]) {
      room.chainGuesses[chainIndex][chainStepIndex] = {
        word: guess, playerId: socket.id,
        nickname: room.players.find(p => p.id === socket.id)?.nickname || '未知',
        isSystemGenerated: false, isTimeout: false
      };
      room.submissions.add(socket.id);
      broadcastSubmitProgress(room);
      checkAllSubmitted(room);
      return;
    }
    if (room.chainGuesses[chainIndex] && room.chainGuesses[chainIndex][chainStepIndex]) return;
    if (!room.chainGuesses[chainIndex]) room.chainGuesses[chainIndex] = [];
    // data 是客户端传来的猜测词语字符串（空字符串则从词库随机选）
    const finalGuess = guess === '' ? pickRandomWord(room._wordList) : guess;
    room.chainGuesses[chainIndex][chainStepIndex] = {
      word: finalGuess,
      playerId: socket.id,
      nickname: room.players.find(p => p.id === socket.id)?.nickname || '未知',
      isSystemGenerated: false,
      isTimeout: false
    };

    room.submissions.add(socket.id);

    broadcastSubmitProgress(room);
    checkAllSubmitted(room);
  });

  // ----- 你画我猜：画手提交提示（≤5字，留空=无提示）-----
  socket.on('submit_hint', (data) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'ydig_hint') return;
    const yd = room.ydig;
    if (!yd || socket.id !== yd.drawerId) return;
    const hint = (data && typeof data.hint === 'string' ? data.hint : '').trim();
    yd.hint = hint.length > 5 ? '' : hint; // 超过 5 个字按无提示处理
    clearRoomTimer(room);
    startYdigDrawPhase(room);
  });

  // ----- 你画我猜：画手增量笔画（实时同步给观众）-----
  socket.on('ydig_draw_event', (data) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'ydig_draw') return;
    const yd = room.ydig;
    if (!yd || socket.id !== yd.drawerId) return;
    const t = data && data.t;
    if (!['begin', 'stroke', 'end', 'clear'].includes(t)) return;
    if (t === 'begin' && (typeof data.x !== 'number' || typeof data.y !== 'number')) return;
    if (t === 'stroke') {
      if (!Array.isArray(data.pts) || data.pts.length === 0 || data.pts.length > 500) return;
      for (const p of data.pts) {
        if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return;
      }
    }
    socket.to(room.id).emit('ydig_draw_event', data);
  });

  // ----- 你画我猜：画手节流上传画布快照（观众校准/重连恢复）-----
  socket.on('ydig_snapshot', (data) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'ydig_draw') return;
    const yd = room.ydig;
    if (!yd || socket.id !== yd.drawerId) return;
    const img = data && data.image;
    if (typeof img !== 'string' || !img.startsWith('data:image/') || img.length > 5 * 1024 * 1024) return;
    yd.snapshot = img;
    socket.to(room.id).emit('ydig_snapshot', { image: img });
  });

  // ----- 你画我猜：观众抢答猜词 -----
  socket.on('ydig_guess', (data) => {
    const room = findRoomBySocket(socket);
    if (!room || room.state !== 'ydig_draw') return;
    const yd = room.ydig;
    if (!yd) return;
    const word = (data && typeof data.word === 'string' ? data.word : '').trim();
    if (!word || word.length > 50) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || socket.id === yd.drawerId) return; // 画手不参与猜词
    if (yd.correctIds.has(socket.id)) return;         // 已猜对则锁定
    if (yd.lastGuessByPlayer.get(socket.id) === word) return; // 与上一次猜测相同则忽略（防刷屏）
    yd.lastGuessByPlayer.set(socket.id, word);

    const correct = word === yd.word;
    if (correct) {
      yd.correctIds.add(socket.id);
      const rank = yd.correctIds.size;
      // 第一个猜对者得（总人数-1）分，之后每往后一名 -1，最低 1 分；画手获得与猜对者相同分数
      const score = Math.max(1, (yd.totalRounds - 1) - (rank - 1));
      addScore(room.scoreYdigGuess, socket.id, score);
      addScore(room.scoreYdigDraw, yd.drawerId, score);
      yd.guesses.push({ nickname: player.nickname, word, correct: true, score });
      io.to(room.id).emit('ydig_guess_result', { nickname: player.nickname, word, correct: true, score, drawerScore: score });
      // 除画手外全部猜对 → 本轮立即结束
      if (yd.correctIds.size >= room.players.length - 1) {
        endYdigDrawRound(room);
      }
    } else {
      yd.guesses.push({ nickname: player.nickname, word, correct: false, score: 0 });
      io.to(room.id).emit('ydig_guess_result', { nickname: player.nickname, word, correct: false, score: 0 });
    }
  });

  // ----- 投票（正误）-----
  socket.on('vote_accuracy', (data) => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const { chainIndex, vote } = data;
    // 你画我猜：评价本轮画手（相符 +1 分）
    if (room.state === 'ydig_review') {
      const yd = room.ydig;
      if (!yd || yd.round !== chainIndex) return;
      if (socket.id === yd.drawerId) return; // 画手不能评价自己
      if (room.votesAccuracy.has(socket.id)) return; // 已投票
      room.votesAccuracy.set(socket.id, vote);
      // 匿名投票：不广播谁投了什么，只广播票数进度
      io.to(room.id).emit('vote_progress', {
        voted: room.votesAccuracy.size,
        total: room.players.length - 1, // 画手不参与投票
        reaction: vote === 'correct' ? '👍确实挺不错的' : '💩差点没缓过来'
      });
      // 除画手外全员投完且剩余 >5s 则缩短为 5s
      const elapsed = Date.now() - (room.timerStart || Date.now());
      const remaining = Math.max(0, 20000 - elapsed);
      if (room.votesAccuracy.size >= room.players.length - 1 && room.timer && remaining > 5000) {
        clearRoomTimer(room);
        room.timer = setTimeout(() => handleYdigReviewTimeout(room), 5000);
        io.to(room.id).emit('timer_sync', { remaining: 5 });
      }
      return;
    }
    if (room.currentChainIndex !== chainIndex) return;
    if (room.votesAccuracy.has(socket.id)) return; // 已投票

    room.votesAccuracy.set(socket.id, vote);
    // 生成可视化投票状态条：√=相似 ×=不相似 口=未投票
    // 可视化投票状态：✅=相似 ✖=不相似 口=未投票
    let voteBar = '';
    room.players.forEach(p => {
      const v = room.votesAccuracy.get(p.id);
      if (v === 'correct') voteBar += '✅';
      else if (v === 'incorrect') voteBar += '✖';
      else voteBar += '☐';
    });
    const voterStatus = room.players.map(p => ({
      playerId: p.id,
      nickname: p.nickname,
      avatar: p.avatar || '😀', latency: getLatency(p.id),
      vote: room.votesAccuracy.get(p.id) || null
    }));
    io.to(room.id).emit('vote_progress', {
      voted: room.votesAccuracy.size,
      total: room.players.length,
      voteBar,
      voterStatus
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
    io.emit('global_online', { count: --onlineCount });
    if (onlineCount === 0) stopKeepAlive(); // 最后一个玩家离开，停止保活
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
    let player = room.players.find(p => p.nickname === nickname);
    // 如果找不到但房间在大厅状态，允许重新加入（可能之前被移除了）
    if (!player) {
      if (room.state === 'lobby') {
        const finalNick = nickname;
        room.players.push({ id: socket.id, nickname: finalNick, avatar: '😀', isOwner: false, connected: true });
        socket.join(roomId);
        console.log(`[重连·重新加入] ${nickname} 回到房间 ${roomId}`);
        socket.emit('join_success', { roomId, nickname: finalNick });
        broadcastRoomUpdate(room);
        systemToast(room, `${nickname} 重新连接了`, 3000);
        return;
      }
      return socket.emit('room_error', { message: '找不到你的角色' });
    }

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

    // 迁移你画我猜数据：旧 ID → 新 ID
    if (room.ydig) {
      const yd = room.ydig;
      if (yd.drawerId === oldPlayerId) yd.drawerId = socket.id;
      yd.order = yd.order.map(id => id === oldPlayerId ? socket.id : id);
      if (yd.usedDrawers.has(oldPlayerId)) { yd.usedDrawers.delete(oldPlayerId); yd.usedDrawers.add(socket.id); }
      if (yd.correctIds.has(oldPlayerId)) { yd.correctIds.delete(oldPlayerId); yd.correctIds.add(socket.id); }
      if (yd.lastGuessByPlayer.has(oldPlayerId)) {
        yd.lastGuessByPlayer.set(socket.id, yd.lastGuessByPlayer.get(oldPlayerId));
        yd.lastGuessByPlayer.delete(oldPlayerId);
      }
    }
    [room.scoreYdigGuess, room.scoreYdigDraw].forEach(scoreMap => {
      if (!scoreMap) return;
      if (scoreMap.has(oldPlayerId)) {
        scoreMap.set(socket.id, scoreMap.get(oldPlayerId));
        scoreMap.delete(oldPlayerId);
      }
    });

    // 清理断线记录
    if (room._disconnected) room._disconnected.delete(oldPlayerId);

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
      const isYdig = room.state.startsWith('ydig_');
      const ydigRound = room.ydig ? room.ydig.round : 0;
      const totalRounds = isYdig ? (room.ydig ? room.ydig.totalRounds : 0) : 2 * room.K;
      socket.emit('reconnect_game', {
        roomId,
        state: room.state,
        mode: isYdig ? 'ydig' : 'classic',
        K: room.K,
        currentRound: isYdig ? ydigRound : room.currentRound,
        totalRounds,
        config: room.config
      });

      // 根据当前状态发送对应任务
      if (isYdig) {
        // 你画我猜：下发当前阶段全量状态
        const yd = room.ydig;
        const isDrawer = !!(yd && yd.drawerId === socket.id);
        socket.emit('ydig_state', {
          state: room.state,
          round: yd ? yd.round + 1 : 1,
          totalRounds: yd ? yd.totalRounds : 0,
          drawer: yd ? getNickname(room, yd.drawerId) : '',
          drawerId: yd ? yd.drawerId : null,
          isDrawer,
          word: isDrawer && yd ? yd.word : undefined,
          wordLength: yd ? yd.wordLength : 0,
          hint: yd ? yd.hint : '',
          candidates: (room.state === 'ydig_word_select' && isDrawer && yd) ? yd.candidates : undefined,
          snapshot: yd ? yd.snapshot : null,
          guesses: yd ? yd.guesses.slice(-50) : [],
          myCorrect: !!(yd && yd.correctIds.has(socket.id)),
          lastGuess: yd ? (yd.lastGuessByPlayer.get(socket.id) || null) : null
        });
        const remain = getRemaining(room, room.state === 'ydig_draw' ? (yd ? yd.drawTime : room.config.drawTime) : 10);
        socket.emit('timer_sync', { remaining: remain });
        // 评价阶段重发投票请求
        if (room.state === 'ydig_review') {
          socket.emit('vote_request', {
            type: 'accuracy', mode: 'ydig', chainIndex: yd.round, timeout: getRemaining(room, 20),
            data: {
              mode: 'ydig',
              drawer: getNickname(room, yd.drawerId),
              drawerId: yd.drawerId,
              word: yd.word,
              hint: yd.hint,
              wordLength: yd.wordLength,
              players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id) })),
              myVote: room.votesAccuracy.get(socket.id) || null
            }
          });
        }
      } else if (room.state === 'word_select') {
        // 选词阶段：重发 word_select（如果该玩家是起点）
        room.chains.forEach((chain, ci) => {
          if (chain.startNickname === nickname) {
            const candidates = room.wordCandidates.get(chain.startPlayerId);
            if (candidates) {
              socket.emit('word_select', { candidates, timeout: getRemaining(room, room.config.guessTime), chainIndex: ci });
            }
          }
        });
      } else if (room.state.startsWith('draw_') || room.state.startsWith('guess_')) {
        // 作画/猜词阶段：先重发 round_start（设置 state.submitted），再发 submit_progress（显示弹窗）
        const submittedIds = [];
        room.submissions.forEach(id => submittedIds.push(id));
        const round = room.currentRound;
        const isDraw = round % 2 === 0;
        const chainStepIndex = Math.floor(round / 2);
        room.chains.forEach((chain, chainIndex) => {
          const step = chain.steps[round];
          if (!step || step.nickname !== nickname) return;
          if (isDraw) {
            let wordToDraw;
            if (round === 0) {
              wordToDraw = room.selectedWords.get(chain.startPlayerId) || pickRandomWord(room._wordList);
            } else {
              const prevGuess = room.chainGuesses[chainIndex] && room.chainGuesses[chainIndex][chainStepIndex - 1];
              wordToDraw = prevGuess ? prevGuess.word : pickRandomWord(room._wordList);
            }
            const existingDraw = room.chainDrawings[chainIndex]?.[chainStepIndex]?.data || null;
            socket.emit('round_start', {
              round: round + 1, totalRounds, type: 'draw',
              timeout: getRemaining(room, room.config.drawTime),
              yourTask: { word: wordToDraw, existingDrawing: existingDraw },
              chainIndex
            });
          } else {
            const prevDraw = room.chainDrawings[chainIndex] && room.chainDrawings[chainIndex][chainStepIndex];
            // 检查该玩家是否已提交猜词
            const existingGuessData = room.chainGuesses[chainIndex]?.[chainStepIndex];
            const hasGuessed = !!(existingGuessData && existingGuessData.word);
            socket.emit('round_start', {
              round: round + 1, totalRounds, type: 'guess',
              timeout: getRemaining(room, room.config.guessTime),
              yourTask: {
                imageBase64: prevDraw?.data || null,
                fromPlayer: chain.steps[round - 1]?.nickname || '',
                existingGuess: hasGuessed ? existingGuessData.word : null
              },
              chainIndex
            });
          }
        });
        // 如果剩余时间极少，直接触发超时处理，避免卡死
        let timerExpired = false;
        if (room.timerStart) {
          const elapsed = Date.now() - room.timerStart;
          const totalDur = (isDraw ? room.config.drawTime : room.config.guessTime) * 1000;
          if (elapsed >= totalDur) {
            clearRoomTimer(room);
            handleRoundTimeout(room);
            timerExpired = true;
          }
        }
        // 同步倒计时，让客户端定时器从服务端的剩余时间开始
        socket.emit('timer_sync', { remaining: getRemaining(room, isDraw ? room.config.drawTime : room.config.guessTime) });
        // 再发送当前提交进度（仅当确实有提交时才发）
        if (!timerExpired && room.submissions.size > 0) socket.emit('submit_progress', {
          submitted: room.submissions.size,
          total: room.chains.length,
          submittedIds,
          players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id) }))
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
                    const myCurrentVote = room.votesAccuracy.get(socket.id) || null;
          socket.emit('vote_request', {
            type: 'accuracy', chainIndex, timeout: getRemaining(room, 20),
            data: { initWord, finalGuess, isSystemGenerated: isSystem, drawerNickname: lastStep?.nickname || '',
              players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id) })),
              myVote: myCurrentVote }
          });
          // 同步已有投票进度
          let voteBar = '';
          room.players.forEach(p => {
            const v = room.votesAccuracy.get(p.id);
            if (v === 'correct') voteBar += '✅';
            else if (v === 'incorrect') voteBar += '✖';
            else voteBar += '☐';
          });
          const voterStatus2 = room.players.map(p => ({
            playerId: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id),
            vote: room.votesAccuracy.get(p.id) || null
          }));
          socket.emit('vote_progress', { voted: room.votesAccuracy.size, total: room.players.length, voteBar, voterStatus: voterStatus2 });
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
              prompt: dd.word || '',
              isBlank: dd.isBlank || false
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

  // 已移除：reconnect_request 曾被任意房间成员用来顶替他人身份（含房主）。
  // 真实重连走 reconnect_to_room（按昵称找回角色），前端不再使用该事件。

  // ----- 返回大厅 -----
  socket.on('back_to_lobby', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const wasOwner = player.isOwner;

    // 从房间移除该玩家
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(room.id);
    socket.emit('leave_room_ok');

    // 如果房间空了，删除房间
    if (room.players.length === 0) {
      rooms.delete(room.id);
      return;
    }

    // 如果离开的是房主，转移给另一个在线玩家
    if (wasOwner) {
      const nextOwner = room.players.find(p => p.connected);
      if (nextOwner) nextOwner.isOwner = true;
    }

    // 清除离开者的结算标记即可，不影响其他玩家
    clearRoomTimer(room);
    broadcastRoomUpdate(room);
    const newOwner = room.players.find(p => p.isOwner);
    const leaveMsg = newOwner
      ? `${player.nickname} 离开了房间，${newOwner.nickname} 成为新房主`
      : `${player.nickname} 离开了房间`;
    systemToast(room, leaveMsg, 3000);
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

function getNickname(room, playerId) {
  const p = room.players.find(x => x.id === playerId);
  return p ? p.nickname : '未知';
}

function addScore(map, playerId, points) {
  if (!map || !playerId || !(points > 0)) return;
  map.set(playerId, (map.get(playerId) || 0) + points);
}

// 将分数 Map 转为 { scores: {昵称:分}, names: [最高分昵称...] }（支持并列）
function scoreMapToNames(room, map) {
  const scores = {};
  let max = 0;
  const names = [];
  map.forEach((score, playerId) => {
    const player = room.players.find(p => p.id === playerId);
    if (player) scores[player.nickname] = score;
    if (score > max) { max = score; names.length = 0; }
    if (score >= max && player) names.push(player.nickname);
  });
  return { scores, names };
}

function broadcastSubmitProgress(room) {
  const submitted = room.submissions.size;
  const total = room.chains.length;
  const submittedIds = [];
  room.submissions.forEach(id => submittedIds.push(id));
  io.to(room.id).emit('submit_progress', {
    submitted,
    total,
    submittedIds,
    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar || '😀', latency: getLatency(p.id) }))
  });
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

  if (SELF_URL) {
    console.log('  🔄 Render 保活待命 (有玩家在线时自动启动)');
  }
});
