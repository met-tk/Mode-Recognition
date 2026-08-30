/*
 * 调式侦测 / MODE FINDER
 *
 * 这个小工具完全在浏览器里工作：先解析 Standard MIDI File 的音符与
 * Meta Event，再用加权音级分布、结尾重心和导音解决倾向做启发式匹配。
 */

'use strict';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MODE_LABELS = {
  major: '自然大调',
  harmonicMinor: '和声小调',
};

// Krumhansl-Schmuckler 风格的音级轮廓；和声小调额外提高第七级。
const MODE_PROFILES = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  harmonicMinor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 5.17],
};

const MAJOR_SIGNATURES = {
  '-7': 'C♭', '-6': 'G♭', '-5': 'D♭', '-4': 'A♭', '-3': 'E♭', '-2': 'B♭', '-1': 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F♯', 7: 'C♯',
};

const MINOR_SIGNATURES = {
  '-7': 'A♭', '-6': 'E♭', '-5': 'B♭', '-4': 'F', '-3': 'C', '-2': 'G', '-1': 'D',
  0: 'A', 1: 'E', 2: 'B', 3: 'F♯', 4: 'C♯', 5: 'G♯', 6: 'D♯', 7: 'A♯',
};

const elements = {
  fileInput: document.querySelector('#midi-file'),
  dropzone: document.querySelector('#dropzone'),
  dropzoneEmpty: document.querySelector('#dropzone-empty'),
  dropzoneFile: document.querySelector('#dropzone-file'),
  fileName: document.querySelector('#file-name'),
  fileMeta: document.querySelector('#file-meta'),
  removeFile: document.querySelector('#remove-file'),
  inputError: document.querySelector('#input-error'),
  modePicker: document.querySelector('#mode-picker'),
  tonicPicker: document.querySelector('#tonic-picker'),
  midiHint: document.querySelector('#midi-hint'),
  midiHintCopy: document.querySelector('#midi-hint-copy'),
  analyzeButton: document.querySelector('#analyze-button'),
  sampleButton: document.querySelector('#sample-button'),
  resetButton: document.querySelector('#reset-button'),
  analysisStatus: document.querySelector('#analysis-status'),
  emptyResult: document.querySelector('#empty-result'),
  analysisResult: document.querySelector('#analysis-result'),
  resultLabel: document.querySelector('#result-label'),
  resultTonic: document.querySelector('#result-tonic'),
  resultMode: document.querySelector('#result-mode'),
  resultSummary: document.querySelector('#result-summary'),
  confidenceRing: document.querySelector('#confidence-ring'),
  confidenceValue: document.querySelector('#confidence-value'),
  confidenceCaption: document.querySelector('#confidence-caption'),
  statNotes: document.querySelector('#stat-notes'),
  statDuration: document.querySelector('#stat-duration'),
  statTempo: document.querySelector('#stat-tempo'),
  statMeter: document.querySelector('#stat-meter'),
  pitchChart: document.querySelector('#pitch-chart'),
  candidateList: document.querySelector('#candidate-list'),
  evidenceList: document.querySelector('#evidence-list'),
  evidenceCount: document.querySelector('#evidence-count'),
  sourceNote: document.querySelector('.result-footer > span:first-child'),
  toast: document.querySelector('#toast'),
  aboutButton: document.querySelector('#about-button'),
  aboutDialog: document.querySelector('#about-dialog'),
  dialogClose: document.querySelector('#dialog-close'),
};

