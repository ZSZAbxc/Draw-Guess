/* ================================================================
   传画接龙 — 前端游戏逻辑 (Socket.IO 客户端)
   ================================================================ */

// ---- 全局状态 ----
const state = {
  roomId: null,
  myNickname: '',
  myId: null,
  isOwner: false,
  players: [],
  phase: 'entry',          // entry | lobby | game | review | result
  round: 0,
  K: 0,
  totalRounds: 0,
  roundType: '',           // draw | guess
  myTask: null,
  chainIndex: null,
  stepIndex: -1,
  timerEnd: 0,
  timerInterval: null,
  timerDuration: 0,
  submitted: false,
  disconnectToast: null,
  reviewChains: [],
  reviewStepTimer: null,
};

// ---- DOM 引用 ----
const $ = id => document.getElementById(id);
const dom = {};

// 入口
dom.entryNickname      = $('entry-nickname');
dom.btnCreateRoom      = $('btn-create-room');
dom.btnJoinRoom        = $('btn-join-room');
dom.entryJoinFields    = $('entry-join-fields');
dom.entryRoomId        = $('entry-room-id');
dom.entryPassword      = $('entry-password');
dom.entryError         = $('entry-error');
dom.btnJoinConfirm     = $('btn-join-confirm');
dom.btnJoinBack        = $('btn-join-back');

// 大厅
dom.playerList         = $('player-list');
dom.lobbyRoomIdDisplay = $('lobby-room-id-display');
dom.lobbyPlayerCount   = $('lobby-player-count');
dom.drawTimeSlider     = $('draw-time-slider');
dom.guessTimeSlider    = $('guess-time-slider');
dom.drawTimeDisplay    = $('draw-time-display');
dom.guessTimeDisplay   = $('guess-time-display');
dom.btnStartGame       = $('btn-start-game');
dom.lobbyWaiting       = $('lobby-waiting');
dom.settingsPanel      = $('settings-panel');
dom.wordlibDisplay     = $('wordlib-display');
dom.wordlibSelector    = $('wordlib-selector');

// 游戏
dom.roundInfo          = $('round-info');
dom.timerDisplay       = $('timer-display');
dom.taskInfo           = $('task-info');
dom.drawArea           = $('draw-area');
dom.guessArea          = $('guess-area');
dom.drawCanvas         = $('draw-canvas');
dom.drawWordDisplay    = $('draw-word-display');
dom.colorPalette       = $('color-palette');
dom.btnClearCanvas     = $('btn-clear-canvas');
dom.btnSubmitDrawing   = $('btn-submit-drawing');
dom.drawWaiting        = $('draw-waiting');
dom.drawProgress       = $('draw-progress');
dom.guessImage         = $('guess-image');
dom.guessInput         = $('guess-input');
dom.btnSubmitGuess     = $('btn-submit-guess');
dom.guessWaiting       = $('guess-waiting');
dom.guessProgress      = $('guess-progress');
dom.wordSelectOverlay  = $('word-select-overlay');
dom.wordCandidates     = $('word-candidates');
dom.wordSelectTimer    = $('word-select-timer');

// 聊天
dom.lobbyChatInput     = $('lobby-chat-input');
dom.lobbyChatSend      = $('lobby-chat-send');
dom.lobbyMsgList       = $('lobby-msg-list');
dom.gameChatInput      = $('game-chat-input');
dom.gameChatSend       = $('game-chat-send');
dom.gameMsgList        = $('game-msg-list');

// 回顾
dom.reviewContent      = $('review-content');
dom.reviewChainTitle   = $('review-chain-title');
dom.reviewImage        = $('review-image');
dom.reviewTextArea     = $('review-text-area');
dom.reviewProgressFill = $('review-progress-fill');
dom.voteOverlay        = $('vote-overlay');
dom.voteTitle          = $('vote-title');
dom.voteBody           = $('vote-body');
dom.voteTimer          = $('vote-timer');
dom.voteProgress       = $('vote-progress');

// 结果
dom.resultA            = $('result-a');
dom.resultB            = $('result-b');
dom.resultScores       = $('result-scores');
dom.btnBackToLobby     = $('btn-back-to-lobby');
dom.btnBackToRoom      = $('btn-back-to-room');

// 通用
dom.disconnectBanner   = $('disconnect-banner');
dom.imageModal         = $('image-modal');
dom.imageModalImg      = $('image-modal-img');
dom.toastContainer     = $('toast-container');
dom.loadingOverlay     = $('loading-overlay');

// ---- 页面切换 ----
function showPage(name) {
  ['page-entry','page-lobby','page-game','page-review','page-result'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== 'page-'+name);
  });
  // 入口页隐藏聊天框，其他页面显示
  const showChat = name !== 'entry';
  ['lobby-chat','game-chat'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', !showChat);
  });
  state.phase = name;
}

