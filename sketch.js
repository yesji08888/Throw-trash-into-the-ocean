// =============== 설정값 ===============
const TARGET_ACTIONS = 30;   // 평균 30번 행동하면
const THRESHOLD = 1.00;      // 80% 손실에서 종료
let EBW_MIN = 3000;             // 랜덤 EBW 최소
let EBW_MAX = 4000;            // 랜덤 EBW 최대

// 그리드 해상도는 이미지 크기에 맞춰 자동 결정
const TARGET_TILE_PX = 12;   // 한 타일이 표현할 원본 이미지 픽셀 크기
const MAX_TILE_COUNT = 12000;
const WHITE_THRESHOLD = 30;  // 배경으로 간주할 흰색 임계값
const DESKTOP_BG = '#5599EC'; // 맥 바탕화면 색상
const TILE_ACTIVE_COLOR = '#ffe100';
const WHITE_COLOR = '#ffffff';
const CLICK_BATCH = 7000;

// 캔버스 크기는 이미지 비율에 맞춰 자동 설정
const MAX_CANVAS_W = 1728;    // 필요시 줄이거나 키워도 됨

// =============== 내부 상태 ===============
let reefImg;              // 사용자 이미지 (coralyellow.svg)
let svgRawLines;          // content.txt 원본
let canvasW, canvasH;     // 캔버스 크기
let gridCols = 0;
let gridRows = 0;
let tiles = [];           // 타일 배열 {x,y,w,h,dead:boolean}
let aliveTiles = [];      // 아직 살아있는 타일 참조 배열
let tilesTotal = 0;
let tilesRemoved = 0;
let actions = 0;
let tilesPerEBW = 0;      // EBW 1점당 제거 타일 수 (자동 계산)
let collapsed = false;
let maskBuffer;           // SVG → 래스터 변환용 버퍼
let useVectorSource = false;
let vectorRects = [];
let vectorBounds = null;
let vectorScaleX = 1;
let vectorScaleY = 1;
let vectorOrigin = { x: 0, y: 0 };
let vectorSourceWidth = 0;
let vectorSourceHeight = 0;
let groupTileMap = new Map();
let deadGroups = new Set();

// =============== 로드 & 초기화 ===============
function preload() {
  // SVG 원본을 그대로 읽을 수 있으면 가장 먼저 사용
  try {
    svgRawLines = loadStrings('coralyellow.svg');
  } catch (err) {
    console.warn('coralyellow.svg 로드 실패:', err);
    svgRawLines = null;
  }

  // 이미지 파일명을 프로젝트 폴더에 'coralyellow.svg'로 넣어주세요.
  reefImg = loadImage('coralyellow.svg', undefined, err => {
    console.warn('coralyellow.svg 로드 실패:', err);
  });
}

function setup() {
  if (svgRawLines && svgRawLines.length) {
    parseVectorSource(svgRawLines.join('\n'));
  }
  useVectorSource = vectorRects.length > 0;

  if (useVectorSource) {
    setupCanvasFromVector();
  } else {
    setupCanvasFromImage();
  }

  resetTiles();
  noStroke();
}

function computeGridFromImage() {
  const baseCols = Math.max(10, Math.round(reefImg.width / TARGET_TILE_PX));
  const baseRows = Math.max(10, Math.round(reefImg.height / TARGET_TILE_PX));
  const totalTiles = baseCols * baseRows;

  if (totalTiles <= MAX_TILE_COUNT) {
    gridCols = baseCols;
    gridRows = baseRows;
    return;
  }

  const ratio = Math.sqrt(MAX_TILE_COUNT / totalTiles);
  gridCols = Math.max(10, Math.round(baseCols * ratio));
  gridRows = Math.max(10, Math.round(baseRows * ratio));
}

function setupCanvasFromImage() {
  if (!reefImg) {
    console.error('이미지 소스를 찾을 수 없습니다. 기본 캔버스 크기를 사용합니다.');
    canvasW = MAX_CANVAS_W;
    canvasH = Math.round(MAX_CANVAS_W * 0.6);
    createCanvas(canvasW, canvasH);
    return;
  }
  const s = MAX_CANVAS_W / reefImg.width;
  canvasW = Math.min(MAX_CANVAS_W, reefImg.width);
  canvasH = Math.round(reefImg.height * s);
  createCanvas(canvasW, canvasH);
  computeGridFromImage();
  maskBuffer = createGraphics(gridCols, gridRows);
  maskBuffer.pixelDensity(1); // SVG 래스터화 시 픽셀 접근이 쉬움
}

