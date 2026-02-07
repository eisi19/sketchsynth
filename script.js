// ======================================================
// MODEL
// ======================================================

let isDrawing = false
let waveformPoints = []   // array of px coordinates in the canvas
let dspWaveForm = []      // samples for DSP in range [-1, 1]

// DSP / Web Audio

let audioContext
try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 44100
    });
} catch (e) {
    console.error('Web audio API not supported on this browser')
}

let bufferSource = null

let ampNode = audioContext.createGain();
ampNode.gain.value = 0;

const masterGain = audioContext.createGain();
masterGain.gain.value = 1.0;
masterGain.connect(audioContext.destination);

let adsrLoopTimeout = null;

let adsrCycleStart = null;
let adsrCycleEnd = null;
let adsrAnimFrame = null;

const waveformLength = 8192
const fadedSamples = 64

let currentOctave = 4


// Semitones mapping
const noteSemitoneMap = {
    'C': -9,
    'C#': -8,
    'D': -7,
    'D#': -6,
    'E': -5,
    'F': -4,
    'F#': -3,
    'G': -2,
    'G#': -1,
    'A': 0,
    'A#': 1,
    'B': 2
};


// To convert the 440 Hz of the fourth octave into the central frequency of another octave
const octaves = {
    '1': 0.125,
    '2': 0.25,
    '3': 0.5,
    '4': 1,
    '5': 2,
    '6': 4,
}


// From semitones to frequency (Hz)
function semitonesToFreq(semitones, octave = currentOctave, a4 = 440) {

    const octaveFactor = octaves[String(octave)] ?? 1
    return a4 * octaveFactor * Math.pow(2, semitones / 12);

}


// Normalizing the y coordinates to [-1; +1]
function getNormalizedWaveform() {

    const usableHalfHeight = (dimensions.height / 2) - WF_PADDING;

    return waveformPoints.map(p => ({
        x: p.x,
        y: (dimensions.height / 2 - p.y) / usableHalfHeight
    }));

}


// Resampling of the px coordinates to N points
function resampleToNPointsFromDrawing(samples, totalSamples = 8192) {

    if (samples.length === 0) return new Array(totalSamples).fill(0);

    const resampled = [];
    const minX = Math.min(...samples.map(p => p.x));
    const maxX = Math.max(...samples.map(p => p.x));
    const step = (maxX - minX) / (totalSamples - 1);

    for (let i = 0; i < totalSamples; i++) {
        const targetX = minX + i * step;

        let lowIdx = 0;
        while (lowIdx < samples.length - 1 && samples[lowIdx + 1].x < targetX) {
            lowIdx++;
        }

        const p0 = samples[lowIdx];
        const p1 = samples[lowIdx + 1] || p0;

        let y;
        if (p1.x === p0.x) {
            y = p0.y;
        } else {
            const t = (targetX - p0.x) / (p1.x - p0.x);
            y = p0.y * (1 - t) + p1.y * t;
        }

        resampled.push(y);
    }

    return resampled;

}


// Resize an array to a fixed length (truncation or zero-padding)
function fitArrayToLength(sourceArray, targetLength) {

    const src = Array.from(sourceArray);
    const srcLen = src.length;

    if (srcLen === targetLength) {
        return src.slice();
    }

    if (srcLen > targetLength) {
        return src.slice(0, targetLength); // truncation
    }

    const out = src.slice();
    while (out.length < targetLength) {
        out.push(0); // zero-padding
    }
    return out;

}

// Adsr ON / OFF control
let adsrEnabled = false;

function setupAdsrToggle() {

    const checkbox = document.getElementById('adsr-status');
    if (!checkbox) return;

    const statusSpan = checkbox.parentElement.querySelector('.status-button');
    const updateUI = () => {
        adsrEnabled = checkbox.checked;
        if (statusSpan) statusSpan.textContent = adsrEnabled ? 'ON' : 'OFF';
    };

    checkbox.addEventListener('change', () => {
        updateUI();
        const now = audioContext.currentTime;
        ampNode.gain.cancelScheduledValues(now);
        ampNode.gain.setValueAtTime(bufferSource ? 1 : 0, now);
    });

    updateUI(); // init

}



// DSP utilities

// Normalization of the waveform if needed (if the user goes out of the canvas during the drawing)
function normalizeIfNeeded(array) {

    if (array.length === 0) return array;

    const epsilon = 1e-2;
    const maxAbs = Math.max(...array.map(v => Math.abs(v)));

    if (maxAbs > 1) {
        return array.map(v => v / maxAbs * (1 - epsilon));
    }

    return array;

}


// Fade-in & fade-out application to smooth the edges of the waveform to avoid glitches, artifacts and clipping.
function applyFade(array, fadeSamples = fadedSamples) {

    const len = array.length;

    for (let i = 0; i < fadeSamples; i++) {
        const fadeInFactor = Math.sin((i / fadeSamples) * (Math.PI / 2));
        const fadeOutFactor = Math.sin(((fadeSamples - i) / fadeSamples) * (Math.PI / 2));

        array[i] *= fadeInFactor;                       // fade in
        array[len - fadeSamples + i] *= fadeOutFactor;  // fade out
    }

    return array;

}


// CSV export
function saveWavetableToCSV(array, filename = "wavetable.csv") {

    const csvContent = array.map(v => v.toString()).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

}