// ---- Toast 提示 ----
function showToast(text, duration) {
  duration = duration || 3500;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  dom.toastContainer.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration + 500);
}

// ---- 图片放大 ----
function openImageModal(src) {
  if (!src) return;
  dom.imageModalImg.src = src;
  dom.imageModal.classList.remove('hidden');
}
function closeImageModal() {
  dom.imageModal.classList.add('hidden');
}

// ================================================================
//   Canvas 绘图
// ================================================================
const canvas = dom.drawCanvas;
let ctx = null;
let isDrawing = false;
let lastX = 0, lastY = 0;
let selectedColor = '#000000';

function initCanvas() {
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  resizeCanvas();
  setupCanvasEvents();
  buildPalette();
  dom.btnClearCanvas.addEventListener('click', clearCanvas);
}

function resizeCanvas() {
  const wrapper = canvas.parentElement;
  if (!wrapper) return;
  const w = Math.min(wrapper.clientWidth - 8, window.innerWidth * 0.85);
  const h = Math.min(wrapper.clientHeight - 8, window.innerHeight * 0.7);
  // 只在尺寸变化时重置
  if (canvas.width !== w || canvas.height !== h) {
    const data = ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = w;
    canvas.height = h;
    if (ctx) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (data && w > 0 && h > 0) {
        ctx.putImageData(data, 0, 0);
      } else {
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, w, h);
      }
    }
  }
}

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  let clientX, clientY;
  if (e.touches) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
    e.preventDefault();
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

function startDrawing(e) {
  if (!ctx) return;
  e.preventDefault();
  isDrawing = true;
  const pos = getCanvasPos(e);
  lastX = pos.x;
  lastY = pos.y;
}

function draw(e) {
  if (!isDrawing || !ctx) return;
  e.preventDefault();
  const pos = getCanvasPos(e);
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(pos.x, pos.y);
  ctx.strokeStyle = selectedColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  lastX = pos.x;
  lastY = pos.y;
}

function stopDrawing(e) {
  if (e) e.preventDefault();
  isDrawing = false;
}

function setupCanvasEvents() {
  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseleave', stopDrawing);
  canvas.addEventListener('touchstart', startDrawing, {passive:false});
  canvas.addEventListener('touchmove', draw, {passive:false});
  canvas.addEventListener('touchend', stopDrawing, {passive:false});
}

function buildPalette() {
  const colors = [
    '#000000','#ffffff','#e74c3c','#e67e22','#f1c40f','#2ecc71',
    '#1abc9c','#3498db','#9b59b6','#e84393','#95a5a6','#8B4513'
  ];
  dom.colorPalette.innerHTML = '';
  colors.forEach(c => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch' + (c === selectedColor ? ' active' : '');
    swatch.style.background = c;
    if (c === '#ffffff') swatch.style.border = '2px solid #888';
    swatch.dataset.color = c;
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      selectedColor = c;
    });
    dom.colorPalette.appendChild(swatch);
  });
}

