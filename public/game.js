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
  currentChainLength: 0,
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
dom.btnLeaveRoom       = $('btn-leave-room');
dom.btnCopyRoomId      = $('btn-copy-roomid');

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
let brushWidth = 2.5; // 细笔默认
let isEraser = false; // 是否橡皮擦模式

function initCanvas() {
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  resizeCanvas();
  setupCanvasEvents();
  buildPalette();
  dom.btnClearCanvas.addEventListener('click', clearCanvas);
  // 橡皮擦切换（与颜色互斥）
  const eraserBtn = document.getElementById('btn-eraser');
  function setEraser(enabled) {
    isEraser = enabled;
    if (eraserBtn) eraserBtn.style.borderColor = enabled ? '#e94560' : 'transparent';
    if (enabled) {
      // 取消所有颜色选中
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    }
  }
  if (eraserBtn) eraserBtn.addEventListener('click', () => setEraser(!isEraser));
  // 画笔大小切换
  const fineBtn = document.getElementById('btn-brush-fine');
  const thickBtn = document.getElementById('btn-brush-thick');
  function setBrush(size) {
    brushWidth = size;
    if (ctx) ctx.lineWidth = brushWidth;
    if (fineBtn && thickBtn) {
      [fineBtn, thickBtn].forEach(b => b.style.borderColor = 'transparent');
      (size <= 3 ? fineBtn : thickBtn).style.borderColor = '#e94560';
    }
  }
  // 默认选中细笔
  setBrush(2.5);
  if (fineBtn) fineBtn.addEventListener('click', () => setBrush(2.5));
  if (thickBtn) thickBtn.addEventListener('click', () => setBrush(12.5));
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
      ctx.lineWidth = brushWidth;
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
  ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = isEraser ? '#ffffff' : selectedColor;
  ctx.lineWidth = brushWidth;
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
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
      // 强制切换到画笔模式
      if (isEraser) {
        isEraser = false;
        const eb = document.getElementById('btn-eraser');
        if (eb) eb.style.borderColor = 'transparent';
      }
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

  // 响应服务端 ping 测量
  socket.on('ping_measure', (data) => {
    socket.emit('pong_measure', { t: data.t });
  });

  socket.on('connect', () => {
    dom.disconnectBanner.classList.add('hidden');
    state.myId = socket.id;
    showToast('✅ 已连接服务器');
    // 尝试重连到之前的房间
    const prevRoom = localStorage.getItem('draw_roomId');
    const prevNick = localStorage.getItem('draw_nickname');
    if (prevRoom && prevNick) {
      state._reconnecting = true;
      // 显示重连提示
      const banner = document.getElementById('reconnect-banner');
      if (banner) {
        banner.textContent = '你可能从一个正在进行游戏的房间断开了';
        banner.classList.remove('hidden');
      }
      setTimeout(() => {
        const b = document.getElementById('reconnect-banner');
        if (b && state._reconnecting) b.textContent = '正在尝试重连';
      }, 3000);
      socket.emit('reconnect_to_room', { roomId: prevRoom, nickname: prevNick });
      // 10秒后清除重连标记
      setTimeout(() => {
        state._reconnecting = false;
        const b = document.getElementById('reconnect-banner');
        if (b) b.classList.add('hidden');
      }, 10000);
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
    state.reviewChains = [];
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
    state.totalRounds = data.totalRounds;
    // 步骤指示器（不含自己名称）
    const total = data.totalRounds;
    const stepIdx = data.round - 1;
    const isDraw = data.type === 'draw';
    const isLast = stepIdx >= total - 1;
    const prev = data.prevPlayer;
    const next = data.nextPlayer;
    let indicator = '';
    if (isDraw && stepIdx === 0) {
      indicator = `✏️ 画(当前)→💬${next||'?'}猜`;
    } else if (!isDraw && isLast) {
      indicator = `✏️${prev||'?'}画→💬 猜(当前)`;
    } else if (!isDraw) {
      indicator = `✏️${prev||'?'}画→💬 猜(当前)→✏️${next||'?'}画`;
    } else if (isDraw) {
      indicator = `💬${prev||'?'}猜→✏️ 画(当前)→💬${next||'?'}猜`;
    }
    dom.roundInfo.textContent = indicator || `${data.type === 'draw' ? '✏️ 作画' : '💬 猜词'}`;
    dom.taskInfo.textContent = '';
    dom.drawArea.classList.add('hidden');
    dom.guessArea.classList.add('hidden');
    dom.drawWaiting.classList.add('hidden');
    dom.guessWaiting.classList.add('hidden');

    if (data.type === 'draw') {
      dom.drawWordDisplay.textContent = '🎯 ' + data.yourTask.word;
      dom.drawWordDisplay.classList.remove('hidden');
      dom.drawArea.classList.remove('hidden');
      if (data.yourTask.existingDrawing) {
        // 重连时保留已有画作
        state.submitted = true;
        resizeCanvas();
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          dom.btnSubmitDrawing.disabled = true;
          dom.btnSubmitDrawing.textContent = '✅ 已提交';
        };
        img.src = data.yourTask.existingDrawing;
      } else {
        clearCanvas();
        resizeCanvas();
        dom.btnSubmitDrawing.disabled = false;
        dom.btnSubmitDrawing.textContent = '✅ 提交画作';
      }
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
      if (data.yourTask.existingGuess) {
        // 重连时已提交猜词
        state.submitted = true;
        dom.guessInput.value = data.yourTask.existingGuess;
        dom.guessInput.disabled = true;
        dom.btnSubmitGuess.disabled = true;
        dom.btnSubmitGuess.textContent = '✅ 已提交';
      } else {
        dom.guessInput.value = '';
        dom.guessInput.disabled = false;
        dom.btnSubmitGuess.disabled = false;
        dom.btnSubmitGuess.textContent = '✅ 确认';
      }
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
    // 仅已提交的玩家显示等待弹窗
    if (state.submitted && data.submittedIds && data.submitted < data.total) {
      const modal = document.getElementById('waiting-modal');
      const list = document.getElementById('waiting-player-list');
      if (modal && list) {
        let html = '';
        const submittedIds = data.submittedIds || [];
        // 优先使用服务端下发的玩家列表（重连时 state.players 可能为空）
        const playerList = data.players && data.players.length > 0 ? data.players : state.players;
        playerList.forEach(p => {
          const isMe = p.id === state.myId;
          const done = submittedIds.includes(p.id);
          const av = p.avatar || '😀';
          let status = '';
          let color = '';
          if (isMe && done) { status = '你（已完成）'; color = '#2ecc71'; }
          else if (done) { status = '已完成'; color = '#2ecc71'; }
          else { status = state.roundType === 'guess' ? '思考中' : '作画中'; color = '#f39c12'; }
          const lat2 = p.connected === false ? '' : latencyHtml(p.latency);
          html += `<div style="color:${color}"><span style="font-size:20px;margin-right:4px">${av}</span>${p.nickname}${lat2} — ${status}</div>`;
        });
        list.innerHTML = html;
        modal.classList.remove('hidden');
      }
    }
  });

  // ---- 轮次结束 ----
  socket.on('round_end', () => {
    stopTimer();
    dom.drawArea.classList.add('hidden');
    dom.guessArea.classList.add('hidden');
    dom.drawWaiting.classList.add('hidden');
    dom.guessWaiting.classList.add('hidden');
    const modal = document.getElementById('waiting-modal');
    if (modal) modal.classList.add('hidden');
  });

  // ---- 回顾 ----
  socket.on('review_start', (data) => {
    stopTimer();
    showPage('review');
    state.reviewChains = [];
    dom.reviewProgressFill.style.width = '0%';
    // 清空回顾显示内容，防止上一局残留
    dom.reviewChainTitle.textContent = '';
    dom.reviewImage.src = '';
    dom.reviewTextArea.innerHTML = '';
    const label = document.getElementById('review-artist-label');
    if (label) label.textContent = '';
  });

  socket.on('review_step', (data) => {
    showReviewStep(data);
  });

  // ---- 投票 ----
  socket.on('vote_request', (data) => {
    showVoteUI(data);
  });

  socket.on('vote_progress', (data) => {
    // 正误投票：voteBar已被玩家列表替代，不显示底部状态条
    // 画作投票：没有 voterStatus 字段，继续显示 voteBar
    if (!data.voterStatus && data.voteBar) {
      let colored = data.voteBar.replace(/❎/g, '<span style="color:#ff4444">✖</span>');
      colored = colored.replace(/☐/g, '<span style="display:inline-block;width:1.2em;text-align:center">☐</span>');
      dom.voteProgress.innerHTML = `已投票 ${data.voted}/${data.total}<br><span style="font-size:2em;letter-spacing:8px">${colored}</span>`;
    } else if (!data.voterStatus) {
      dom.voteProgress.textContent = `已投票 ${data.voted}/${data.total}`;
    }
    // 正误投票：更新玩家状态列表
    if (data.voterStatus) {
      data.voterStatus.forEach(vs => {
        const row = document.getElementById('voter-row-' + vs.playerId);
        if (!row) return;
        const isMe = vs.playerId === state.myId;
        let statusText, statusColor;
        if (vs.vote === 'correct') { statusText = '✅ 确实挺不错的'; statusColor = '#2ecc71'; }
        else if (vs.vote === 'incorrect') { statusText = '❌ 差点没缓过来'; statusColor = '#ff4444'; }
        else { statusText = '🤔 思考中'; statusColor = '#f39c12'; }
        const lat4 = latencyHtml(vs.latency);
        row.innerHTML = `<span style="font-size:20px;margin-right:4px">${vs.avatar || '😀'}</span><span style="color:${isMe?'#e94560':'#ccc'}">${isMe?' (你)':''} ${vs.nickname}</span>${lat4} <span style="float:right;color:${statusColor}">${statusText}</span>`;
      });
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
    const status = document.getElementById('result-status');
    const totalPlayers = state.players.length;
    if (status) status.textContent = `📋 游戏已结束（${totalPlayers}人），点击"返回房间"继续`;
    // 隐藏所有可能还开着的弹窗
    dom.wordSelectOverlay.classList.add('hidden');
    dom.voteOverlay.classList.add('hidden');
    dom.drawArea.classList.add('hidden');
    dom.guessArea.classList.add('hidden');
  });

  socket.on('player_returned', (data) => {
    const status = document.getElementById('result-status');
    if (status) status.textContent = `👤 ${data.nickname} 已返回房间`;
  });

  socket.on('back_to_room_ok', () => {
    // 重置所有游戏状态
    state.K = 0;
    state.totalRounds = 0;
    state.round = 0;
    state.roundType = '';
    state.myTask = null;
    state.submitted = false;
    state.reviewChains = [];
    state.chainIndex = null;
    showPage('lobby');
    showToast('🔄 已返回房间');
  });

  socket.on('leave_room_ok', () => {
    localStorage.removeItem('draw_roomId');
    localStorage.removeItem('draw_nickname');
    showPage('entry');
    showToast('🚪 已退出房间');
  });

  socket.on('reconnect_game', (data) => {
    state.K = data.K;
    state.totalRounds = data.totalRounds;
    state.round = data.currentRound;
    state.config = data.config;
    localStorage.setItem('draw_roomId', data.roomId);
    state._reconnecting = false;
    const b = document.getElementById('reconnect-banner');
    if (b) b.classList.add('hidden');
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
    if (state._reconnecting) {
      // 重连失败
      const banner = document.getElementById('reconnect-banner');
      if (banner) {
        banner.style.background = '#e74c3c';
        banner.textContent = '房间已不存在';
        setTimeout(() => { banner.classList.add('hidden'); }, 3000);
      }
      localStorage.removeItem('draw_roomId');
      localStorage.removeItem('draw_nickname');
      state._reconnecting = false;
      return;
    }
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
    localStorage.setItem('draw_avatar', data.avatar || '😀');
    state._reconnecting = false;
    const b = document.getElementById('reconnect-banner');
    if (b) b.classList.add('hidden');
  });

  // ---- 创建结果 ----
  socket.on('create_success', (data) => {
    showToast('✅ 创建成功，进入大厅');
    dom.entryError.classList.add('hidden');
    dom.loadingOverlay.classList.add('hidden');
    showPage('lobby');
    localStorage.setItem('draw_roomId', data.roomId);
    localStorage.setItem('draw_nickname', data.nickname);
    localStorage.setItem('draw_avatar', data.avatar || '😀');
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
    dom.reviewTextArea.innerHTML = `由 <strong>${info.startPlayer}</strong> 发起<br><span style="font-size:20px;color:#aaa">初始词：${info.initWord || '（未知）'}</span>`;
    dom.reviewImage.classList.add('hidden');
    const label = document.getElementById('review-artist-label');
    if (label) label.textContent = '';
    // 记录当前链条总步数，用于步骤指示器
    state.currentChainLength = info.chainLength || 0;
    return;
  }

  // 步骤指示器
  const total = state.currentChainLength || 0;
  if (total > 0) {
    // 根据 data.type 判断当前步骤类型
    // init_word_and_draw = draw, draw_step/final_draw = draw
    // guess_normal/guess_timeout = guess, final_guess = guess
    const isGuess = data.type === 'guess_normal' || data.type === 'guess_timeout' || data.type === 'final_guess';
    const isDraw = data.type === 'init_word_and_draw' || data.type === 'draw_step' || data.type === 'final_draw';
    // chainStepIdx: 0 = draw, 1 = guess, 2 = draw, 3 = guess, ...
    const chainStepIdx = data.stepIndex ? data.stepIndex - 1 : 0;
    const isLast = chainStepIdx >= total - 1;

    let indicator = '';
    // 通过 info.player 获取当前步骤的玩家名
    const curPlayer = info.player || '';
    if (isDraw && chainStepIdx === 0) {
      indicator = `✏️ ${curPlayer}画(当前)→💬猜`;
    } else if (isGuess && isLast) {
      const prevDrawPlayer = info.player || '';
      indicator = `✏️画→💬 ${curPlayer}猜(当前)`;
    } else if (isGuess) {
      indicator = `✏️画→💬 ${curPlayer}猜(当前)→✏️画`;
    } else if (isDraw) {
      indicator = `💬猜→✏️ ${curPlayer}画(当前)→💬猜`;
    }
    if (indicator) {
      dom.reviewChainTitle.innerHTML = `第 ${data.chainIndex+1} 条链条 &nbsp;|&nbsp; <span style="font-size:24px;color:#f39c12">${indicator}</span>`;
    }
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
    // 初始词和最终猜词
    const p = document.createElement('p');
    p.style.marginBottom = '12px';
    p.innerHTML = `初始词：<strong>${info.initWord}</strong> &nbsp;→&nbsp; 最终猜词：<strong>${info.finalGuess}</strong>`;
    dom.voteBody.appendChild(p);
    // 玩家列表
    const listDiv = document.createElement('div');
    listDiv.id = 'accuracy-voter-list';
    listDiv.style.cssText = 'text-align:left;font-size:22px;line-height:2.2;margin:8px 0 16px;padding:10px;background:#1a1a3e;border-radius:10px';
    // 初始渲染：全部显示思考中（优先使用服务端下发的玩家列表，避免重连时 state.players 为空）
    const playerList = info.players && info.players.length > 0 ? info.players : state.players;
    playerList.forEach(pl => {
      const row = document.createElement('div');
      row.id = 'voter-row-' + pl.id;
      const isMe = pl.id === state.myId;
      const av = pl.avatar || '😀';
      const lat3 = pl.connected === false ? '' : latencyHtml(pl.latency);
      row.innerHTML = `<span style="font-size:20px;margin-right:4px">${av}</span><span style="color:${isMe?'#e94560':'#ccc'}">${isMe?' (你)':''} ${pl.nickname}</span>${lat3} <span style="float:right;color:#f39c12">🤔 思考中</span>`;
      listDiv.appendChild(row);
    });
    dom.voteBody.appendChild(listDiv);

    // 投票按钮
    const btnDiv = document.createElement('div');
    btnDiv.className = 'vote-buttons';
    const btnCorrect = document.createElement('button');
    btnCorrect.className = 'vote-btn vote-btn-correct';
    btnCorrect.textContent = '✅ 相符';
    const btnIncorrect = document.createElement('button');
    btnIncorrect.className = 'vote-btn vote-btn-incorrect';
    btnIncorrect.textContent = '✖ 不相符';
    const confirmMsg = document.createElement('p');
    confirmMsg.id = 'vote-confirm-msg';
    confirmMsg.style.cssText = 'color:#2ecc71;font-weight:bold;margin-top:10px;display:none;';
    dom.voteBody.appendChild(confirmMsg);

    // 如果已投票（重连场景），禁用按钮并标记
    if (info.myVote) {
      voted = true;
      btnCorrect.disabled = true;
      btnIncorrect.disabled = true;
      confirmMsg.textContent = '✅ 已投票，等待其他玩家...';
      confirmMsg.style.display = 'block';
    }

    btnCorrect.onclick = () => {
      if (voted) return;
      voted = true;
      socket.emit('vote_accuracy', { chainIndex: data.chainIndex, vote: 'correct' });
      btnCorrect.disabled = true;
      btnIncorrect.disabled = true;
      confirmMsg.textContent = '✅ 已投票，等待其他玩家...';
      confirmMsg.style.display = 'block';
    };
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

function latencyHtml(ms) {
  if (ms === -2) return ''; // 掉线
  if (ms < 0) return '<span style="font-size:12px;color:#888;margin-left:6px">--ms</span>';
  const color = ms <= 500 ? '#2ecc71' : (ms <= 1000 ? '#f39c12' : '#ff4444');
  return `<span style="font-size:12px;color:${color};margin-left:6px">${ms}ms</span>`;
}

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
// 头像选择
const AVATARS = ['😀','😃','😄','😁','😆','😂','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😗',
  '😎','🤩','🧐','🤗','🤭','🤔','🤫','😐','😑','😶','🙄','😏','😤','😠','😡','🤬',
  '😢','😭','😱','😳','🥵','🥶','😰','😥','🤧','🤮','🤡','👻','💀','☠️','👽','🤖',
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐸','🦁','🐮','🐷','🐒','🐔','🐧',
  '🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜',
  '🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🍄',
  '⭐','🌟','✨','🔥','💥','💫','🌈','🌊','🍕','🍔','🌮','🎂','🍦','☕','⚽','🏀',
  '🎨','🎵','🎸','🎹','🎮','🎯','🎪','🎭','🚀','✈️','🚗','🚲','🏠','🔮','💎','🎁'];

let selectedAvatar = AVATARS[0];

function initAvatarSelector() {
  const trigger = document.getElementById('avatar-trigger');
  const panel = document.getElementById('avatar-panel');
  const grid = document.getElementById('avatar-grid');
  if (!grid || !trigger || !panel) return;

  // 点击触发器显示/隐藏面板，隐藏提示文字
  trigger.onclick = () => {
    panel.classList.toggle('hidden');
    const hint = document.getElementById('avatar-hint');
    if (hint) hint.style.display = 'none';
  };
  // 点击外部关闭
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== trigger) {
      panel.classList.add('hidden');
    }
  });

  // 填充头像
  AVATARS.forEach(emoji => {
    const el = document.createElement('span');
    el.textContent = emoji;
    el.style.cssText = 'font-size:28px;cursor:pointer;text-align:center;padding:3px;border-radius:6px;transition:background .1s';
    el.onmouseenter = () => { el.style.background = '#444'; };
    el.onmouseleave = () => { el.style.background = emoji === selectedAvatar ? '#e94560' : 'transparent'; };
    el.onclick = () => {
      selectedAvatar = emoji;
      trigger.textContent = emoji;
      panel.classList.add('hidden');
      grid.querySelectorAll('span').forEach(s => s.style.background = 'transparent');
      el.style.background = '#e94560';
    };
    if (emoji === selectedAvatar) el.style.background = '#e94560';
    grid.appendChild(el);
  });
  trigger.textContent = selectedAvatar;
}

function setupEntryUI() {
  // ---- 创建房间 — 直接创建，无需额外输入 ----
  dom.btnCreateRoom.addEventListener('click', () => {
    const nickname = dom.entryNickname.value.trim();
    if (!nickname) { dom.entryError.textContent = '请输入昵称'; dom.entryError.classList.remove('hidden'); return; }
    dom.entryError.classList.add('hidden');
    dom.entryJoinFields.classList.add('hidden');

    socket.emit('create_room', { nickname, avatar: selectedAvatar }, (res) => {
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
  socket.emit('join_room', { roomId, nickname, avatar: selectedAvatar }, (res) => {
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
    const lat = p.connected ? latencyHtml(p.latency) : '';
    li.innerHTML = `<span style="font-size:24px;margin-right:6px">${p.avatar || '😀'}</span> ${p.nickname}${lat}`;
    if (p.isOwner) {
      li.innerHTML += ' <span class="owner-badge">房主</span>';
    }
    if (p.settling) {
      li.style.color = '#888';
      li.innerHTML += ' <span class="owner-badge" style="background:#f39c12">结算中</span>';
    }
    if (p.id === state.myId && !p.settling) {
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

  // 复制房间号
  dom.btnCopyRoomId.addEventListener('click', () => {
    const roomId = state.roomId;
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      showToast('✅ 已复制房间号：' + roomId);
    }).catch(() => {
      // fallback: 选中文本方式
      const ta = document.createElement('textarea');
      ta.value = roomId;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('✅ 已复制房间号：' + roomId);
    });
  });

  // 退出房间
  dom.btnLeaveRoom.addEventListener('click', () => {
    socket.emit('leave_room');
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
  initAvatarSelector();
  setupChat();
  setupEntryUI();
  setupSettings();
  setupSubmit();
  setupBackToLobby();
  showPage('entry');
}

document.addEventListener('DOMContentLoaded', init);