// Handle CSV file 
// If csv has less than 8192 entries -> zero-pad to the end
// If csv has more than 8192 entries -> truncation
// async because the priority goes to DSP and audio generation
async function handleCsvFile(file) {

    const text = await file.text();
    const values = text
        .split(/\r?\n/)
        .map(v => parseFloat(v))
        .filter(v => !isNaN(v));

    // Fit to waveformLength samples (truncate / zero-pad)
    let fitted = fitArrayToLength(values, waveformLength);

    fitted = normalizeIfNeeded(fitted);
    fitted = applyFade(fitted, fadedSamples);

    dspWaveForm = fitted;         // update MODEL
    fromSamplesToDrawing(dspWaveForm); // update VIEW

}


// From drawing (waveform px points) to DSP wavetable (samples)
function fromDrawingToDSPWaveform() {

    let norm = getNormalizedWaveform();                // [{x, yNorm}]
    let resampled = resampleToNPointsFromDrawing(norm, waveformLength);

    resampled = normalizeIfNeeded(resampled);
    resampled = applyFade(resampled, fadedSamples);

    dspWaveForm = resampled;

}


// To play the waveform drawn
function playWavetable(frequency = 440, loop = true) {

    if (!dspWaveForm || dspWaveForm.length === 0) return;

    // stop previous sounds (if any)
    if (bufferSource) {
        try { bufferSource.stop(); } catch (e) { }
        bufferSource.disconnect();
        bufferSource = null;
    }

    // stop any previous ADSR loop timer
    clearAdsrLoopTimer();

    // build AudioBuffer from dspWaveForm
    const buffer = audioContext.createBuffer(1, dspWaveForm.length, audioContext.sampleRate);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < dspWaveForm.length; i++) channelData[i] = dspWaveForm[i];

    // create looping BufferSource
    bufferSource = audioContext.createBufferSource();
    bufferSource.buffer = buffer;
    bufferSource.loop = loop;

    // tune by playbackRate: baseFreq = sr / tableLen
    const baseFreq = audioContext.sampleRate / dspWaveForm.length;
    bufferSource.playbackRate.value = frequency / baseFreq;

    bufferSource.connect(ampNode);

    const now = audioContext.currentTime;

    ampNode.gain.cancelScheduledValues(now);

    // start audio
    bufferSource.start(now);

    // ADSR enabled: repeat the envelope each cycle using nested setTimeout
    if (adsrEnabled) {
        const cycleEndTime = scheduleADSRLoop(now); // schedules one full ADSR cycle 
        const cycleDurationMs = Math.max(0, (cycleEndTime - now) * 1000);

        adsrLoopTimeout = setTimeout(function loopAdsr() {
            // stop looping if note ended or ADSR got disabled meanwhile
            if (!bufferSource || !adsrEnabled) return;

            const t0 = audioContext.currentTime;
            ampNode.gain.cancelScheduledValues(t0);

            const tEnd = scheduleADSRLoop(t0);
            const durMs = Math.max(0, (tEnd - t0) * 1000);

            adsrLoopTimeout = setTimeout(loopAdsr, durMs);
        }, cycleDurationMs);
    } else {
        // ADSR disabled
        ampNode.gain.setValueAtTime(1.0, now);
    }

}


// To stop the wavetable reading (stop audio)
function stopWavetable() {

    clearAdsrLoopTimer();

    const now = audioContext.currentTime;
    ampNode.gain.cancelScheduledValues(now);

    if (!adsrEnabled) {
        ampNode.gain.setValueAtTime(0, now);
    } else {
        ampNode.gain.setValueAtTime(0, now);
    }

    if (bufferSource) {
        try { bufferSource.stop(); } catch (e) { }
        bufferSource.disconnect();
        bufferSource = null;
    }

    if (adsrAnimFrame !== null) {
        cancelAnimationFrame(adsrAnimFrame);
        adsrAnimFrame = null;
    }

}

// Schedule the ASDR loop
function scheduleADSRLoop(startTime) {

    const g = ampNode.gain;
    const { t0, tA, tD, tS, tR } = computeADSRTimepoints(startTime);

    const peakLevel = 1.0;
    const sustainLevel = 0.5;

    g.cancelScheduledValues(t0);
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(peakLevel, tA);
    g.linearRampToValueAtTime(sustainLevel, tD);
    g.setValueAtTime(sustainLevel, tS);
    g.linearRampToValueAtTime(0, tR);

    adsrCycleStart = t0;
    adsrCycleEnd = tR;

    startAdsrAnimation();  // starts/restarts the adsr animation

    return tR;

}


// To clear the adsr loop timer
function clearAdsrLoopTimer() {

    if (adsrLoopTimeout !== null) {
        clearTimeout(adsrLoopTimeout);
        adsrLoopTimeout = null;
    }

}


// To get the adsr times from the sliders
function getADSRTimes() {

    const a = parseFloat(attackSlider.value);
    const d = parseFloat(decaySlider.value);
    const s = parseFloat(sustainSlider.value);
    const r = parseFloat(releaseSlider.value);
    return { a, d, s, r };

}


// To absolute times for the cycle
function computeADSRTimepoints(startTime) {

    const { a, d, s, r } = getADSRTimes();

    const A = Math.max(0.001, a);
    const D = Math.max(0.001, d);
    const S = Math.max(0.001, s);
    const R = Math.max(0.001, r);

    const t0 = startTime;
    const tA = t0 + A;
    const tD = tA + D;
    const tS = tD + S;
    const tR = tS + R;

    return { t0, tA, tD, tS, tR };

}