function clearCanvas() {
  if (!ctx) return;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function getCanvasDataURL() {
  if (!canvas) return '';
  return canvas.toDataURL('image/png');
}

function loadDrawingToCanvas(dataURL) {
  if (!ctx) return;
  const img = new Image();
  img.onload = () => {
    clearCanvas();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = dataURL;
}

// ================================================================
//   倒计时
// ================================================================
function startTimer(duration, onEnd) {
  stopTimer();
  state.timerEnd = Date.now() + duration * 1000;
  state.timerDuration = duration;
  updateTimerDisplay();
  state.timerInterval = setInterval(() => {
    const remaining = Math.ceil((state.timerEnd - Date.now()) / 1000);
    if (remaining <= 0) {
      stopTimer();
      dom.timerDisplay.textContent = '0s';
      dom.voteTimer.textContent = '0s';
      if (onEnd) onEnd();
    } else {
      dom.timerDisplay.textContent = remaining + 's';
      // 同步更新投票弹窗内的倒计时和进度条
      if (!dom.voteOverlay.classList.contains('hidden')) {
        dom.voteTimer.textContent = remaining + 's';
        const bar = document.getElementById('vote-progress-bar');
        if (bar) {
          const pct = ((state.timerDuration - remaining) / state.timerDuration) * 100;
          bar.style.width = Math.min(100, pct) + '%';
        }
      }
    }
  }, 200);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function updateTimerDisplay() {
  const remaining = Math.max(0, Math.ceil((state.timerEnd - Date.now()) / 1000));
  dom.timerDisplay.textContent = remaining + 's';
}

// ================================================================
//   Socket.IO
// ================================================================
let socket = null;

function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    dom.disconnectBanner.classList.add('hidden');
    state.myId = socket.id;
    showToast('✅ 已连接服务器');
    // 尝试重连到之前的房间
    const prevRoom = localStorage.getItem('draw_roomId');
    const prevNick = localStorage.getItem('draw_nickname');
    if (prevRoom && prevNick) {
      socket.emit('reconnect_to_room', { roomId: prevRoom, nickname: prevNick });
    }
  });

  socket.on('disconnect', () => {
    dom.disconnectBanner.classList.remove('hidden');
    stopTimer();
  });

  socket.on('connect_error', () => {
    showToast('⚠️ 连接服务器失败，请刷新重试');
  });

  // ---- 房间相关 ----
  socket.on('room_update', (data) => {
    state.roomId = data.id;
    state.players = data.players;
    state.isOwner = data.players.some(p => p.id === state.myId && p.isOwner);
    state.config = data.config;
    // 如果还在入口页或加载中，切到大厅
    if (state.phase === 'entry') {
      dom.loadingOverlay.classList.add('hidden');
      showPage('lobby');
    }
    updateLobbyUI(data);
  });

  socket.on('player_joined', (data) => {
    showToast(`👋 ${data.nickname} 加入了房间`);
  });

  socket.on('player_left', (data) => {
    showToast(`🚪 ${data.nickname} 离开了房间`);
  });

  socket.on('system_toast', (data) => {
    showToast(data.message, data.duration);
  });

  socket.on('timer_sync', (data) => {
    // 同步服务端剩余时间
    state.timerEnd = Date.now() + data.remaining * 1000;
    state.timerDuration = data.remaining;
  });

  // ---- 游戏开始 ----
  socket.on('game_started', (data) => {
    state.K = data.K;
    state.totalRounds = data.K * 2;
    state.round = 0;
    state.submitted = false;
    dom.wordSelectOverlay.classList.add('hidden');
    showPage('game');
    showToast(`🎮 游戏开始！共 ${state.totalRounds} 轮`);
  });

  // ---- 选词 ----
  socket.on('word_select', (data) => {
    state.phase = 'word_select';
    state.submitted = false;
    showWordSelect(data.candidates, data.timeout);
    startTimer(data.timeout, () => {
      // 超时自动选择第一个
      socket.emit('select_word', data.candidates[0]);
      dom.wordSelectOverlay.classList.add('hidden');
    });
  });

  // ---- 轮次开始 ----
  socket.on('round_start', (data) => {
    state.round = data.round;
    state.roundType = data.type;
    state.myTask = data.yourTask;
    state.submitted = false;
    const roundNum = data.round + 1;
    dom.roundInfo.textContent = `第 ${roundNum}/${state.totalRounds} 轮 · ${data.type === 'draw' ? '✏️ 作画' : '💬 猜词'}`;
    dom.taskInfo.textContent = '';
    dom.drawArea.classList.add('hidden');
    dom.guessArea.classList.add('hidden');
    dom.drawWaiting.classList.add('hidden');
    dom.guessWaiting.classList.add('hidden');

    if (data.type === 'draw') {
      dom.drawWordDisplay.textContent = '🎯 ' + data.yourTask.word;
      dom.drawWordDisplay.classList.remove('hidden');
      dom.drawArea.classList.remove('hidden');
      clearCanvas();
      resizeCanvas();
      dom.btnSubmitDrawing.disabled = false;
      dom.btnSubmitDrawing.textContent = '✅ 提交画作';
      startTimer(data.timeout, () => {
        if (!state.submitted) {
          socket.emit('submit_drawing', getCanvasDataURL());
          state.submitted = true;
          dom.btnSubmitDrawing.disabled = true;
          dom.drawWaiting.classList.remove('hidden');
        }
      });
    } else {
      dom.drawArea.classList.add('hidden');
      dom.guessArea.classList.remove('hidden');
      dom.guessImage.src = data.yourTask.imageBase64;
      dom.guessInput.value = '';
      dom.guessInput.disabled = false;
      dom.btnSubmitGuess.disabled = false;
      dom.btnSubmitGuess.textContent = '✅ 确认';
      startTimer(data.timeout, () => {
        if (!state.submitted) {
          const text = dom.guessInput.value.trim();
          const word = text || guessFallback();
          socket.emit('submit_guess', word);
          state.submitted = true;
          dom.guessInput.disabled = true;
          dom.btnSubmitGuess.disabled = true;
          dom.guessWaiting.classList.remove('hidden');
        }
      });
    }
  });

  // ---- 提交进度 ----
  socket.on('submit_progress', (data) => {
    if (state.roundType === 'draw') {
      dom.drawProgress.textContent = `${data.submitted}/${data.total}`;
      dom.drawWaiting.classList.remove('hidden');
    } else {
      dom.guessProgress.textContent = `${data.submitted}/${data.total}`;
      dom.guessWaiting.classList.remove('hidden');
    }
  });

  // ---- 轮次结束 ----
  socket.on('round_end', () => {
    stopTimer();
    dom.drawArea.classList.add('hidden');
    dom.guessArea.classList.add('hidden');
    dom.drawWaiting.classList.add('hidden');
    dom.guessWaiting.classList.add('hidden');
  });

  // ---- 回顾 ----
  socket.on('review_start', (data) => {
    stopTimer();
    showPage('review');
    state.reviewChains = [];
    dom.reviewProgressFill.style.width = '0%';
  });

  socket.on('review_step', (data) => {
    showReviewStep(data);
  });

  // ---- 投票 ----
  socket.on('vote_request', (data) => {
    showVoteUI(data);
  });

  socket.on('vote_progress', (data) => {
    if (data.voteBar) {
      let colored = data.voteBar.replace(/❎/g, '<span style="color:#ff4444">❎</span>');
      colored = colored.replace(/☐/g, '<span style="display:inline-block;width:1.2em;text-align:center">☐</span>');
      dom.voteProgress.innerHTML = `已投票 ${data.voted}/${data.total}<br><span style="font-size:2em;letter-spacing:8px">${colored}</span>`;
    } else {
      dom.voteProgress.textContent = `已投票 ${data.voted}/${data.total}`;
    }
    // 画作投票：所有人同步显示爱心标记 + 投票者名字
    if (data.votedPlayerId) {
      document.querySelectorAll('.artwork-card').forEach(card => {
        const pid = card.dataset.playerId;
        if (pid === data.votedPlayerId) {
          card.style.position = 'relative';
          // 右侧爱心列表（每个投票者一个爱心）
          let heartList = card.querySelector('.heart-list');
          if (!heartList) {
            heartList = document.createElement('div');
            heartList.className = 'heart-list';
            heartList.style.cssText = 'position:absolute;top:4px;right:4px;display:flex;flex-direction:column;gap:2px;';
            card.appendChild(heartList);
          }
          const heart = document.createElement('div');
          heart.textContent = '❤️';
          heart.style.cssText = 'font-size:32px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));';
          heartList.appendChild(heart);

          // 左侧投票者名字列表
          let nameList = card.querySelector('.voter-names');
          if (!nameList) {
            nameList = document.createElement('div');
            nameList.className = 'voter-names';
            nameList.style.cssText = 'position:absolute;top:4px;left:4px;display:flex;flex-direction:column;gap:3px;max-height:calc(100% - 8px);overflow-y:auto;';
            card.appendChild(nameList);
          }
          const nameTag = document.createElement('span');
          nameTag.textContent = data.voterNickname;
          nameTag.style.cssText = 'background:rgba(233,69,96,0.85);color:white;padding:2px 8px;border-radius:4px;font-size:13px;font-weight:bold;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.3);';
          nameList.appendChild(nameTag);
        }
      });
    }
  });

  socket.on('chain_end', (data) => {
    dom.voteOverlay.classList.add('hidden');
    showToast(`✅ 第 ${data.chainIndex+1} 条链条回顾完成`);
  });

  // ---- 游戏结束 ----
  socket.on('game_finished', (data) => {
    showPage('result');
    dom.resultA.textContent = data.titles.accuracyBest.length > 0 ? data.titles.accuracyBest.join('、') : '无';
    dom.resultB.textContent = data.titles.artworkBest.length > 0 ? data.titles.artworkBest.join('、') : '无';
    dom.resultScores.textContent = `总分详情已记录`;
  });

  socket.on('back_to_room_ok', () => {
    showPage('lobby');
    showToast('🔄 已返回房间');
  });

  socket.on('reconnect_game', (data) => {
    state.K = data.K;
    state.totalRounds = data.totalRounds;
    state.round = data.currentRound;
    state.config = data.config;
    localStorage.setItem('draw_roomId', data.roomId);
    showPage('game');
    showToast(`🔄 已重连到游戏中（第 ${data.currentRound+1}/${data.totalRounds} 轮）`);
    // 隐藏所有游戏子界面，等待服务端发送对应事件恢复
    dom.drawArea.classList.add('hidden');
    dom.guessArea.classList.add('hidden');
    dom.drawWaiting.classList.add('hidden');
    dom.guessWaiting.classList.add('hidden');
    dom.wordSelectOverlay.classList.add('hidden');
    dom.voteOverlay.classList.add('hidden');
  });

  // ---- 聊天 ----
  socket.on('chat_msg_broadcast', (data) => {
    addChatMessage('game', data.nickname, data.text);
    addChatMessage('lobby', data.nickname, data.text);
  });

  // ---- 错误 ----
  socket.on('error_msg', (data) => {
    showToast('⚠️ ' + data.message);
  });

  socket.on('room_error', (data) => {
    dom.entryError.textContent = data.message;
    dom.entryError.classList.remove('hidden');
  });

  // ---- 加入结果 ----
  socket.on('join_success', (data) => {
    dom.entryError.classList.add('hidden');
    dom.loadingOverlay.classList.add('hidden');
    showPage('lobby');
    localStorage.setItem('draw_roomId', data.roomId);
    localStorage.setItem('draw_nickname', data.nickname);
  });

  // ---- 创建结果 ----
  socket.on('create_success', (data) => {
    showToast('✅ 创建成功，进入大厅');
    dom.entryError.classList.add('hidden');
    dom.loadingOverlay.classList.add('hidden');
    showPage('lobby');
    localStorage.setItem('draw_roomId', data.roomId);
    localStorage.setItem('draw_nickname', data.nickname);
  });
}