function setupCanvasFromVector() {
  vectorBounds = vectorBounds || computeVectorBounds();
  canvasW = windowWidth || MAX_CANVAS_W;
  canvasH = windowHeight || Math.round(MAX_CANVAS_W * 0.6);
  createCanvas(canvasW, canvasH);
  updateVectorScale();
}

function resetTiles() {
  if (useVectorSource) {
    initTilesFromVector();
  } else {
    initTilesFromMask();
  }
  autoScaleTilesPerEBW(); // 타일 총수에 맞춰 스케일 자동 계산
  updatePanel();
}

function initTilesFromMask(includeWhite = false) {
  tiles = [];
  tilesRemoved = 0;
  actions = 0;
  collapsed = false;
  groupTileMap = new Map();
  deadGroups = new Set();

  // 마스크 이미지를 그리드 크기에 맞게 샘플링
  // (노란 영역 같은 '배경과 다른 색' 픽셀만 타일 생성)
  maskBuffer.clear();
  maskBuffer.resizeCanvas(gridCols, gridRows);
  maskBuffer.image(reefImg, 0, 0, gridCols, gridRows); // SVG를 버퍼에 래스터화
  maskBuffer.loadPixels();

  const tileW = width / gridCols;
  const tileH = height / gridRows;

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const idx = 4 * (r * gridCols + c);
      const R = maskBuffer.pixels[idx];
      const G = maskBuffer.pixels[idx + 1];
      const B = maskBuffer.pixels[idx + 2];
      const A = maskBuffer.pixels[idx + 3];

      // ▶︎ 타일 생성 조건
      // 1) 알파가 거의 0이면 제외
      // 2) '거의 하얀색'은 제외 (바탕 흰 영역 제거)
      //    ↳ 흰색과의 거리(맨해튼)로 판정
      const whiteDist = Math.abs(R - 255) + Math.abs(G - 255) + Math.abs(B - 255);
      const notWhite = includeWhite ? true : whiteDist > WHITE_THRESHOLD; // 임계(30~60 사이 튜닝 가능)
      const ok = (A > 8) && notWhite;

      if (ok) {
        tiles.push({
          x: c * tileW,
          y: r * tileH,
          w: tileW,
          h: tileH,
          dead: false,
          color: [R, G, B] // 원본 픽셀 색을 보존해 타일에 입힘
        });
      }
    }
  }
  tilesTotal = tiles.length;
  if (!includeWhite && tilesTotal === 0) {
    console.warn('No tiles detected with white filter; retrying including whites.');
    initTilesFromMask(true);
    return;
  }
}

function initTilesFromVector() {
  tiles = [];
  tilesRemoved = 0;
  actions = 0;
  collapsed = false;
  groupTileMap = new Map();
  deadGroups = new Set();

  const bounds = vectorBounds || computeVectorBounds();
  if (!bounds) return;
  updateVectorScale(bounds);
  const offsetX = (vectorOrigin && Number.isFinite(vectorOrigin.x)) ? vectorOrigin.x : bounds.minX;
  const offsetY = (vectorOrigin && Number.isFinite(vectorOrigin.y)) ? vectorOrigin.y : bounds.minY;
  const srcW = vectorSourceWidth || bounds.width || 1;
  const srcH = vectorSourceHeight || bounds.height || 1;
  const scaleX = vectorScaleX || (canvasW / srcW);
  const scaleY = vectorScaleY || (canvasH / srcH);

  for (const rect of vectorRects) {
    const tile = {
      x: (rect.x - offsetX) * scaleX,
      y: (rect.y - offsetY) * scaleY,
      w: rect.w * scaleX,
      h: rect.h * scaleY,
      dead: false,
      color: rect.color,
      groupId: rect.groupId || null
    };
    tiles.push(tile);
    if (tile.groupId) {
      if (!groupTileMap.has(tile.groupId)) groupTileMap.set(tile.groupId, []);
      groupTileMap.get(tile.groupId).push(tile);
    }
  }
  tilesTotal = tiles.length;
}

function parseVectorSource(raw) {
  const text = Array.isArray(raw) ? raw.join('\n') : raw;
  if (!text) return;

  vectorRects = [];
  vectorBounds = null;
  vectorSourceWidth = 0;
  vectorSourceHeight = 0;
  vectorOrigin = { x: Number.NaN, y: Number.NaN };

  let parsedWithDom = false;
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (!doc.querySelector('parsererror')) {
        parsedWithDom = parseSvgDom(doc);
      }
    } catch (err) {
      console.warn('DOMParser 기반 SVG 파싱 실패:', err);
    }
  }

  if (!parsedWithDom) {
    parseSvgWithRegex(text);
  }

  vectorBounds = computeVectorBounds();
  if (!vectorBounds) return;

  if (!vectorSourceWidth) vectorSourceWidth = vectorBounds.width;
  if (!vectorSourceHeight) vectorSourceHeight = vectorBounds.height;
  if (!vectorOrigin || !Number.isFinite(vectorOrigin.x) || !Number.isFinite(vectorOrigin.y)) {
    vectorOrigin = { x: vectorBounds.minX, y: vectorBounds.minY };
  }
}