// To bind the click and events on the keyboard to playing
function bindPianoEvents() {

    const keys = document.querySelectorAll("#piano .key");
    keys.forEach(el => {
        el.addEventListener("pointerdown", async (e) => {
            e.preventDefault();
            await audioContext.resume();

            const note = el.dataset.note;
            const off = parseInt(el.dataset.octaveOffset || "0", 10);
            const oct = currentOctave + off;

            const semi = noteSemitoneMap[note];
            const freq = semitonesToFreq(semi, oct);

            el.classList.add("active");
            playWavetable(freq, true);
        });

        el.addEventListener("pointerup", (e) => {
            e.preventDefault();
            el.classList.remove("active");
            stopWavetable();
        });

        el.addEventListener("pointercancel", () => {
            el.classList.remove("active");
            stopWavetable();
        });

        el.addEventListener("pointerleave", (e) => {
            if (e.pressure === 0) return;
            el.classList.remove("active");
            stopWavetable();
        });
    });

}


// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// ======================================================
// VIEW
// ======================================================

const COLORS = {
    gridLight: "#ae9871ff",
    gridDark: "#70634aff",
    waveform: "#c0554aff",
    waveformIcons: "#edeeed"
};

// Waveform canvas definitions
const box = document.getElementById("waveform-box");
const canvas = document.getElementById('waveform-canvas');

canvas.width = box.clientWidth;
canvas.height = box.clientHeight;

const ctx = canvas.getContext('2d');
let dimensions = canvas.getBoundingClientRect();

// ADSR canvas definitions
const adsr_box = document.getElementById("adsr-box");
const adsr_canvas = document.getElementById('adsr-canvas');

adsr_canvas.width = adsr_box.clientWidth;
adsr_canvas.height = adsr_box.clientHeight;

const adsr_ctx = adsr_canvas.getContext('2d');
let adsr_dimensions = adsr_canvas.getBoundingClientRect();

// Grid & waveform lines width
const gridLineWidth = 0.5;
const waveformLineWidth = 5;

// To limit the waveform up to the canvas margin
const WF_PADDING = waveformLineWidth / 2;
const ADSR_PADDING = waveformLineWidth / 2;

// Lines smoothing
ctx.lineJoin = "round";
ctx.lineCap = "round";

adsr_ctx.lineJoin = "round";
adsr_ctx.lineCap = "round";


// To enhance the resolution of the grids, the waveform and the adsr
function fixCanvasResolution() {

    const dpr = window.devicePixelRatio || 1;

    canvas.style.width = dimensions.width + "px";
    canvas.style.height = dimensions.height + "px";

    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;

    ctx.scale(dpr, dpr);

    adsr_canvas.style.width = adsr_dimensions.width + "px";
    adsr_canvas.style.height = adsr_dimensions.height + "px";

    adsr_canvas.width = adsr_dimensions.width * dpr;
    adsr_canvas.height = adsr_dimensions.height * dpr;

    adsr_ctx.scale(dpr, dpr);

}


// To draw a straight line (vertical or horizontal) on the waveform canvas
function drawLineWF(coord, vertical) {

    ctx.beginPath();
    if (vertical) {
        ctx.moveTo(coord, 0);
        ctx.lineTo(coord, dimensions.height);
    } else {
        ctx.moveTo(0, coord);
        ctx.lineTo(dimensions.width, coord);
    }
    ctx.stroke();

}


// Grid and axis drawing (waveform canvas)
function drawGrid() {

    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    ctx.lineWidth = gridLineWidth;

    ctx.strokeStyle = COLORS.gridLight;

    let vertical_step = dimensions.width / 13
    let horizontal_step = dimensions.height / 6

    for (let x = vertical_step; x < dimensions.width; x += vertical_step) drawLineWF(x, true);
    for (let y = horizontal_step; y < dimensions.height; y += horizontal_step) drawLineWF(y, false);

    ctx.strokeStyle = COLORS.gridDark;
    ctx.beginPath();
    ctx.moveTo(0, dimensions.height / 2);
    ctx.lineTo(dimensions.width, dimensions.height / 2);
    ctx.stroke();

}


// Draw a straight line (vertical or horizontal) on the ADSR canvas
function drawLineADSR(coord, vertical) {

    adsr_ctx.beginPath();
    if (vertical) {
        adsr_ctx.moveTo(coord, 0);
        adsr_ctx.lineTo(coord, adsr_dimensions.height);
    } else {
        adsr_ctx.moveTo(0, coord);
        adsr_ctx.lineTo(adsr_dimensions.width, coord);
    }
    adsr_ctx.stroke();

}


// Grid and axis drawing (ADSR canvas)
function drawAdsrGrid() {

    adsr_ctx.clearRect(0, 0, adsr_dimensions.width, adsr_dimensions.height);
    adsr_ctx.lineWidth = gridLineWidth;

    adsr_ctx.strokeStyle = COLORS.gridLight;

    let vertical_step = adsr_dimensions.width / 9
    let horizontal_step = adsr_dimensions.height / 6

    for (let x = vertical_step; x < adsr_dimensions.width; x += vertical_step) drawLineADSR(x, true);
    for (let y = horizontal_step; y < adsr_dimensions.height; y += horizontal_step) drawLineADSR(y, false);

    adsr_ctx.strokeStyle = COLORS.gridDark;
    adsr_ctx.beginPath();
    adsr_ctx.moveTo(0, adsr_dimensions.height / 2);
    adsr_ctx.lineTo(adsr_dimensions.width, adsr_dimensions.height / 2);
    adsr_ctx.stroke();

}