// 超时随机词
function guessFallback() {
  const fallbacks = ['猫','狗','苹果','花','太阳','房子','鱼','鸟','树','月亮'];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ================================================================
//   选词界面
// ================================================================
function showWordSelect(candidates, timeout) {
  dom.wordCandidates.innerHTML = '';
  candidates.forEach(word => {
    const btn = document.createElement('button');
    btn.className = 'word-candidate-btn';
    btn.textContent = word;
    btn.addEventListener('click', () => {
      socket.emit('select_word', word);
      dom.wordSelectOverlay.classList.add('hidden');
    });
    dom.wordCandidates.appendChild(btn);
  });
  dom.wordSelectOverlay.classList.remove('hidden');
}

// ================================================================
//   回顾界面
// ================================================================
function showReviewStep(data) {
  const info = data.data || {};
  dom.reviewChainTitle.textContent = `第 ${data.chainIndex+1} 条链条`;
  dom.reviewTextArea.innerHTML = '';

  if (data.type === 'chain_intro') {
    dom.reviewTextArea.innerHTML = `由 <strong>${info.startPlayer}</strong> 发起`;
    dom.reviewImage.classList.add('hidden');
    const label = document.getElementById('review-artist-label');
    if (label) label.textContent = '';
    return;
  }

  // 画作保持：猜词时不清除上一张画，直到新画出现
  dom.reviewImage.classList.remove('hidden');

  if (info.drawing) {
    // 画作步骤：更新图片 + 作者标签（持续到下一张画出现）
    dom.reviewImage.src = info.drawing;
    const label = document.getElementById('review-artist-label');
    if (label) label.textContent = `✏️ ${info.player}`;
  }
  // else: 猜词步骤—保留上一张画和作者标签，不碰

  if (data.type === 'init_word_and_draw') {
    dom.reviewTextArea.innerHTML = `初始词：<strong>${info.word}</strong>`;
  } else if (data.type === 'guess_normal') {
    dom.reviewTextArea.innerHTML = `${info.player} 猜：<strong>${info.word}</strong>`;
  } else if (data.type === 'guess_timeout') {
    dom.reviewTextArea.innerHTML = `${info.player} 猜：<strong class="system-word">${info.word}（系统生成·超时）</strong>`;
  } else if (data.type === 'draw_step' || data.type === 'final_draw') {
    dom.reviewTextArea.innerHTML = `词语：<strong>${info.word}</strong>`;
  } else if (data.type === 'final_guess') {
    let html = `${info.player} 最终猜词：<strong>${info.word}</strong>`;
    if (info.isSystemGenerated) {
      html = `${info.player} 最终猜词：<strong class="system-word">${info.word}（系统生成·超时）</strong>`;
    }
    dom.reviewTextArea.innerHTML = html;
  }
}

// ================================================================
//   投票界面
// ================================================================
function showVoteUI(data) {
  const info = data.data || {}; // 服务端把内容嵌套在 data.data 中
  dom.voteOverlay.classList.remove('hidden');
  dom.voteProgress.textContent = '已投票 0/' + state.players.length;
  dom.voteBody.innerHTML = '';
  let voted = false;

  if (data.type === 'accuracy') {
    dom.voteTitle.textContent = '第 ' + (data.chainIndex+1) + ' 条 · 正误投票';
    const p = document.createElement('p');
    p.innerHTML = `初始词：<strong>${info.initWord}</strong><br>最终猜词：<strong>${info.finalGuess}</strong><br>你觉得相似吗？`;
    dom.voteBody.appendChild(p);
    const btnDiv = document.createElement('div');
    btnDiv.className = 'vote-buttons';
    const btnCorrect = document.createElement('button');
    btnCorrect.className = 'vote-btn vote-btn-correct';
    btnCorrect.textContent = '✅ 相似';
    const confirmMsg = document.createElement('p');
    confirmMsg.id = 'vote-confirm-msg';
    confirmMsg.style.cssText = 'color:#2ecc71;font-weight:bold;margin-top:10px;display:none;';
    dom.voteBody.appendChild(confirmMsg);

    btnCorrect.onclick = () => {
      if (voted) return;
      voted = true;
      socket.emit('vote_accuracy', { chainIndex: data.chainIndex, vote: 'correct' });
      btnCorrect.disabled = true;
      btnIncorrect.disabled = true;
      confirmMsg.textContent = '✅ 已投票，等待其他玩家...';
      confirmMsg.style.display = 'block';
    };
    const btnIncorrect = document.createElement('button');
    btnIncorrect.className = 'vote-btn vote-btn-incorrect';
    btnIncorrect.textContent = '❌ 不相似';
    btnIncorrect.onclick = () => {
      if (voted) return;
      voted = true;
      socket.emit('vote_accuracy', { chainIndex: data.chainIndex, vote: 'incorrect' });
      btnCorrect.disabled = true;
      btnIncorrect.disabled = true;
      confirmMsg.textContent = '✅ 已投票，等待其他玩家...';
      confirmMsg.style.display = 'block';
    };
    btnDiv.appendChild(btnCorrect);
    btnDiv.appendChild(btnIncorrect);
    dom.voteBody.appendChild(btnDiv);
  } else if (data.type === 'artwork') {
    dom.voteTitle.textContent = '第 ' + (data.chainIndex+1) + ' 条 · 画作人气投票';
    const p = document.createElement('p');
    p.textContent = '选出你最喜欢的画作！';
    dom.voteBody.appendChild(p);
    const confirmMsg = document.createElement('p');
    confirmMsg.style.cssText = 'color:#2ecc71;font-weight:bold;margin-top:10px;display:none;';
    dom.voteBody.appendChild(confirmMsg);
    const artworks = info.artworks || [];
    const grid = document.createElement('div');
    grid.className = 'artwork-grid';
    artworks.forEach((art, i) => {
      const card = document.createElement('div');
      card.className = 'artwork-card';
      card.dataset.playerId = art.playerId;
      card.innerHTML = `
        <img src="${art.drawing}" alt="${art.nickname}的画作">
        <span class="artist-name">🎨 ${art.nickname} <span style="font-size:20px;color:#888">|</span> ${art.prompt || '未知'}</span>
      `;
      card.onclick = () => {
        if (voted) return;
        voted = true;
        document.querySelectorAll('.artwork-card').forEach(el => {
          el.style.pointerEvents = 'none';
          el.classList.remove('selected');
        });
        card.classList.add('selected');
        confirmMsg.textContent = '✅ 已投票，等待其他玩家...';
        confirmMsg.style.display = 'block';
        socket.emit('vote_artwork', { chainIndex: data.chainIndex, votedPlayerId: art.playerId });
      };
      grid.appendChild(card);
    });
    dom.voteBody.appendChild(grid);
  }

  // 投票倒计时：使用 startTimer 主定时器更新弹窗内倒计时和进度条
  startTimer(data.timeout, () => {
    dom.voteOverlay.classList.add('hidden');
  });
}

// ================================================================
//   聊天
// ================================================================
// 聊天消息淡化定时器
let chatFadeCheckId = null;

function startChatFadeCheck() {
  if (chatFadeCheckId) return;
  chatFadeCheckId = setInterval(() => {
    ['lobby-msg-list', 'game-msg-list'].forEach(id => {
      const list = document.getElementById(id);
      if (!list || list.children.length === 0) return;
      const now = Date.now();

      // 如果正在淡出中：检查是否超过淡出开始时间3秒
      const fadeStart = parseInt(list.dataset.fadeStart) || 0;
      if (fadeStart > 0) {
        if (now - fadeStart >= 3000) {
          list.innerHTML = '';
          delete list.dataset.fadeStart;
        }
        return; // 淡出中，等待完成
      }

      // 找最新消息的时间
      let latest = 0;
      list.querySelectorAll('.chat-msg').forEach(el => {
        const t = parseInt(el.dataset.time) || 0;
        if (t > latest) latest = t;
      });

      // 最新消息超过15秒 → 开始淡出
      if (latest > 0 && now - latest >= 15000) {
        list.dataset.fadeStart = now;
        list.querySelectorAll('.chat-msg').forEach(el => {
          el.style.transition = 'opacity 3s ease';
          el.style.opacity = '0';
        });
      }
    });
  }, 500);
}

function addChatMessage(area, nickname, text) {
  const list = area === 'game' ? dom.gameMsgList : dom.lobbyMsgList;
  const msg = document.createElement('div');
  msg.className = 'chat-msg';
  msg.innerHTML = `<span class="chat-nick">${escapeHtml(nickname)}</span> ${escapeHtml(text)}`;
  msg.dataset.time = Date.now();
  list.appendChild(msg);
  // 淡入
  void msg.offsetHeight;
  msg.style.opacity = '0';
  msg.style.transition = 'opacity .3s ease';
  void msg.offsetHeight;
  msg.style.opacity = '1';

  // 最多保留20条
  while (list.children.length > 20) list.removeChild(list.firstChild);

  // 重置所有现有消息的透明度（取消可能的淡出）
  list.querySelectorAll('.chat-msg').forEach(el => {
    el.style.opacity = '1';
    el.style.transition = '';
  });
  delete list.dataset.fadeStart;
}

// 页面加载后启动检查
if (document.readyState !== 'loading') startChatFadeCheck();
else document.addEventListener('DOMContentLoaded', startChatFadeCheck);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function setupChat() {
  function sendLobbyMsg() {
    const text = dom.lobbyChatInput.value.trim();
    if (!text) return;
    socket.emit('chat_msg', text);
    dom.lobbyChatInput.value = '';
  }
  function sendGameMsg() {
    const text = dom.gameChatInput.value.trim();
    if (!text) return;
    socket.emit('chat_msg', text);
    dom.gameChatInput.value = '';
  }
  dom.lobbyChatSend.addEventListener('click', sendLobbyMsg);
  dom.lobbyChatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendLobbyMsg(); });
  dom.gameChatSend.addEventListener('click', sendGameMsg);
  dom.gameChatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendGameMsg(); });
}