const state = {
  file: null,
  midi: null,
  analysis: null,
  isExample: false,
  options: {
    mode: 'auto',
    tonic: null,
  },
  toastTimer: null,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes > 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = String(rounded % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function formatBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return '自由速度';
  return `${Math.round(bpm)} BPM`;
}

function formatPercent(value) {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function setStatus(label, status = '') {
  elements.analysisStatus.className = `analysis-status${status ? ` is-${status}` : ''}`;
  elements.analysisStatus.innerHTML = `<span class="status-dot"></span>${escapeHtml(label)}`;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, 3200);
}

function setInputError(message = '') {
  elements.inputError.hidden = !message;
  elements.inputError.textContent = message;
}

function updateAnalyzeButton() {
  elements.analyzeButton.disabled = !state.midi;
  elements.analyzeButton.querySelector('.button-label').textContent = state.midi ? '开始识别' : '先选择 MIDI 文件';
}

function updateFileCard({ name, meta, example = false }) {
  elements.dropzoneEmpty.hidden = true;
  elements.dropzoneFile.hidden = false;
  elements.fileName.textContent = name;
  elements.fileMeta.textContent = example ? meta : `${meta} · 已在浏览器中读取`;
  elements.dropzone.classList.add('has-file');
  elements.sourceNote.innerHTML = `<span class="footer-spark">✦</span> ${example ? '当前展示的是内置示例' : '原始文件不会离开你的设备'}`;
}

function resetFileCard() {
  elements.dropzoneEmpty.hidden = false;
  elements.dropzoneFile.hidden = true;
  elements.fileName.textContent = '未选择文件';
  elements.fileMeta.textContent = '—';
  elements.dropzone.classList.remove('has-file');
  elements.midiHint.hidden = true;
  elements.sourceNote.innerHTML = '<span class="footer-spark">✦</span> 原始文件不会离开你的设备';
}

function setMode(mode) {
  state.options.mode = mode;
  elements.modePicker.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function setTonic(tonic) {
  state.options.tonic = tonic === 'auto' ? null : Number(tonic);
  elements.tonicPicker.querySelectorAll('[data-tonic]').forEach((button) => {
    const buttonTonic = button.dataset.tonic === 'auto' ? null : Number(button.dataset.tonic);
    const active = buttonTonic === state.options.tonic;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function showMidiHint(midi) {
  if (!midi.keySignature && !midi.trackNames.length) {
    elements.midiHint.hidden = true;
    return;
  }

  const hints = [];
  if (midi.keySignature) {
    hints.push(`文件内标记：${escapeHtml(formatKeySignature(midi.keySignature))}（仅作参考）`);
  }
  if (midi.trackNames.length) {
    const trackText = midi.trackNames.slice(0, 2).map(escapeHtml).join(' / ');
    hints.push(`轨道：${trackText}`);
  }
  elements.midiHintCopy.innerHTML = hints.join(' · ');
  elements.midiHint.hidden = false;
}

async function handleFile(file) {
  if (!file) return;
  setInputError();

  const extension = file.name.toLowerCase().split('.').pop();
  if (!['mid', 'midi'].includes(extension)) {
    setInputError('这不是 MIDI 文件。请选择扩展名为 .mid 或 .midi 的文件。');
    showToast('文件格式不符合要求');
    return;
  }

  state.file = null;
  state.midi = null;
  state.analysis = null;
  state.isExample = false;
  elements.analyzeButton.disabled = true;
  setStatus('正在读取 MIDI…', 'working');

  try {
    const buffer = await file.arrayBuffer();
    const midi = parseMidi(buffer);
    if (!midi.notes.length) {
      throw new Error('文件中没有找到可分析的音符事件。');
    }

    state.file = file;
    state.midi = midi;
    updateFileCard({ name: file.name, meta: `${formatFileSize(file.size)} · ${midi.formatLabel}` });
    showMidiHint(midi);
    updateAnalyzeButton();
    setStatus('已读取，准备分析');
    await nextFrame();
    runAnalysis();
  } catch (error) {
    state.file = null;
    state.midi = null;
    resetFileCard();
    updateAnalyzeButton();
    setStatus('读取失败');
    setInputError(error instanceof Error ? error.message : '无法解析这个 MIDI 文件，请换一个文件试试。');
    showToast('MIDI 读取失败');
  }
}

function loadExample() {
  setInputError();
  state.file = null;
  state.midi = createExampleMidi();
  state.analysis = null;
  state.isExample = true;
  updateFileCard({ name: 'evening-sketch.mid', meta: '内置示例 · D 和声小调', example: true });
  elements.midiHintCopy.textContent = '示例包含旋律、低音与一个清晰的导音解决。';
  elements.midiHint.hidden = false;
  updateAnalyzeButton();
  setStatus('示例已载入');
  runAnalysis();
}

function resetAll() {
  state.file = null;
  state.midi = null;
  state.analysis = null;
  state.isExample = false;
  elements.fileInput.value = '';
  resetFileCard();
  updateAnalyzeButton();
  elements.emptyResult.hidden = false;
  elements.analysisResult.hidden = true;
  setStatus('等待文件');
  setMode('auto');
  setTonic('auto');
}

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function runAnalysis() {
  if (!state.midi) {
    showToast('请先选择一个 MIDI 文件');
    return;
  }

  setStatus('正在计算音级轮廓…', 'working');
  elements.analyzeButton.disabled = true;
  elements.analyzeButton.querySelector('.button-label').textContent = '分析中…';

  window.setTimeout(() => {
    try {
      state.analysis = analyzeMidi(state.midi, state.options);
      renderAnalysis(state.analysis);
      setStatus('分析完成', 'complete');
    } catch (error) {
      setStatus('分析失败');
      showToast(error instanceof Error ? error.message : '分析时遇到未知问题');
    } finally {
      updateAnalyzeButton();
    }
  }, 90);
}

function renderAnalysis(analysis) {
  elements.emptyResult.hidden = true;
  elements.analysisResult.hidden = false;

  const top = analysis.candidates[0];
  const constrained = analysis.options.mode !== 'auto' || analysis.options.tonic !== null;
  elements.resultLabel.textContent = constrained ? '前置约束下的最佳匹配' : '最可能的调式';
  elements.resultTonic.textContent = NOTE_NAMES[top.tonic];
  elements.resultMode.textContent = MODE_LABELS[top.mode];
  elements.resultSummary.textContent = analysis.summary;

  elements.confidenceRing.style.setProperty('--confidence', `${analysis.confidence * 3.6}deg`);
  elements.confidenceValue.textContent = `${analysis.confidence}%`;
  elements.confidenceCaption.textContent = analysis.confidenceCaption;

  elements.statNotes.textContent = analysis.noteCount.toLocaleString('zh-CN');
  elements.statDuration.textContent = formatDuration(analysis.durationSeconds);
  elements.statTempo.textContent = formatBpm(analysis.bpm);
  elements.statMeter.textContent = analysis.meter;

  renderPitchChart(analysis);
  renderCandidates(analysis.candidates);
  renderEvidence(analysis.evidence);

  elements.sourceNote.innerHTML = `<span class="footer-spark">✦</span> ${state.isExample ? '当前展示的是内置示例' : '原始文件不会离开你的设备'}`;
}

function renderPitchChart(analysis) {
  const max = Math.max(...analysis.histogram, 0.0001);
  const leading = (analysis.tonic + 11) % 12;
  elements.pitchChart.innerHTML = analysis.histogram.map((value, pitchClass) => {
    const isTonic = pitchClass === analysis.tonic;
    const isLeading = pitchClass === leading && !isTonic;
    const height = Math.max(4, (value / max) * 100);
    const classes = ['pitch-column'];
    if (isTonic) classes.push('is-tonic');
    if (isLeading) classes.push('is-leading');
    return `
      <div class="${classes.join(' ')}" title="${escapeHtml(NOTE_NAMES[pitchClass])}：${formatPercent(value / sum(analysis.histogram))}">
        <div class="pitch-bar-shell"><i class="pitch-bar" style="height: ${height.toFixed(1)}%"></i></div>
        <span class="pitch-label">${escapeHtml(NOTE_NAMES[pitchClass])}</span>
      </div>`;
  }).join('');
}

function renderCandidates(candidates) {
  if (!candidates.length) {
    elements.candidateList.innerHTML = '<p class="candidate-key">没有足够信息形成候选。</p>';
    return;
  }

  elements.candidateList.innerHTML = candidates.slice(0, 5).map((candidate, index) => `
    <div class="candidate-row">
      <span class="candidate-rank">${String(index + 1).padStart(2, '0')}</span>
      <span class="candidate-key">${escapeHtml(NOTE_NAMES[candidate.tonic])}<small>${escapeHtml(MODE_LABELS[candidate.mode])}</small></span>
      <span class="candidate-meter"><span class="candidate-track"><i style="width: ${candidate.displayScore}%"></i></span><span class="candidate-score">${candidate.displayScore}%</span></span>
    </div>`).join('');
}

function renderEvidence(evidence) {
  elements.evidenceCount.textContent = `${evidence.length} 条线索`;
  elements.evidenceList.innerHTML = evidence.map((item) => `
    <div class="evidence-item">
      <span class="evidence-marker">${escapeHtml(item.icon)}</span>
      <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div>
    </div>`).join('');
}

/* ----------------------------- MIDI parser ----------------------------- */

function readUint16(data, offset) {
  if (offset + 2 > data.length) throw new Error('MIDI 文件意外结束。');
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data, offset) {
  if (offset + 4 > data.length) throw new Error('MIDI 文件意外结束。');
  return ((data[offset] * 0x1000000) + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]) >>> 0;
}

function readVariableLength(data, offset, limit) {
  let value = 0;
  let bytesRead = 0;
  while (offset < limit && bytesRead < 4) {
    const byte = data[offset++];
    value = (value << 7) | (byte & 0x7f);
    bytesRead += 1;
    if (!(byte & 0x80)) return { value, offset };
  }
  throw new Error('MIDI 文件中有无效的可变长度事件。');
}

function readChunkName(data, offset) {
  if (offset + 4 > data.length) return '';
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function decodeMidiText(bytes) {
  try {
    return new TextDecoder('utf-8').decode(bytes).replaceAll('\u0000', '').trim();
  } catch {
    return String.fromCharCode(...bytes).replaceAll('\u0000', '').trim();
  }
}

function parseMidi(buffer) {
  const data = new Uint8Array(buffer);
  if (data.length < 14 || readChunkName(data, 0) !== 'MThd') {
    throw new Error('这不是有效的 Standard MIDI 文件。');
  }

  const headerLength = readUint32(data, 4);
  if (headerLength < 6 || 8 + headerLength > data.length) {
    throw new Error('MIDI 文件头损坏或格式不完整。');
  }

  const format = readUint16(data, 8);
  const trackCount = readUint16(data, 10);
  const rawDivision = readUint16(data, 12);
  const division = decodeDivision(rawDivision);
  let offset = 8 + headerLength;
  const notes = [];
  const tempoEvents = [];
  const trackNames = [];
  let timeSignature = null;
  let keySignature = null;
  let maxTick = 0;

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (offset + 8 > data.length) throw new Error('MIDI 轨道数据不完整。');
    const chunkName = readChunkName(data, offset);
    const chunkLength = readUint32(data, offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > data.length) throw new Error('MIDI 轨道超出文件范围。');
    if (chunkName !== 'MTrk') {
      offset = chunkEnd;
      continue;
    }

    const track = parseTrack(data, chunkStart, chunkEnd, trackIndex);
    notes.push(...track.notes);
    tempoEvents.push(...track.tempoEvents);
    if (track.name) trackNames.push(track.name);
    if (!timeSignature && track.timeSignature) timeSignature = track.timeSignature;
    if (!keySignature && track.keySignature) keySignature = track.keySignature;
    maxTick = Math.max(maxTick, track.lastTick);
    offset = chunkEnd;
  }

  if (!notes.length) throw new Error('文件中没有找到可分析的音符事件。');

  const tempoMap = createTempoMap(tempoEvents, division);
  const enrichedNotes = notes.map((note) => {
    const startSeconds = ticksToSeconds(note.startTick, tempoMap, division);
    const endSeconds = ticksToSeconds(note.endTick, tempoMap, division);
    return {
      ...note,
      pitchClass: note.midiNote % 12,
      startSeconds,
      endSeconds: Math.max(endSeconds, startSeconds + 0.001),
      durationSeconds: Math.max(0.001, endSeconds - startSeconds),
    };
  });

  const durationTicks = Math.max(maxTick, ...enrichedNotes.map((note) => note.endTick));
  const durationSeconds = ticksToSeconds(durationTicks, tempoMap, division);
  const firstTempo = tempoEvents.slice().sort((a, b) => a.tick - b.tick)[0];
  const bpm = firstTempo ? 60000000 / firstTempo.microsecondsPerQuarter : (division.type === 'ppq' ? 120 : NaN);
  const formatLabel = format === 0 ? '单轨 MIDI' : format === 1 ? '多轨同步 MIDI' : `格式 ${format}`;

  return {
    format,
    formatLabel,
    division,
    notes: enrichedNotes,
    tempoEvents,
    tempoMap,
    durationTicks,
    durationSeconds,
    bpm,
    timeSignature,
    keySignature,
    trackNames,
  };
}

function decodeDivision(rawDivision) {
  if (rawDivision & 0x8000) {
    const framesPerSecond = 256 - ((rawDivision >> 8) & 0xff);
    const ticksPerFrame = rawDivision & 0xff;
    return {
      type: 'smpte',
      framesPerSecond: framesPerSecond || 30,
      ticksPerFrame: ticksPerFrame || 80,
      ticksPerSecond: (framesPerSecond || 30) * (ticksPerFrame || 80),
    };
  }
  return { type: 'ppq', ticksPerQuarter: rawDivision || 480 };
}

function parseTrack(data, start, end, trackIndex) {
  let offset = start;
  let tick = 0;
  let runningStatus = 0;
  const activeNotes = new Map();
  const notes = [];
  const tempoEvents = [];
  let name = '';
  let timeSignature = null;
  let keySignature = null;

  const closeNote = (key, endTick) => {
    const pending = activeNotes.get(key);
    if (!pending || !pending.length) return;
    const note = pending.shift();
    if (!pending.length) activeNotes.delete(key);
    notes.push({
      midiNote: note.midiNote,
      startTick: note.startTick,
      endTick: Math.max(endTick, note.startTick + 1),
      velocity: note.velocity,
      channel: note.channel,
      track: trackIndex,
    });
  };

  while (offset < end) {
    const delta = readVariableLength(data, offset, end);
    tick += delta.value;
    offset = delta.offset;
    if (offset >= end) break;

    let status = data[offset++];
    if (status < 0x80) {
      if (!runningStatus) throw new Error('MIDI 轨道中的 Running Status 无效。');
      offset -= 1;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    }

    if (status === 0xff) {
      if (offset >= end) break;
      const metaType = data[offset++];
      const length = readVariableLength(data, offset, end);
      offset = length.offset;
      const payloadEnd = offset + length.value;
      if (payloadEnd > end) throw new Error('MIDI Meta Event 数据不完整。');
      const payload = data.slice(offset, payloadEnd);
      if (metaType === 0x03 && !name) name = decodeMidiText(payload);
      if (metaType === 0x51 && payload.length >= 3) {
        tempoEvents.push({
          tick,
          microsecondsPerQuarter: (payload[0] << 16) | (payload[1] << 8) | payload[2],
        });
      }
      if (metaType === 0x58 && payload.length >= 2 && !timeSignature) {
        timeSignature = { numerator: payload[0], denominator: 2 ** payload[1] };
      }
      if (metaType === 0x59 && payload.length >= 2 && !keySignature) {
        const sf = payload[0] & 0x80 ? payload[0] - 256 : payload[0];
        keySignature = { sf, minor: payload[1] === 1 };
      }
      offset = payloadEnd;
      // Meta Event 不延续 Running Status。
      runningStatus = 0;
      if (metaType === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = readVariableLength(data, offset, end);
      offset = length.offset + length.value;
      if (offset > end) throw new Error('MIDI SysEx Event 数据不完整。');
      runningStatus = 0;
      continue;
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    if (eventType >= 0x80 && eventType <= 0xe0) {
      const data1 = data[offset++];
      const data2 = eventType === 0xc0 || eventType === 0xd0 ? null : data[offset++];
      if (data1 === undefined || (data2 === null && offset > end) || (data2 !== null && data2 === undefined)) {
        throw new Error('MIDI 通道事件数据不完整。');
      }

      if ((eventType === 0x90 || eventType === 0x80) && channel !== 9) {
        const key = `${channel}:${data1}`;
        if (eventType === 0x90 && data2 > 0) {
          const pending = activeNotes.get(key) || [];
          pending.push({ midiNote: data1, startTick: tick, velocity: data2, channel });
          activeNotes.set(key, pending);
        } else {
          closeNote(key, tick);
        }
      }
      continue;
    }

    // 文件中偶尔会出现系统公共事件；跳过其固定长度数据，保证后续轨道仍可读。
    const systemLengths = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0 };
    if (Object.prototype.hasOwnProperty.call(systemLengths, status)) {
      offset += systemLengths[status];
      if (offset > end) throw new Error('MIDI 系统事件数据不完整。');
    }
    runningStatus = 0;
  }

  activeNotes.forEach((pending) => {
    pending.forEach((note) => {
      notes.push({
        midiNote: note.midiNote,
        startTick: note.startTick,
        endTick: Math.max(tick, note.startTick + 1),
        velocity: note.velocity,
        channel: note.channel,
        track: trackIndex,
      });
    });
  });

  return { notes, tempoEvents, name, timeSignature, keySignature, lastTick: tick };
}

function createTempoMap(events, division) {
  if (division.type === 'smpte') return [{ tick: 0, seconds: 0, microsecondsPerQuarter: 500000 }];
  const sorted = events.slice().sort((a, b) => a.tick - b.tick);
  const unique = [];
  sorted.forEach((event) => {
    const previous = unique[unique.length - 1];
    if (previous && previous.tick === event.tick) previous.microsecondsPerQuarter = event.microsecondsPerQuarter;
    else unique.push({ ...event });
  });

  const map = [{ tick: 0, seconds: 0, microsecondsPerQuarter: 500000 }];
  let previousTick = 0;
  let previousTempo = 500000;
  let previousSeconds = 0;
  unique.forEach((event) => {
    if (event.tick <= 0) {
      map[0].microsecondsPerQuarter = event.microsecondsPerQuarter;
      previousTempo = event.microsecondsPerQuarter;
      return;
    }
    previousSeconds += ((event.tick - previousTick) / division.ticksPerQuarter) * (previousTempo / 1000000);
    map.push({ tick: event.tick, seconds: previousSeconds, microsecondsPerQuarter: event.microsecondsPerQuarter });
    previousTick = event.tick;
    previousTempo = event.microsecondsPerQuarter;
  });
  return map;
}

function ticksToSeconds(tick, tempoMap, division) {
  if (division.type === 'smpte') return tick / division.ticksPerSecond;
  let segment = tempoMap[0];
  for (let index = 1; index < tempoMap.length; index += 1) {
    if (tempoMap[index].tick > tick) break;
    segment = tempoMap[index];
  }
  return segment.seconds + ((tick - segment.tick) / division.ticksPerQuarter) * (segment.microsecondsPerQuarter / 1000000);
}

function formatKeySignature(signature) {
  const table = signature.minor ? MINOR_SIGNATURES : MAJOR_SIGNATURES;
  const tonic = table[signature.sf] || '未知';
  return `${tonic} ${signature.minor ? '小调' : '大调'}`;
}

/* --------------------------- mode recognition -------------------------- */

function pearsonCorrelation(a, b) {
  const meanA = sum(a) / a.length;
  const meanB = sum(b) / b.length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (!denomA || !denomB) return 0;
  return numerator / Math.sqrt(denomA * denomB);
}

function rotateProfile(profile, tonic) {
  return profile.map((_, pitchClass) => profile[(pitchClass - tonic + 12) % 12]);
}

function buildFeatures(midi) {
  const histogram = Array(12).fill(0);
  const onsetHistogram = Array(12).fill(0);
  const notes = midi.notes.slice().sort((a, b) => a.startSeconds - b.startSeconds || a.midiNote - b.midiNote);
  const durationSeconds = Math.max(midi.durationSeconds, ...notes.map((note) => note.endSeconds), 0.001);

  notes.forEach((note) => {
    const durationWeight = Math.max(0.08, Math.min(note.durationSeconds, 4.5));
    const velocityWeight = 0.35 + (Math.max(1, note.velocity) / 127) * 0.65;
    histogram[note.pitchClass] += durationWeight * velocityWeight;
    onsetHistogram[note.pitchClass] += 0.25 + velocityWeight * 0.75;
  });

  const tailLength = Math.min(4, Math.max(1.5, durationSeconds * 0.2));
  const tailStart = Math.max(0, durationSeconds - tailLength);
  const finalHistogram = Array(12).fill(0);
  const finalNotes = notes.filter((note) => note.endSeconds >= tailStart);
  finalNotes.forEach((note) => {
    const overlap = clamp(note.endSeconds - Math.max(note.startSeconds, tailStart), 0.08, 4.5);
    finalHistogram[note.pitchClass] += overlap * (0.35 + (Math.max(1, note.velocity) / 127) * 0.65);
  });

  const endingNotes = notes.slice().sort((a, b) => b.endSeconds - a.endSeconds || b.velocity - a.velocity);
  const lastNote = endingNotes[0] || null;
  const uniquePitchClasses = histogram.filter((value) => value > 0).length;

  return {
    histogram,
    onsetHistogram,
    finalHistogram,
    finalNotes,
    notes,
    lastNote,
    durationSeconds,
    tailStart,
    noteCount: notes.length,
    uniquePitchClasses,
  };
}

function findLeadingResolution(features, tonic) {
  const leading = (tonic + 11) % 12;
  const endingNotes = features.notes.filter((note) => note.endSeconds >= features.tailStart).sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  for (let index = 0; index < endingNotes.length; index += 1) {
    const current = endingNotes[index];
    if (current.pitchClass !== leading) continue;
    const resolved = endingNotes.slice(index + 1).some((note) => note.pitchClass === tonic && note.startSeconds - current.startSeconds <= 1.8);
    if (resolved) return 1;
  }
  if (features.lastNote && features.lastNote.pitchClass === tonic) {
    const leadingWeight = features.finalHistogram[leading];
    const finalWeight = sum(features.finalHistogram);
    if (finalWeight > 0 && leadingWeight / finalWeight > 0.1) return 0.75;
  }
  return 0;
}

function scoreCandidate(features, midi, tonic, mode) {
  const totalWeight = Math.max(sum(features.histogram), 0.0001);
  const finalWeight = Math.max(sum(features.finalHistogram), 0.0001);
  const profile = rotateProfile(MODE_PROFILES[mode], tonic);
  const correlation = clamp((pearsonCorrelation(features.histogram, profile) + 1) / 2, 0, 1);
  const rootShare = features.histogram[tonic] / totalWeight;
  const fifthShare = features.histogram[(tonic + 7) % 12] / totalWeight;
  const thirdInterval = mode === 'major' ? 4 : 3;
  const thirdShare = features.histogram[(tonic + thirdInterval) % 12] / totalWeight;
  const leadingPitch = (tonic + 11) % 12;
  const leadingShare = features.histogram[leadingPitch] / totalWeight;
  const finalRootShare = features.finalHistogram[tonic] / finalWeight;
  const lastRoot = features.lastNote && features.lastNote.pitchClass === tonic ? 1 : 0;
  const resolution = findLeadingResolution(features, tonic);
  const embeddedSignature = midi.keySignature;
  let signatureBonus = 0;
  if (embeddedSignature) {
    const signatureTable = embeddedSignature.minor ? MINOR_SIGNATURES : MAJOR_SIGNATURES;
    const signatureName = signatureTable[embeddedSignature.sf];
    const signatureMode = embeddedSignature.minor ? 'harmonicMinor' : 'major';
    if (signatureName === NOTE_NAMES[tonic] && signatureMode === mode) signatureBonus = 0.025;
  }

  // 把比例压到可解释的 0~1 区间，相关性仍是主要依据。
  const tonicAnchor = clamp((rootShare - 0.035) / 0.16, 0, 1);
  const fifthAnchor = clamp((fifthShare - 0.025) / 0.13, 0, 1);
  const thirdAnchor = clamp((thirdShare - 0.025) / 0.13, 0, 1);
  const cadenceAnchor = clamp(finalRootShare * 1.65, 0, 1);
  const modeAnchor = mode === 'harmonicMinor'
    ? clamp((leadingShare - 0.025) / 0.12, 0, 1)
    : clamp((thirdShare - 0.035) / 0.14, 0, 1);

  let raw = correlation * 0.58
    + tonicAnchor * 0.08
    + fifthAnchor * 0.05
    + thirdAnchor * 0.05
    + cadenceAnchor * 0.14
    + lastRoot * 0.06
    + modeAnchor * 0.04
    + resolution * (mode === 'harmonicMinor' ? 0.055 : 0.015)
    + signatureBonus;

  // 明显的导音解决应当显著提升和声小调候选；对自然大调给予轻微反向约束。
  if (mode === 'harmonicMinor' && resolution > 0) raw += 0.04;
  if (mode === 'major' && resolution > 0 && leadingShare > 0.055) raw -= 0.015;

  return {
    tonic,
    mode,
    raw: clamp(raw, 0, 1),
    correlation,
    rootShare,
    fifthShare,
    thirdShare,
    leadingShare,
    finalRootShare,
    lastRoot,
    resolution,
  };
}

function analyzeMidi(midi, options) {
  const features = buildFeatures(midi);
  const modes = options.mode === 'auto' ? ['major', 'harmonicMinor'] : [options.mode];
  const tonics = options.tonic === null ? Array.from({ length: 12 }, (_, index) => index) : [options.tonic];
  const candidates = [];

  modes.forEach((mode) => {
    tonics.forEach((tonic) => candidates.push(scoreCandidate(features, midi, tonic, mode)));
  });
  candidates.sort((a, b) => b.raw - a.raw);

  const top = candidates[0];
  const second = candidates[1];
  const rawRange = Math.max((top?.raw || 0) - (candidates[candidates.length - 1]?.raw || 0), 0.001);
  candidates.forEach((candidate, index) => {
    if (candidates.length === 1) {
      candidate.displayScore = clamp(Math.round(55 + candidate.raw * 40), 55, 97);
      return;
    }
    const relative = (candidate.raw - (candidates[candidates.length - 1]?.raw || 0)) / rawRange;
    candidate.displayScore = clamp(Math.round(62 + relative * 35 - index * 0.5), 48, 97);
  });

  const margin = second ? top.raw - second.raw : 0.065;
  const quantityQuality = clamp(Math.log(features.noteCount + 1) / Math.log(100), 0, 1);
  const pitchQuality = clamp(features.uniquePitchClasses / 8, 0, 1);
  const confidence = clamp(Math.round(
    49 + quantityQuality * 12 + pitchQuality * 8 + clamp(top.raw - 0.58, 0, 0.35) * 35 + margin * 340,
  ), 51, 98);

  const confidenceCaption = confidence >= 89 ? '高度可信' : confidence >= 76 ? '较可信' : confidence >= 63 ? '可作参考' : '建议复核';
  const tonic = NOTE_NAMES[top.tonic];
  const finalNote = features.lastNote ? NOTE_NAMES[features.lastNote.pitchClass] : '—';
  const leading = NOTE_NAMES[(top.tonic + 11) % 12];
  let summary;
  if (top.mode === 'harmonicMinor') {
    summary = top.resolution > 0
      ? `${leading} 在收束段向 ${tonic} 形成导音解决，配合整体音级轮廓，最接近 ${tonic} 和声小调。`
      : `整体音级轮廓与结尾重心最接近 ${tonic} 和声小调；末音为 ${finalNote}，终止感尚可继续复核。`;
  } else {
    summary = top.lastRoot
      ? `音级分布与收束重心都指向 ${tonic}，最后落在主音，最接近 ${tonic} 自然大调。`
      : `整体音级轮廓最接近 ${tonic} 自然大调；末音为 ${finalNote}，建议结合旋律句法复核。`;
  }

  const tailRootShare = features.finalHistogram[top.tonic] / Math.max(sum(features.finalHistogram), 0.0001);
  const evidence = [
    {
      icon: '◉',
      title: '主音重心',
      text: `${tonic} 的加权出现占比约 ${formatPercent(top.rootShare)}，${top.lastRoot ? '结尾也回到主音' : '是全曲最稳定的候选重心'}。`,
    },
    {
      icon: '↘',
      title: '终止倾向',
      text: tailRootShare > 0.28 ? `最后 ${formatDuration(Math.min(4, features.durationSeconds))} 的音符明显向 ${tonic} 收束。` : `结尾片段对 ${tonic} 的回归不强，候选差距需要谨慎解读。`,
    },
    {
      icon: top.mode === 'harmonicMinor' ? '♯' : '△',
      title: top.mode === 'harmonicMinor' ? '导音张力' : '三度色彩',
      text: top.mode === 'harmonicMinor'
        ? `${leading} 的出现占比约 ${formatPercent(top.leadingShare)}${top.resolution > 0 ? '，并观察到指向主音的解决。' : '，但没有捕捉到完整解决。'}`
        : `${NOTE_NAMES[(top.tonic + 4) % 12]}（大三度）与属音共同支撑大调色彩。`,
    },
  ];

  return {
    ...features,
    candidates,
    tonic: top.tonic,
    mode: top.mode,
    confidence,
    confidenceCaption,
    summary,
    evidence,
    bpm: midi.bpm,
    meter: midi.timeSignature ? `${midi.timeSignature.numerator}/${midi.timeSignature.denominator}` : '未标记',
    modeLabel: MODE_LABELS[top.mode],
    options,
  };
}

/* ------------------------------ demo data ------------------------------- */

function createExampleMidi() {
  const ppq = 480;
  const tempo = 96;
  const beat = 60 / tempo;
  const notes = [];
  const addNote = (midiNote, startBeat, durationBeat, velocity = 82, track = 1) => {
    const startTick = Math.round(startBeat * ppq);
    const endTick = Math.round((startBeat + durationBeat) * ppq);
    notes.push({
      midiNote,
      pitchClass: midiNote % 12,
      startTick,
      endTick,
      velocity,
      channel: track,
      track,
      startSeconds: startBeat * beat,
      endSeconds: (startBeat + durationBeat) * beat,
      durationSeconds: durationBeat * beat,
    });
  };

  // 一条带有 C♯→D 收束的短旋律。
  [
    [62, 0, 1], [65, 1, 1], [69, 2, 1], [73, 3, 1],
    [72, 4, 0.5], [69, 4.5, 0.5], [67, 5, 1], [65, 6, 1],
    [62, 8, 0.75], [64, 8.75, 0.5], [65, 9.25, 0.75], [67, 10, 1],
    [69, 12, 1], [73, 13, 0.75], [72, 13.75, 0.5], [73, 14.25, 0.5], [62, 14.75, 1.25],
  ].forEach((item) => addNote(...item));

  // 稀疏的低音骨架，帮助示例展示“主音重心”。
  [
    [38, 0, 4], [45, 4, 4], [38, 8, 4], [45, 12, 2], [38, 14, 2],
  ].forEach((item) => addNote(...item, 68, 0));

  return {
    format: 1,
    formatLabel: '内置双轨示例',
    division: { type: 'ppq', ticksPerQuarter: ppq },
    notes,
    tempoEvents: [{ tick: 0, microsecondsPerQuarter: 60000000 / tempo }],
    tempoMap: [{ tick: 0, seconds: 0, microsecondsPerQuarter: 60000000 / tempo }],
    durationTicks: 16 * ppq,
    durationSeconds: 16 * beat,
    bpm: tempo,
    timeSignature: { numerator: 4, denominator: 4 },
    keySignature: { sf: -1, minor: true },
    trackNames: ['Evening melody', 'Low gravity'],
  };
}

/* ------------------------------ interactions ---------------------------- */

elements.fileInput.addEventListener('change', (event) => {
  handleFile(event.target.files?.[0]);
});

elements.dropzone.addEventListener('click', (event) => {
  if (event.target.closest('#remove-file')) return;
  elements.fileInput.click();
});

elements.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.fileInput.click();
  }
});

['dragenter', 'dragover'].forEach((eventName) => {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('dragover');
  });
});