// Drawing of the current waveform (waveformPoints)
function drawWaveform() {

    if (waveformPoints.length < 2) return;

    ctx.strokeStyle = COLORS.waveform;
    ctx.lineWidth = waveformLineWidth;

    ctx.beginPath();
    ctx.moveTo(waveformPoints[0].x, waveformPoints[0].y);

    for (let i = 1; i < waveformPoints.length - 1; i++) {
        const xc = (waveformPoints[i].x + waveformPoints[i + 1].x) / 2;
        const yc = (waveformPoints[i].y + waveformPoints[i + 1].y) / 2;
        ctx.quadraticCurveTo(waveformPoints[i].x, waveformPoints[i].y, xc, yc);
    }

    const last = waveformPoints[waveformPoints.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();

}


// From samples (.csv) to px coordinates to draw an uploaded waveform
function fromSamplesToDrawing(samples) {

    waveformPoints = [];

    const len = samples.length;
    const totalPoints = dimensions.width;

    for (let i = 0; i < totalPoints; i++) {
        const t = i / (totalPoints - 1);
        const idx = t * (len - 1);

        const idx0 = Math.floor(idx);
        const idx1 = Math.min(idx0 + 1, len - 1);
        const frac = idx - idx0;

        const yNorm = samples[idx0] * (1 - frac) + samples[idx1] * frac;

        const x = i;

        const usableHalfHeight = (dimensions.height / 2) - WF_PADDING;
        const y = (dimensions.height / 2) - yNorm * usableHalfHeight;

        waveformPoints.push({ x, y });
    }

    render();

}


// To draw the ADSR on the canvas
function drawAdsr(aRaw, dRaw, sRaw, rRaw) {

    const w = adsr_dimensions.width;
    const h = adsr_dimensions.height;

    const yBottom = h - ADSR_PADDING;
    const yTop = ADSR_PADDING;
    const yMid = h / 2;

    const total = aRaw + dRaw + sRaw + rRaw;

    const A = aRaw / total;
    const D = dRaw / total;
    const S = sRaw / total;
    const R = rRaw / total;

    const xA = A * w;
    const xD = (A + D) * w;
    const xS = (A + D + S) * w;
    const xR = w;

    adsr_ctx.clearRect(0, 0, w, h);
    drawAdsrGrid();

    // Vertical lines to separate the envelope stages
    adsr_ctx.save();
    adsr_ctx.strokeStyle = "#fff";
    adsr_ctx.lineWidth = 1;
    adsr_ctx.setLineDash([4, 4]);

    [xA, xD, xS].forEach(x => {
        adsr_ctx.beginPath();
        adsr_ctx.moveTo(x, 0);
        adsr_ctx.lineTo(x, h);
        adsr_ctx.stroke();
    });

    adsr_ctx.restore();

    adsr_ctx.strokeStyle = COLORS.waveform;
    adsr_ctx.lineWidth = 4;
    adsr_ctx.beginPath();

    adsr_ctx.moveTo(0, yBottom);   // start
    adsr_ctx.lineTo(xA, yTop);     // attack
    adsr_ctx.lineTo(xD, yMid);     // decay
    adsr_ctx.lineTo(xS, yMid);     // sustain
    adsr_ctx.lineTo(xR, yBottom);  // release

    adsr_ctx.stroke();

}


// To draw the waveform into the buttons for preset waveform
function drawPresetIcons(canvas, type) {

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = COLORS.waveformIcons;
    ctx.lineWidth = 10;
    ctx.beginPath();

    if (type === 'sine') {
        const cycles = 2; // 2 cycles of sine 
        for (let x = 0; x <= w; x++) {
            const t = (x / w) * cycles * 2 * Math.PI;
            const y = midY - Math.sin(t) * (h * 0.35);
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }

    } else if (type === 'square') {
        const yHigh = midY - h * 0.35;
        const yLow = midY + h * 0.35;
        const period = w / 2;

        ctx.moveTo(0, yHigh);

        for (let c = 0; c < 2; c++) {
            const xStart = c * period;
            const xMid = xStart + period / 2;
            const xEnd = xStart + period;

            ctx.lineTo(xMid, yHigh);

            ctx.lineTo(xMid, yLow);

            ctx.lineTo(xEnd, yLow);

            if (c < 1) {
                ctx.lineTo(xEnd, yHigh);
            }
        }
    } else if (type === 'sawtooth') {
        const yHigh = midY - h * 0.35;
        const yLow = midY + h * 0.35;
        const period = w / 2;

        ctx.moveTo(0, yLow);

        for (let c = 0; c < 2; c++) {
            const xStart = c * period;
            const xEnd = xStart + period;

            ctx.lineTo(xEnd, yHigh);

            if (c < 1) {
                ctx.lineTo(xEnd, yLow);
            }
        }
    } else if (type === 'triangle') {
        const yHigh = midY - h * 0.35;
        const yLow = midY + h * 0.35;
        const period = w / 2;

        ctx.moveTo(0, yLow);

        let xStart = 0;
        let xMid = xStart + period / 2;
        let xEnd = xStart + period;

        ctx.lineTo(xMid, yHigh);
        ctx.lineTo(xEnd, yLow);

        xStart = xEnd;
        xMid = xStart + period / 2;
        xEnd = xStart + period;

        ctx.lineTo(xMid, yHigh);
        ctx.lineTo(xEnd, yLow);
    }
    ctx.stroke();

}


// To draw the preset waveform into the canvas
function drawPresetWaveform(type) {

    waveformPoints = [];

    const N = dimensions.width;
    for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        let yNorm = 0;

        if (type === "sine") {
            yNorm = Math.sin(2 * Math.PI * t);

        } else if (type === "sawtooth") {
            yNorm = 2 * t - 1;

        } else if (type === "square") {
            yNorm = t < 0.5 ? 1 : -1;

        } else if (type === "triangle") {
            if (t < 0.25) {
                yNorm = t * 4;
            } else if (t < 0.75) {
                yNorm = 2 - 4 * t;
            } else {
                yNorm = -4 + 4 * t;
            }
        }

        // To pixels
        const x = i;

        const usableHalfHeight = (dimensions.height / 2) - WF_PADDING;
        const y = (dimensions.height / 2) - yNorm * usableHalfHeight;

        waveformPoints.push({ x, y });
    }

    render();
    fromDrawingToDSPWaveform();

}