// ================================================================
//   入口事件
// ================================================================
function setupEntryUI() {
  // ---- 创建房间 — 直接创建，无需额外输入 ----
  dom.btnCreateRoom.addEventListener('click', () => {
    const nickname = dom.entryNickname.value.trim();
    if (!nickname) { dom.entryError.textContent = '请输入昵称'; dom.entryError.classList.remove('hidden'); return; }
    dom.entryError.classList.add('hidden');
    dom.entryJoinFields.classList.add('hidden');

    socket.emit('create_room', { nickname }, (res) => {
      if (res && res.error) {
        dom.loadingOverlay.classList.add('hidden');
        dom.entryError.textContent = res.error;
        dom.entryError.classList.remove('hidden');
      }
    });
    dom.loadingOverlay.classList.remove('hidden');
    dom.loadingOverlay.querySelector('#loading-text').textContent = '创建房间中...';
  });

  // ---- 加入房间 — 显示房间号和密码输入 ----
  dom.btnJoinRoom.addEventListener('click', () => {
    const nickname = dom.entryNickname.value.trim();
    if (!nickname) { dom.entryError.textContent = '请输入昵称'; dom.entryError.classList.remove('hidden'); return; }
    dom.entryError.classList.add('hidden');
    dom.entryJoinFields.classList.remove('hidden');
    dom.entryRoomId.value = '';
      dom.entryRoomId.focus();
  });

  // ---- 确认加入 ----
  dom.btnJoinConfirm.addEventListener('click', () => {
    doJoinRoom();
  });
  dom.entryRoomId.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoinRoom();
  });
  // ---- 返回 — 隐藏加入输入 ----
  dom.btnJoinBack.addEventListener('click', () => {
    dom.entryJoinFields.classList.add('hidden');
  });
}