elements.dropzone.addEventListener('drop', (event) => {
  handleFile(event.dataTransfer.files?.[0]);
});

elements.removeFile.addEventListener('click', (event) => {
  event.stopPropagation();
  resetAll();
});

elements.modePicker.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (button) setMode(button.dataset.mode);
});

elements.tonicPicker.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tonic]');
  if (button) setTonic(button.dataset.tonic);
});

elements.analyzeButton.addEventListener('click', runAnalysis);
elements.sampleButton.addEventListener('click', loadExample);
elements.resetButton.addEventListener('click', resetAll);

elements.aboutButton.addEventListener('click', () => {
  if (typeof elements.aboutDialog.showModal === 'function') elements.aboutDialog.showModal();
});

elements.dialogClose.addEventListener('click', () => elements.aboutDialog.close());
elements.aboutDialog.addEventListener('click', (event) => {
  if (event.target === elements.aboutDialog) elements.aboutDialog.close();
});

// 前置条件变化后，如果已经有结果，立即重算；如果还没有文件，只更新控件状态。
elements.modePicker.addEventListener('click', () => {
  if (state.midi && state.analysis) runAnalysis();
});
elements.tonicPicker.addEventListener('click', () => {
  if (state.midi && state.analysis) runAnalysis();
});

updateAnalyzeButton();