// To clear the selection of the preset waveform
function clearPresetSelection() {

    const presets = document.querySelectorAll('input[name="wave"]');
    presets.forEach(radio => {
        radio.checked = false;
    });

}


// To start the ADSR animation
function startAdsrAnimation() {

    if (adsrAnimFrame !== null) {
        cancelAnimationFrame(adsrAnimFrame);
    }
    animateAdsr();

}


// To animate the ADSR (dot that follows the envelope)
function animateAdsr() {

    const now = audioContext.currentTime;
    if (adsrCycleStart == null || adsrCycleEnd == null) return;

    const w = adsr_dimensions.width;
    const h = adsr_dimensions.height;

    const t0 = adsrCycleStart;
    const { tA, tD, tS, tR } = computeADSRTimepoints(t0);

    const total = tR - t0;
    if (total <= 0) return;

    // normalised times
    let tRel = (now - t0) / total;
    if (tRel < 0) tRel = 0;
    if (tRel > 1) tRel = 1;

    // temporal fractions of the segments
    const fA = (tA - t0) / total;
    const fD = (tD - t0) / total;
    const fS = (tS - t0) / total;
    const fR = 1.0;

    // X coordinates of breakpoints 
    const xA = fA * w;
    const xD = fD * w;
    const xS = fS * w;
    const xR = w;

    const yBottom = h - ADSR_PADDING;
    const yTop = ADSR_PADDING;
    const yMid = h / 2;

    let x, y;

    if (tRel <= fA) {
        // Attack: 0 -> A
        const k = tRel / fA;
        x = k * xA;
        y = yBottom + (yTop - yBottom) * k;
    } else if (tRel <= fD) {
        // Decay: A -> D
        const k = (tRel - fA) / (fD - fA);
        x = xA + (xD - xA) * k;
        y = yTop + (yMid - yTop) * k;
    } else if (tRel <= fS) {
        // Sustain: D -> S (horizontal line)
        const k = (tRel - fD) / (fS - fD);
        x = xD + (xS - xD) * k;
        y = yMid;
    } else {
        // Release: S -> R
        const k = (tRel - fS) / (fR - fS);
        x = xS + (xR - xS) * k;
        y = yMid + (yBottom - yMid) * k;
    }

    // redraw the grid, curve and indicator
    adsr_ctx.clearRect(0, 0, w, h);
    drawAdsrGrid();


    // redraw the adsr line with values of the sliders
    const aRaw = parseFloat(attackSlider.value);
    const dRaw = parseFloat(decaySlider.value);
    const sRaw = parseFloat(sustainSlider.value);
    const rRaw = parseFloat(releaseSlider.value);
    drawAdsr(aRaw, dRaw, sRaw, rRaw);

    // draw the dot that follows the temporal envelope
    const radius = 5;
    adsr_ctx.fillStyle = "#211a13";
    adsr_ctx.strokeStyle = "#c7af84";
    adsr_ctx.lineWidth = 2;
    adsr_ctx.beginPath();
    adsr_ctx.arc(x, y, radius, 0, Math.PI * 2);
    adsr_ctx.fill();
    adsr_ctx.stroke();

    // it continues until the note is on
    if (bufferSource) {
        adsrAnimFrame = requestAnimationFrame(animateAdsr);
    } else {
        adsrAnimFrame = null;
    }

}

// ON / OFF toggle button
function setupFilterToggle(checkboxId) {

    const checkbox = document.getElementById(checkboxId);
    if (!checkbox) return;

    const statusSpan = checkbox.parentElement.querySelector('.status-button');
    if (!statusSpan) return;

    statusSpan.textContent = checkbox.checked ? 'ON' : 'OFF';

    checkbox.addEventListener('change', () => {
        statusSpan.textContent = checkbox.checked ? 'ON' : 'OFF';
        statusSpan.dataset.status = statusSpan.textContent;
        connectAudioChain();
    });

}


// Render function
function render() {

    drawAdsrGrid();
    drawGrid();
    drawWaveform();
    updateAdsrView();

}


// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// ======================================================
// CONTROLLER
// ======================================================