function doJoinRoom() {
  const nickname = dom.entryNickname.value.trim();
  const roomId = dom.entryRoomId.value.trim().toUpperCase();
  if (!nickname) { dom.entryError.textContent = '请输入昵称'; dom.entryError.classList.remove('hidden'); return; }
  if (roomId.length !== 6) { dom.entryError.textContent = '房间号为6位'; dom.entryError.classList.remove('hidden'); return; }
  dom.entryError.classList.add('hidden');
  socket.emit('join_room', { roomId, nickname }, (res) => {
    if (res && res.error) {
      dom.loadingOverlay.classList.add('hidden');
      dom.entryError.textContent = res.error;
      dom.entryError.classList.remove('hidden');
    }
  });
  dom.loadingOverlay.classList.remove('hidden');
  dom.loadingOverlay.querySelector('#loading-text').textContent = '加入房间中...';
}

// ================================================================
//   大厅 UI
// ================================================================
function updateLobbyUI(data) {
  dom.loadingOverlay.classList.add('hidden');
  dom.lobbyRoomIdDisplay.textContent = `房间号：${data.id}`;
  dom.lobbyPlayerCount.textContent = `👥 ${data.players.length} 人`;

  // 玩家列表
  dom.playerList.innerHTML = '';
  data.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.nickname;
    if (p.isOwner) {
      li.innerHTML += ' <span class="owner-badge">房主</span>';
    }
    if (p.id === state.myId) {
      li.style.color = '#e94560';
    }
    dom.playerList.appendChild(li);
  });

  // 词库选择器
  if (data.wordLibs && data.wordLibs.length > 0) {
    const current = data.config?.wordLib || '默认';
    dom.wordlibDisplay.textContent = current;
    // 只在首次或词库列表变化时刷新下拉框
    if (dom.wordlibSelector.options.length === 0 || dom.wordlibSelector.dataset.libs !== JSON.stringify(data.wordLibs.map(l=>l.name))) {
      dom.wordlibSelector.innerHTML = '';
      data.wordLibs.forEach(lib => {
        const opt = document.createElement('option');
        opt.value = lib.name;
        opt.textContent = lib.name + ' (' + lib.count + '词)';
        if (lib.name === current) opt.selected = true;
        dom.wordlibSelector.appendChild(opt);
      });
      dom.wordlibSelector.dataset.libs = JSON.stringify(data.wordLibs.map(l=>l.name));
    }
    dom.wordlibSelector.value = current;
  }

  // 房主权限
  if (state.isOwner) {
    dom.settingsPanel.classList.remove('hidden');
    dom.btnStartGame.classList.remove('hidden');
    dom.lobbyWaiting.classList.add('hidden');
  } else {
    dom.settingsPanel.classList.add('hidden');
    dom.btnStartGame.classList.add('hidden');
    dom.lobbyWaiting.classList.remove('hidden');
  }
}