function parseSvgDom(doc) {
  const root = doc.documentElement;
  if (!root) return false;

  const viewBoxAttr = root.getAttribute('viewBox');
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/\s+/).map(Number);
    if (parts.length >= 4 && parts.every(v => !Number.isNaN(v))) {
      vectorOrigin = { x: parts[0], y: parts[1] };
      vectorSourceWidth = parts[2];
      vectorSourceHeight = parts[3];
    }
  }

  const rectNodes = root.getElementsByTagName('rect');
  for (let i = 0; i < rectNodes.length; i++) {
    const node = rectNodes[i];
    const fill = resolveFill(node);
    if (!fill || fill === 'none') continue;
    const normalized = mapFillColor(fill);
    if (!normalized) continue;

    const opacityAttr = node.getAttribute('opacity');
    const opacity = opacityAttr === null ? NaN : parseFloat(opacityAttr);
    if (shouldSkipRect(normalized, opacity)) continue;

    const width = parseFloat(node.getAttribute('width')) || 0;
    const height = parseFloat(node.getAttribute('height')) || 0;
    if (width <= 0 || height <= 0) continue;

    const x = parseFloat(node.getAttribute('x')) || 0;
    const y = parseFloat(node.getAttribute('y')) || 0;
    const rgb = hexToRgb(normalized);
    if (!rgb) continue;

    const groupId = findGroupIdentifier(node);
    vectorRects.push({ x, y, w: width, h: height, color: rgb, groupId });
  }

  return vectorRects.length > 0;
}

function resolveFill(node) {
  if (!node) return null;
  let fill = node.getAttribute('fill');
  if (fill && fill !== 'none') return fill;
  const style = node.getAttribute('style');
  if (style) {
    const match = style.match(/fill\s*:\s*([^;]+)/i);
    if (match) return match[1].trim();
  }
  return null;
}

function findGroupIdentifier(node) {
  let current = node;
  let fallbackId = null;
  while (current && current.getAttribute) {
    const dataGroup = current.getAttribute('data-group');
    if (dataGroup) return dataGroup;
    if (!fallbackId) {
      const id = current.getAttribute('id');
      if (id) fallbackId = id;
    }
    current = current.parentElement;
  }
  return fallbackId;
}

function parseSvgWithRegex(text) {
  let vbMinX = 0;
  let vbMinY = 0;
  let vbWidth = 0;
  let vbHeight = 0;
  let viewBoxValid = false;
  const viewBoxMatch = text.match(/viewBox="([^"]+)"/);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    if (parts.length >= 4 && parts.every(v => !Number.isNaN(v))) {
      [vbMinX, vbMinY, vbWidth, vbHeight] = parts;
      viewBoxValid = true;
    }
  }

  const rectRegex = /<rect\b[^>]*>/g;
  let match;
  while ((match = rectRegex.exec(text)) !== null) {
    const tag = match[0];
    const fill = extractAttr(tag, 'fill');
    if (!fill || fill === 'none') continue;
    const normalized = mapFillColor(fill);
    if (!normalized) continue;
    const opacityAttr = extractAttr(tag, 'opacity');
    const opacity = opacityAttr === null ? NaN : parseFloat(opacityAttr);
    if (shouldSkipRect(normalized, opacity)) continue;

    const width = parseFloat(extractAttr(tag, 'width')) || 0;
    const height = parseFloat(extractAttr(tag, 'height')) || 0;
    if (width <= 0 || height <= 0) continue;

    const x = parseFloat(extractAttr(tag, 'x')) || 0;
    const y = parseFloat(extractAttr(tag, 'y')) || 0;
    const rgb = hexToRgb(normalized);
    if (!rgb) continue;

    vectorRects.push({ x, y, w: width, h: height, color: rgb });
  }

  if (viewBoxValid) {
    vectorSourceWidth = vbWidth;
    vectorSourceHeight = vbHeight;
    vectorOrigin = { x: vbMinX, y: vbMinY };
  }
}

function extractAttr(tag, name) {
  const regex = new RegExp(name + '\\s*=\\s*"([^"]+)"');
  const match = tag.match(regex);
  return match ? match[1] : null;
}

function hexToRgb(value) {
  if (!value) return null;
  let hex = value.trim();
  if (hex.startsWith('#')) {
    hex = hex.slice(1);
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length !== 6) return null;
    const num = parseInt(hex, 16);
    if (Number.isNaN(num)) return null;
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  const rgbMatch = hex.match(/rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }
  return null;
}