// ================================================================================
// FILTERS (Web Audio API) - LP/HP with slopes 12/24/36/48 (biquad filters cascade)
// ================================================================================

let lpStages = [];
let hpStages = [];

const FILTER_Q_FIXED = 0.707;
const FILTER_Q_MIN = 0.1;
const FILTER_Q_MAX = 20;


// Build the filters stages
function buildFilterStages(type, stageCount) {
    const stages = [];
    for (let i = 0; i < stageCount; i++) {
        const f = audioContext.createBiquadFilter();
        f.type = type;
        f.frequency.value = 1000;
        f.Q.value = FILTER_Q_FIXED;
        stages.push(f);
    }
    return stages;
}


// Disconnect filters from the cascade
function disconnectStages(stages) {
    stages.forEach(s => {
        try { s.disconnect(); } catch (e) { }
    });
}


// Build the filters cascade
function chainStages(stages) {
    for (let i = 0; i < stages.length - 1; i++) {
        stages[i].connect(stages[i + 1]);
    }
    return { input: stages[0], output: stages[stages.length - 1] };
}


// From the slope in dB to the stage count 
function slopeDbToStageCount(db) {
    // 12 -> 1 biquad, 24 -> 2 biquads, 36 -> 3 biquads, 48 -> 4 biquads
    // Each biquad provides a 12dB/octave slope.
    const n = Math.round(parseFloat(db) / 12);
    return Math.min(4, Math.max(1, n));
}


// Get the selected slope stages
function getSelectedSlopeStages(name) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    if (!checked) return 1;
    return slopeDbToStageCount(checked.value);
}


// Apply filters parameters
function applyFilterParams() {

    const lpCut = parseFloat(document.getElementById("lp-cutoff").value);
    const lpQ = parseFloat(document.getElementById("lp-resonance").value);
    const hpCut = parseFloat(document.getElementById("hp-cutoff").value);
    const hpQ = parseFloat(document.getElementById("hp-resonance").value);

    lpStages.forEach((s, idx) => {
        s.frequency.value = lpCut;
        s.Q.value = (idx === 0) ? lpQ : FILTER_Q_FIXED; // Q factor only on the first, to better manage resonances and stability of amplitude
    });

    hpStages.forEach((s, idx) => {
        s.frequency.value = hpCut;
        s.Q.value = (idx === 0) ? hpQ : FILTER_Q_FIXED;
    });

    document.getElementById("lp-cutoff-value").value = `${Math.round(lpCut)} Hz`;
    document.getElementById("hp-cutoff-value").value = `${Math.round(hpCut)} Hz`;
    document.getElementById("lp-resonance-value").value = `${lpQ.toFixed(2)} Q`;
    document.getElementById("hp-resonance-value").value = `${hpQ.toFixed(2)} Q`;

}


// Rebuild filters
function rebuildFilters() {

    disconnectStages(lpStages);
    disconnectStages(hpStages);

    const lpN = getSelectedSlopeStages("lp-slope");
    const hpN = getSelectedSlopeStages("hp-slope");

    lpStages = buildFilterStages("lowpass", lpN);
    hpStages = buildFilterStages("highpass", hpN);

    applyFilterParams();
    connectAudioChain();

}


// bufferSource -> ampNode -> (LP if on) -> (HP if on) -> destination
function connectAudioChain() {

    try { ampNode.disconnect(); } catch (e) { }

    disconnectStages(lpStages);
    disconnectStages(hpStages);

    const lpOn = document.getElementById("lp-status")?.checked;
    const hpOn = document.getElementById("hp-status")?.checked;

    let node = ampNode;

    if (lpOn && lpStages.length) {
        const lp = chainStages(lpStages);
        node.connect(lp.input);
        node = lp.output;
    }

    if (hpOn && hpStages.length) {
        const hp = chainStages(hpStages);
        node.connect(hp.input);
        node = hp.output;
    }

    node.connect(masterGain);

}


function clamp(v, lo, hi) {

    return Math.min(hi, Math.max(lo, v));

}

// Setup filter UI
function setupFilterUI() {

    const lpRes = document.getElementById("lp-resonance");
    const hpRes = document.getElementById("hp-resonance");
    lpRes.min = FILTER_Q_MIN; lpRes.max = FILTER_Q_MAX;
    hpRes.min = FILTER_Q_MIN; hpRes.max = FILTER_Q_MAX;

    ["lp-cutoff", "lp-resonance", "hp-cutoff", "hp-resonance"].forEach(id => {
        document.getElementById(id)?.addEventListener("input", () => {
            lpRes.value = clamp(parseFloat(lpRes.value), FILTER_Q_MIN, FILTER_Q_MAX);
            hpRes.value = clamp(parseFloat(hpRes.value), FILTER_Q_MIN, FILTER_Q_MAX);
            applyFilterParams();
        });
    });

    // slope radios
    document.querySelectorAll('input[name="lp-slope"]').forEach(r => r.addEventListener("change", rebuildFilters));
    document.querySelectorAll('input[name="hp-slope"]').forEach(r => r.addEventListener("change", rebuildFilters));

}


// Update keyboard note names based on the current selected octave
function updateKeyboardLabels() {

    document.querySelectorAll("#piano .key").forEach(key => {
        const note = key.dataset.note;
        const off = parseInt(key.dataset.octaveOffset || "0", 10);
        const oct = currentOctave + off;
        key.textContent = `${note}${oct}`;
    });

}