// ================================================================
//   设置 & 开始
// ================================================================
function setupSettings() {
  dom.drawTimeSlider.addEventListener('input', () => {
    dom.drawTimeDisplay.textContent = dom.drawTimeSlider.value;
    if (state.isOwner && state.roomId) {
      socket.emit('update_config', { drawTime: parseInt(dom.drawTimeSlider.value), guessTime: parseInt(dom.guessTimeSlider.value) });
    }
  });
  dom.guessTimeSlider.addEventListener('input', () => {
    dom.guessTimeDisplay.textContent = dom.guessTimeSlider.value;
    if (state.isOwner && state.roomId) {
      socket.emit('update_config', { drawTime: parseInt(dom.drawTimeSlider.value), guessTime: parseInt(dom.guessTimeSlider.value) });
    }
  });
  // 词库切换
  dom.wordlibSelector.addEventListener('change', () => {
    const lib = dom.wordlibSelector.value;
    dom.wordlibDisplay.textContent = lib;
    if (state.isOwner && state.roomId) {
      socket.emit('select_wordlib', { wordLib: lib });
    }
  });

  dom.btnStartGame.addEventListener('click', () => {
    socket.emit('start_game');
  });
}

// ================================================================
//   提交画作 / 猜词
// ================================================================
function setupSubmit() {
  dom.btnSubmitDrawing.addEventListener('click', () => {
    if (state.submitted) return;
    socket.emit('submit_drawing', getCanvasDataURL());
    state.submitted = true;
    dom.btnSubmitDrawing.disabled = true;
    dom.btnSubmitDrawing.textContent = '✅ 已提交';
  });

  dom.btnSubmitGuess.addEventListener('click', () => {
    submitGuess();
  });
  dom.guessInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitGuess();
  });
}