function mapFillColor(fill) {
  return normalizeHex(fill);
}

function normalizeHex(value) {
  if (!value) return null;
  let hex = value.trim().toLowerCase();
  if (!hex.startsWith('#')) return null;
  if (hex.length === 4) {
    hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  if (hex.length !== 7) return null;
  return hex;
}

function shouldSkipRect(colorHex, opacity) {
  if (!colorHex) return true;
  const isTransparentWhite = colorHex === WHITE_COLOR && !Number.isNaN(opacity) && opacity <= 0.001;
  if (isTransparentWhite) return true;
  return colorHex !== TILE_ACTIVE_COLOR;
}

function computeVectorBounds() {
  if (!vectorRects.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const rect of vectorRects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function updateVectorScale(bounds = vectorBounds || computeVectorBounds()) {
  if (!bounds) {
    vectorScaleX = 1;
    vectorScaleY = 1;
    return;
  }
  const srcW = vectorSourceWidth || bounds.width || 1;
  const srcH = vectorSourceHeight || bounds.height || 1;
  vectorScaleX = canvasW / srcW;
  vectorScaleY = canvasH / srcH;
}

function autoScaleTilesPerEBW(meanEBW = 15) {
  // 평균 EBW≈15, 행동 30회, 80% 손실 목표로 자동 스케일링
  tilesPerEBW = (tilesTotal * THRESHOLD) / (meanEBW * TARGET_ACTIONS);
}

// =============== 렌더링 ===============
function draw() {
  background(DESKTOP_BG);

  // 타일 그리기 (사라진 타일은 흰색으로 표시)
  for (const t of tiles) {
    const colorSrc = t.dead ? [255, 255, 255] : t.color;
    fill(colorSrc[0], colorSrc[1], colorSrc[2]);
    rect(t.x, t.y, t.w + 0.5, t.h + 0.5);
  }

  // 60% 이후 혼탁감 오버레이
  const progress = tilesRemoved / tilesTotal;
  if (progress >= 0.6 && !collapsed) {
    fill(255, map(progress, 0.6, 0.8, 8, 32));
    rect(0, 0, width, height);
  }

  // 붕괴 메시지
  if (collapsed) {
    textAlign(CENTER, CENTER); textSize(48); fill('#ffea00');
    text('REEF COLLAPSE (80% loss)', width / 2, height / 2);
  }
}

// =============== 인터랙션 ===============
// 클릭 시 기본 하양 전환 로직을 비활성화하고, Trash 동작에만 반응하도록 함
function mousePressed() {
  return false;
}

function keyPressed() {
  if (key === 'R' || key === 'r') {
    resetTiles();
  }
}

function killTile(tile) {
  if (!tile || tile.dead) return 0;
  tile.dead = true;
  tilesRemoved++;
  return 1;
}

function killGroup(groupId) {
  if (!groupId || deadGroups.has(groupId)) return 0;
  const members = groupTileMap.get(groupId);
  if (!members || !members.length) return 0;
  let killed = 0;
  for (const tile of members) {
    killed += killTile(tile);
  }
  deadGroups.add(groupId);
  return killed;
}

function killTileAt(x, y) {
  for (const tile of tiles) {
    if (tile.dead) continue;
    if (x >= tile.x && x <= tile.x + tile.w && y >= tile.y && y <= tile.y + tile.h) {
      return tile.groupId ? killGroup(tile.groupId) : killTile(tile);
    }
  }
  return 0;
}

function killRandomTile() {
  const candidates = tiles.filter(t => !t.dead);
  if (!candidates.length) return 0;
  const pick = candidates[randInt(0, candidates.length - 1)];
  if (!pick) return 0;
  return pick.groupId ? killGroup(pick.groupId) : killTile(pick);
}

// =============== 유틸 & 패널 ===============
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function updatePanel() {
  const p = tilesTotal ? ((tilesRemoved / tilesTotal) * 100) : 0;
  qs('#tiles').textContent   = tilesTotal.toLocaleString() + ' 개';
  qs('#removed').textContent = tilesRemoved.toLocaleString() + ' 개';
  qs('#progress').textContent= p.toFixed(1);
  qs('#actions').textContent = actions;
  qs('#ebwrange').textContent= `${EBW_MIN} ~ ${EBW_MAX}`;
}

function qs(sel){ return document.querySelector(sel); }

function windowResized() {
  canvasW = windowWidth || canvasW;
  canvasH = windowHeight || canvasH;
  resizeCanvas(canvasW, canvasH);
  if (useVectorSource) {
    updateVectorScale();
  }
  resetTiles();
}