// From dB (GUI) to linear gain (DSP)
function dbToGain(db) {

    return Math.pow(10, db / 20);

}


// Output volume setup
function setupOutputVolume() {

    const slider = document.getElementById("output-volume");
    const label = document.getElementById("output-volume-value");
    if (!slider || !label) return;

    const apply = () => {
        const db = parseFloat(slider.value);
        label.textContent = `${db.toFixed(1)} dBFS`;

        const now = audioContext.currentTime;
        const g = dbToGain(db);

        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setTargetAtTime(g, now, 0.02);
    };

    slider.addEventListener("input", apply);

    // init
    apply();

}


// Init of the presets icons
document.querySelectorAll('.wave-canvas').forEach(canvas => {
    const type = canvas.dataset.wave;
    drawPresetIcons(canvas, type);
});


// From mouse coordinates to canvas
function getMousePos(e) {

    const rect = canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };

}


// Start to draw
canvas.addEventListener("mousedown", e => {
    clearPresetSelection(); // Clear the selected preset 
    isDrawing = true;
    waveformPoints = [];
    waveformPoints.push(getMousePos(e));
    render();
});


// Minimum pixel distance between two consecutive points
const MIN_POINT_DIST = 2;

function shouldAddPoint(prev, next) {

    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    return (dx * dx + dy * dy) >= (MIN_POINT_DIST * MIN_POINT_DIST);

}


// Continue to draw
canvas.addEventListener("mousemove", e => {
    if (!isDrawing) return;
    const pos = getMousePos(e);

    const last = waveformPoints[waveformPoints.length - 1]; // Last px drawn
    if (!last || shouldAddPoint(last, pos)) {
        waveformPoints.push(pos);
        render();
    }
});


// Stopping the drawing because the user has finished
canvas.addEventListener("mouseup", () => {
    isDrawing = false;
    fromDrawingToDSPWaveform();
});


// Stopping the drawing because the user has left the canvas
canvas.addEventListener("mouseleave", () => {
    if (!isDrawing) return;
    isDrawing = false;
    fromDrawingToDSPWaveform();
});


// File input (both CSV and audio files)
document.getElementById('waveformFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    const name = file.name.toLowerCase();

    await handleCsvFile(file);

    try {
        if (name.endsWith('.csv')) {
            await handleCsvFile(file);
        } else {
            alert("Format not correct. Only .csv accepted");
        }
    } catch (err) {
        alert("An error has occurred while uploading the file.");
    } finally {
        e.target.value = "";
    }
});


// Octave increment button listener
document.getElementById('octave-incr').addEventListener('click', async () => {
    if (currentOctave < 5)
        currentOctave += 1;

    updateKeyboardLabels();
});


// Octave decrement button listener
document.getElementById('octave-decr').addEventListener('click', async () => {
    if (currentOctave > 1)
        currentOctave -= 1;

    updateKeyboardLabels();
});


// Sine wave preset button listener
document.getElementById('wave-sine').addEventListener('click', async () => {
    drawPresetWaveform("sine");
});


// Sawtooth wave preset button listener
document.getElementById('wave-sawtooth').addEventListener('click', async () => {
    drawPresetWaveform("sawtooth");
});


// Square wave preset button listener
document.getElementById('wave-square').addEventListener('click', async () => {
    drawPresetWaveform("square");
});


// Triangular wave preset button listener
document.getElementById('wave-triangular').addEventListener('click', async () => {
    drawPresetWaveform("triangle");
});


// Clear waveform canvas button listener
document.getElementById('clear-wf').addEventListener('click', async () => {
    clearPresetSelection(); // clear the selected preset
    waveformPoints = [];
    dspWaveForm = new Array(waveformLength).fill(0);
    render()
});


// Export waveform button listener
document.getElementById('export-wf').addEventListener('click', async () => {
    saveWavetableToCSV(dspWaveForm);
});


// Sliders assignments
const attackSlider = document.getElementById("attack");
const decaySlider = document.getElementById("decay");
const sustainSlider = document.getElementById("sustain");
const releaseSlider = document.getElementById("release");


// To update the adsr GUI
function updateAdsrView() {

    const aRaw = parseFloat(attackSlider.value);
    const dRaw = parseFloat(decaySlider.value);
    const sRaw = parseFloat(sustainSlider.value);
    const rRaw = parseFloat(releaseSlider.value);

    drawAdsr(aRaw, dRaw, sRaw, rRaw);

}


// Sliders listener
[attackSlider, decaySlider, sustainSlider, releaseSlider].forEach(sl => {
    sl.addEventListener("input", updateAdsrView);
});


// ADSR knobs setup
setupRotaryKnob({ id: "attack", valueId: "attack-value", unit: "s", decimals: 2, onValue: () => updateAdsrView() });
setupRotaryKnob({ id: "decay", valueId: "decay-value", unit: "s", decimals: 2, onValue: () => updateAdsrView() });
setupRotaryKnob({ id: "sustain", valueId: "sustain-value", unit: "s", decimals: 2, onValue: () => updateAdsrView() });
setupRotaryKnob({ id: "release", valueId: "release-value", unit: "s", decimals: 2, onValue: () => updateAdsrView() });


// FILTERS knobs setup
setupRotaryKnob({
    id: "lp-cutoff",
    valueId: "lp-cutoff-value",
    unit: "Hz",
    decimals: 2,
    onValue: () => applyFilterParams()
});