function submitGuess() {
  if (state.submitted) return;
  const word = dom.guessInput.value.trim();
  if (!word) {
    showToast('请输入一个词语');
    return;
  }
  socket.emit('submit_guess', word);
  state.submitted = true;
  dom.guessInput.disabled = true;
  dom.btnSubmitGuess.disabled = true;
  dom.btnSubmitGuess.textContent = '✅ 已提交';
}

// ================================================================
//   返回大厅
// ================================================================
function setupBackToLobby() {
  // 返回房间：重置游戏状态
  dom.btnBackToRoom.addEventListener('click', () => {
    socket.emit('back_to_room');
    showToast('正在返回房间...');
  });

  // 返回大厅：房主转移
  dom.btnBackToLobby.addEventListener('click', () => {
    if (state.isOwner) {
      socket.emit('transfer_owner');
    }
    localStorage.removeItem('draw_roomId');
    localStorage.removeItem('draw_nickname');
    socket.disconnect();
    location.reload();
  });
}

// ================================================================
//   窗口调整
// ================================================================
window.addEventListener('resize', () => {
  if (state.phase === 'game' && state.roundType === 'draw') {
    resizeCanvas();
  }
});

// ================================================================
//   初始化
// ================================================================
function init() {
  connectSocket();
  initCanvas();
  setupChat();
  setupEntryUI();
  setupSettings();
  setupSubmit();
  setupBackToLobby();
  showPage('entry');
}

document.addEventListener('DOMContentLoaded', init);