setupRotaryKnob({
    id: "lp-resonance",
    valueId: "lp-resonance-value",
    unit: "Q",
    decimals: 2,
    onValue: () => applyFilterParams()
});

setupRotaryKnob({
    id: "hp-cutoff",
    valueId: "hp-cutoff-value",
    unit: "Hz",
    decimals: 2,
    onValue: () => applyFilterParams()
});

setupRotaryKnob({
    id: "hp-resonance",
    valueId: "hp-resonance-value",
    unit: "Q",
    decimals: 2,
    onValue: () => applyFilterParams()
});


// Rotary knob setup
function setupRotaryKnob({ id, valueId, unit, decimals, onValue }) {

    const input = document.getElementById(id);
    const valueField = document.getElementById(valueId);
    if (!input || !valueField) return;

    const wrapper = input.parentElement;
    const indicator = wrapper.querySelector(".knob-indicator");
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);

    function formatValue(v) {
        if (unit === "Hz") return `${Math.round(v)} Hz`;
        if (unit === "Q") return `${v.toFixed(decimals)} Q`;
        if (unit === "s") return `${v.toFixed(decimals)} s`;
        return `${v.toFixed(decimals)}`;
    }

    function parseTextToNumber(text) {
        return parseFloat(String(text).replace(unit, "").trim());
    }

    function updateIndicatorFromValue(v) {
        const t = (v - min) / (max - min);
        const angle = -135 + t * 270;
        if (indicator) indicator.style.transform = `translate(-50%, -100%) rotate(${angle}deg)`;
    }

    function updateFromSlider() {
        const v = parseFloat(input.value);
        updateIndicatorFromValue(v);
        valueField.value = formatValue(v);
        if (onValue) onValue(v);
    }

    function commitFromText() {
        const num = parseTextToNumber(valueField.value);
        if (isNaN(num)) {
            valueField.value = formatValue(parseFloat(input.value));
            return;
        }
        const clamped = Math.min(Math.max(num, min), max);
        input.value = String(clamped);
        updateFromSlider();
    }

    // slider -> text + knob + callback
    input.addEventListener("input", updateFromSlider);

    // text -> slider + knob + callback
    valueField.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            commitFromText();
            valueField.blur();
        }
    });

    // init
    updateFromSlider();

}


// ----------------------------------------------------------------------
// MIDI SUPPORT (EXTERNAL KEYBOARD)
// ----------------------------------------------------------------------



let activeMidiNote = null; // Which note is playing

if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess()
        .then(onMIDISuccess, onMIDIFailure);
} else {
    alert("Web MIDI API not supported on this browser. External MIDI keyboard usage not supported. Try another browser.");
}

function onMIDISuccess(midiAccess) {

    // Listen to every MIDI input available
    for (let input of midiAccess.inputs.values()) {
        input.onmidimessage = handleMIDIMessage;
    }

    // If you connect a MIDI key after the load of the page
    midiAccess.onstatechange = (e) => {
        if (e.port.type === "input" && e.port.state === "connected") {
            e.port.onmidimessage = handleMIDIMessage;
        }
    };
}


function onMIDIFailure() {
    alert("MIDI devices access denied");
}


function handleMIDIMessage(message) {

    // Resume audio context
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    const [command, note, velocity] = message.data;

    // Intercept messages from all the 16 channels
    // 0x90 is Note On
    // 0x80 is Note Off
    const cmd = command & 0xf0;

    if (cmd === 0x90 && velocity > 0) {

        // NOTE ON

        // From MIDI note to frequency
        const freq = midiNoteToFreq(note);

        // Play the note
        playWavetable(freq, true);

        // Update the state of the played MIDI note
        activeMidiNote = note;

        // Visual feedback on the web app keyboard
        highlightKeyByMidiNote(note, true);

    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) { // === Opted for strict equality to ensure safety

        // NOTE OFF

        // Interrup the sound only if the released note is the same that is playing.
        // If I release an old note while a new note is playing nothing is done.
        if (activeMidiNote === note) {
            stopWavetable();
            activeMidiNote = null;
        }

        // Remove visual feedback
        highlightKeyByMidiNote(note, false);

    }
}


// From MIDI to Hz conversion
function midiNoteToFreq(note) {

    return 440 * Math.pow(2, (note - 69) / 12);

}


// Visual feedback of the web app keyboard
function highlightKeyByMidiNote(midiNote, isActive) {

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Extracting octave and MIDI note from the MIDI number
    const octave = Math.floor(midiNote / 12) - 1;
    const noteName = noteNames[midiNote % 12];

    // Octave offset with respect to the selected octave on the web app keyboard
    const relativeOctave = octave - currentOctave;

    // If the note is outside from the 2 octaves visualized on the web app keyboard nothing is done on the GUI
    if (relativeOctave < 0 || relativeOctave > 1) return;

    const selector = `.key[data-note="${noteName}"][data-octave-offset="${relativeOctave}"]`;
    const keyElement = document.querySelector(selector);

    if (keyElement) {
        if (isActive) {
            keyElement.classList.add("active");
        } else {
            keyElement.classList.remove("active");
        }
    }

}


// Init
fixCanvasResolution();
clearPresetSelection();
setupFilterToggle('lp-status');
setupFilterToggle('hp-status');
setupAdsrToggle();
updateKeyboardLabels();
render();

setupFilterUI();
rebuildFilters();
connectAudioChain();

bindPianoEvents();
setupOutputVolume();