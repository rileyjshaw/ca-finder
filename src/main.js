/* Here’s how this program works:

It’s based on my prior CA Finder (https://rileyjshaw.com/glitch-archive/projects/fs-ca-finder/),
and its variants. But this time it uses the GPU.

It is a cellular automaton simulation with the following rules:

- Each cell has a state, which has an associated color and a weight.
- The color is output directly to the screen. Forget about that and let’s focus on the weight.
- Weights are typically low integers. When updating to the next frame, each cell sums the weights of its neighbors.
- Every possible sum has an associated rule that maps it to a new state via the rule array.
- The rule array is 1-indexed, so a value of 3 means “change to state 3”. A value of 0 means the cell should remain the same.

So for the following pixel in the center:

1 0 1
1 X 1
0 1 0

we sum the neighbor weights (shown) and get 5. We look that up in the rule array:

[1, 1, 2, 3, 4, 0, 1, 2, 3]

and determine that it should remain unchanged. */

import { tinykeys } from 'tinykeys';
import ShaderPad from 'shaderpad';
import helpers from 'shaderpad/plugins/helpers';
import save from 'shaderpad/plugins/save';

import rawPalettes, { paletteIds } from './palettes.js';
import {
	compressToUrl,
	decompressFromUrl,
	generateFurthestSubsequentDistanceArray,
	hexToNormalizedRGB,
	shuffleArray,
} from './util.js';

// Configurable.
const MAX_WEIGHT = 1.5;
const MIN_N_STATES = 2;
const MAX_N_STATES = 32;
const MAX_NEIGHBOR_RANGE = 12;
const MIN_N_RINGS = 1;
const MAX_N_RINGS = 8;

// Derived.
const MAX_CELLS_PER_RING = Math.pow(MAX_NEIGHBOR_RANGE * 2 + 1, 2);
const MAX_N_RULES = Math.floor(MAX_WEIGHT * MAX_CELLS_PER_RING * MAX_N_RINGS + 1);

let needsDisplayUpdate = true;
tinykeys(window, {
	Enter: () => {
		const encoded = encodeStateToUrl();
		if (encoded != null) {
			const hash = '#' + encoded;
			if (location.hash !== hash) {
				history.replaceState(null, '', location.pathname + location.search + hash);
			}
			const safeName = encoded.length <= 64 ? encoded : encoded.slice(0, 64);
			displayShader.save(`ca-${safeName}.png`);
		} else {
			displayShader.save('ca-export.png');
		}
	},
	KeyS: () => scramble(),
	KeyD: () => {
		const next = Math.min(2, resolutionMultiplier * 2);
		if (next !== resolutionMultiplier) {
			resolutionMultiplier = next;
			setCanvasSize();
		}
		showInfo(`Density: ${Math.round(resolutionMultiplier * 100)}%`);
	},
	'Shift+KeyD': () => {
		const next = resolutionMultiplier / 2;
		if (next !== resolutionMultiplier) {
			resolutionMultiplier = next;
			setCanvasSize();
		}
		showInfo(`Density: ${Math.round(resolutionMultiplier * 100)}%`);
	},
	KeyC: () => updateColors(),
	'Shift+KeyC': () => updateColors(-1),
	KeyQ: () => {
		const next = Math.min(MAX_NEIGHBOR_RANGE, neighborRange + 1);
		if (next !== neighborRange) setNeighborRange(next, true);
		showInfo(`Neighbor range: ${neighborRange}`);
	},
	'Shift+KeyQ': () => {
		const next = Math.max(neighborRange - 1, 1);
		if (next !== neighborRange) setNeighborRange(next, true);
		showInfo(`Neighbor range: ${neighborRange}`);
	},
	KeyE: () => {
		const next = Math.min(1, cellInertia + 0.05);
		if (next !== cellInertia) {
			cellInertia = next;
		}
		showInfo(`Cell inertia: ${Math.round(cellInertia * 100)}%`);
	},
	'Shift+KeyE': () => {
		const next = Math.max(0, cellInertia - 0.05);
		if (next !== cellInertia) {
			cellInertia = next;
		}
		showInfo(`Cell inertia: ${Math.round(cellInertia * 100)}%`);
	},
	KeyZ: () => {
		const next = Math.min(MAX_N_STATES, nStates + 1);
		if (next !== nStates) {
			nStates = next;
			updateUniformsKeepRuleset();
			scramble();
		}
		showInfo(`States: ${nStates}`);
	},
	'Shift+KeyZ': () => {
		const next = Math.max(MIN_N_STATES, nStates - 1);
		if (next !== nStates) {
			nStates = next;
			updateUniformsKeepRuleset();
			scramble();
		}
		showInfo(`States: ${nStates}`);
	},
	KeyX: () => {
		isVonNeumann = !isVonNeumann;
		updateUniformsKeepRuleset();
		showInfo(isVonNeumann ? 'Von Neumann neighborhood' : 'Moore neighborhood');
	},
	KeyA: () => {
		const next = Math.min(MAX_N_RINGS, nRings + 1);
		if (next !== nRings) {
			nRings = next;
			const minRange = nRings * 2;
			if (neighborRange < minRange) {
				neighborRange = Math.min(MAX_NEIGHBOR_RANGE, minRange);
			}
			updateUniformsKeepRuleset();
			scramble();
		}
		showInfo(`Neighborhood rings: ${nRings}`);
	},
	'Shift+KeyA': () => {
		const next = Math.max(MIN_N_RINGS, nRings - 1);
		if (next !== nRings) {
			nRings = next;
			updateUniformsKeepRuleset();
			scramble();
		}
		showInfo(`Neighborhood rings: ${nRings}`);
	},
	KeyW: () => {
		showInfo(`Weights: ${updateWeights()}`);
	},
	'Shift+KeyW': () => {
		showInfo(`Weights: ${updateWeights(-1)}`);
	},
	ArrowRight: e => {
		e.preventDefault();
		pushRulesetToHistory();
		generateNewRuleset();
		showInfo('New ruleset');
	},
	ArrowUp: e => {
		e.preventDefault();
		mutateRuleset('swap');
		showInfo('Swap mutation');
	},
	ArrowDown: e => {
		e.preventDefault();
		mutateRuleset('point');
		showInfo('Point mutation');
	},
	ArrowLeft: e => {
		e.preventDefault();
		restorePriorRuleset();
		showInfo('Undo ruleset change');
	},
	Space: () => {
		isPaused = !isPaused;
		if (!isPaused) needsDisplayUpdate = true;
		showInfo(isPaused ? 'Paused' : 'Playing');
	},
	'Shift+?': () => instructionsContainer.classList.toggle('show'),
	Escape: () => instructionsContainer.classList.remove('show'),
});

const displayFsSource = `#version 300 es
precision mediump float;
precision mediump usampler2D;

uniform usampler2D u_stateTexture;
uniform vec3 u_colors[${MAX_N_STATES}];

in vec2 v_uv;
out vec4 outColor;

void main() {
	uint cellState = texture(u_stateTexture, v_uv).r;
	outColor = vec4(u_colors[cellState].rgb, 1.0);
}
`;

const canvas = document.getElementById('canvas');
const R8UI_OPTIONS = {
	internalFormat: 'R8UI',
	format: 'RED_INTEGER',
	type: 'UNSIGNED_BYTE',
	minFilter: 'NEAREST',
	magFilter: 'NEAREST',
	wrapS: 'CLAMP_TO_EDGE',
	wrapT: 'CLAMP_TO_EDGE',
};

let updateShader;
let displayShader;
let nStates = 8;
let cellInertia = 0.8;
let isVonNeumann = false;
let neighborRange;
let minNeighborWeight;
let nRings = 2;
let resolutionMultiplier = 0.25;
let isPaused = false;

const weights = new Float32Array(MAX_N_STATES);
const rules = new Uint8Array(MAX_N_RULES);
let colors = new Float32Array(MAX_N_STATES * 3);
let currentPaletteId = paletteIds[0];
let paletteOrderIdx = 0;
let nextWeightsIdx = 0;

const ringInnerRadii = new Float32Array(MAX_N_RINGS);
const ringOuterRadii = new Float32Array(MAX_N_RINGS);
const ringWeights = new Float32Array(MAX_N_RINGS);

function generateRings() {
	if (nRings === 1) {
		ringInnerRadii[0] = 1;
		ringOuterRadii[0] = neighborRange;
		ringWeights[0] = 1.0;
	} else {
		const maxR = neighborRange;
		const step = maxR / nRings;
		for (let i = 0; i < nRings; i++) {
			const base = Math.floor(i * step);
			ringInnerRadii[i] = Math.max(1, base + 1);
			ringOuterRadii[i] = Math.max(ringInnerRadii[i], Math.floor((i + 1) * step));
		}
		for (let i = 0; i < nRings; i++) {
			ringWeights[i] = i % 2 === 0 ? 1.0 : -0.5;
		}
	}
	for (let i = nRings; i < MAX_N_RINGS; i++) {
		ringInnerRadii[i] = 0;
		ringOuterRadii[i] = 0;
		ringWeights[i] = 0;
	}
}

const rulesetHistory = [];

function getRandomTextureData(width, height) {
	const size = width * height;
	const data = new Uint8Array(size);
	for (let i = 0; i < size; ++i) {
		data[i] = Math.floor(Math.random() * nStates);
	}
	return data;
}

function createShaders() {
	const w = canvas.width || 1;
	const h = canvas.height || 1;
	const seedData = getRandomTextureData(w, h);

	updateShader = new ShaderPad(
		`#version 300 es
precision mediump float;
precision mediump usampler2D;
precision highp usampler2DArray;

uniform usampler2DArray u_history;
uniform int u_historyFrameOffset;
uniform usampler2D u_seed;
uniform float u_weights[${MAX_N_STATES}];
uniform usampler2D u_rules;
uniform int u_nRules;
uniform int u_minNeighborWeight;
uniform int u_maxNeighborRange;
uniform int u_vonNeumann;
uniform int u_nRings;
uniform float u_ringInner[${MAX_N_RINGS}];
uniform float u_ringOuter[${MAX_N_RINGS}];
uniform float u_ringWeights[${MAX_N_RINGS}];
uniform int u_frame;

in vec2 v_uv;
out uint outColor;

uint getStateFromHistory(vec2 coord) {
	coord = fract(coord);
	float z = historyZ(u_history, u_historyFrameOffset, 1);
	return texture(u_history, vec3(coord, z)).r;
}

uint getState(vec2 coord) {
	if (u_frame == 0) {
		coord = fract(coord);
		return texture(u_seed, coord).r;
	}
	return getStateFromHistory(coord);
}

void main() {
	vec2 onePixel = 1.0 / u_resolution;
	uint state = getState(v_uv);

	float totalSum = 0.0;
	for (int ring = 0; ring < ${MAX_N_RINGS}; ring++) {
		if (ring >= u_nRings) break;
		float innerR = u_ringInner[ring];
		float outerR = u_ringOuter[ring];
		float ringW = u_ringWeights[ring];
		int iOuter = int(outerR);
		float innerR2 = innerR * innerR;
		float outerR2 = outerR * outerR;

		float ringSum = 0.0;
		for (int dx = -${MAX_NEIGHBOR_RANGE}; dx <= ${MAX_NEIGHBOR_RANGE}; dx++) {
			if (dx < -iOuter || dx > iOuter) continue;
			for (int dy = -${MAX_NEIGHBOR_RANGE}; dy <= ${MAX_NEIGHBOR_RANGE}; dy++) {
				if (dy < -iOuter || dy > iOuter) continue;
				if (dx == 0 && dy == 0) continue;
				float dist2 = float(dx * dx + dy * dy);
				if (dist2 < innerR2 || dist2 > outerR2) continue;
				if (u_vonNeumann != 0 && (abs(dx) + abs(dy) > iOuter)) continue;
				ringSum += u_weights[getState(v_uv + vec2(float(dx), float(dy)) * onePixel)];
			}
		}
		totalSum += ringSum * ringW;
	}

	int iSum = int(floor(totalSum));
	int ruleIndex = iSum - u_minNeighborWeight;
	if (ruleIndex < 0) ruleIndex = 0;
	if (ruleIndex >= u_nRules) ruleIndex = u_nRules - 1;
	uint newState = texelFetch(u_rules, ivec2(ruleIndex, 0), 0).r;

	if (newState == 0u) {
		outColor = state;
	} else {
		outColor = newState - 1u;
	}
}
`,
		{
			canvas,
			history: 2,
			plugins: [helpers()],
			...R8UI_OPTIONS,
		},
	);
	updateShader.initializeTexture('u_seed', { data: seedData, width: w, height: h }, R8UI_OPTIONS);
	updateShader.initializeUniform('u_weights', 'float', Array.from(weights), { arrayLength: MAX_N_STATES });
	updateShader.initializeTexture('u_rules', { data: rules, width: MAX_N_RULES, height: 1 }, R8UI_OPTIONS);
	updateShader.initializeUniform('u_nRules', 'int', MAX_N_RULES);
	updateShader.initializeUniform('u_minNeighborWeight', 'int', 0);
	updateShader.initializeUniform('u_maxNeighborRange', 'int', neighborRange);
	updateShader.initializeUniform('u_vonNeumann', 'int', isVonNeumann ? 1 : 0);
	updateShader.initializeUniform('u_nRings', 'int', nRings);
	updateShader.initializeUniform('u_ringInner', 'float', Array.from(ringInnerRadii), { arrayLength: MAX_N_RINGS });
	updateShader.initializeUniform('u_ringOuter', 'float', Array.from(ringOuterRadii), { arrayLength: MAX_N_RINGS });
	updateShader.initializeUniform('u_ringWeights', 'float', Array.from(ringWeights), { arrayLength: MAX_N_RINGS });
	updateShader.on('updateResolution', (width, height) => {
		updateShader.reset();
		updateShader.updateTextures({
			u_seed: { data: getRandomTextureData(width, height), width, height },
		});
		if (displayShader) displayShader.updateTextures({ u_stateTexture: updateShader });
	});

	displayShader = new ShaderPad(displayFsSource, {
		canvas,
		plugins: [helpers(), save()],
	});
	displayShader.initializeTexture('u_stateTexture', updateShader, R8UI_OPTIONS);
	displayShader.initializeUniform('u_colors', 'float', getColorsForUniform(), { arrayLength: MAX_N_STATES });
}

function getColorsForUniform() {
	return Array.from({ length: MAX_N_STATES }, (_, i) => [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]]);
}

const MAX_RULESET_HISTORY = 128;
function pushRulesetToHistory() {
	const { minWeight, maxWeight } = Array.from(weights.slice(0, nStates)).reduce(
		(acc, weight) => {
			if (weight < acc.minWeight) acc.minWeight = weight;
			if (weight > acc.maxWeight) acc.maxWeight = weight;
			return acc;
		},
		{ minWeight: Infinity, maxWeight: -Infinity },
	);
	let totalMaxSum = 0;
	for (let i = 0; i < nRings; i++) {
		const cells = countCellsInRing(ringInnerRadii[i], ringOuterRadii[i]);
		const rw = ringWeights[i];
		totalMaxSum += (rw >= 0 ? maxWeight : minWeight) * cells * Math.abs(rw);
	}
	const nRulesNeeded = Math.floor(totalMaxSum) - minNeighborWeight + 1;
	if (nRulesNeeded < 1) return;
	const ruleCount = Math.min(nRulesNeeded, MAX_N_RULES);
	rulesetHistory.push({
		rules: new Uint8Array(rules.subarray(0, ruleCount)),
		minNeighborWeight,
	});
	if (rulesetHistory.length > MAX_RULESET_HISTORY) rulesetHistory.shift();
}

function restorePriorRuleset() {
	const entry = rulesetHistory.pop();
	if (!entry) return;
	rules.fill(0);
	rules.set(entry.rules, 0);
	minNeighborWeight = entry.minNeighborWeight;
	applyRulesToShader(entry.rules.length);
}

function applyRulesToShader(ruleCount) {
	if (updateShader) {
		updateShader.updateTextures({
			u_rules: { data: rules, width: MAX_N_RULES, height: 1 },
		});
		updateShader.updateUniforms({
			u_nRules: ruleCount,
			u_minNeighborWeight: minNeighborWeight,
		});
	}
}

function generateNewRuleset() {
	const ruleCount = getCurrentRuleCount();
	if (ruleCount < 1) return;
	const newRules = Array.from({ length: ruleCount }, (_, i) => {
		if (i < nStates && cellInertia < 1) return i + 1;
		return Math.random() < cellInertia ? 0 : Math.floor(Math.random() * (nStates + 1));
	});
	shuffleArray(newRules);
	rules.set(newRules, 0);
	applyRulesToShader(ruleCount);
}

function getCurrentRuleCount() {
	const { minWeight, maxWeight } = Array.from(weights.slice(0, nStates)).reduce(
		(acc, weight) => {
			if (weight < acc.minWeight) acc.minWeight = weight;
			if (weight > acc.maxWeight) acc.maxWeight = weight;
			return acc;
		},
		{ minWeight: Infinity, maxWeight: -Infinity },
	);
	let totalMaxSum = 0;
	for (let i = 0; i < nRings; i++) {
		const cells = countCellsInRing(ringInnerRadii[i], ringOuterRadii[i]);
		const rw = ringWeights[i];
		totalMaxSum += (rw >= 0 ? maxWeight : minWeight) * cells * Math.abs(rw);
	}
	const nRulesNeeded = Math.floor(totalMaxSum) - minNeighborWeight + 1;
	return Math.min(Math.max(nRulesNeeded, 1), MAX_N_RULES);
}

function mutateRuleset(variant) {
	pushRulesetToHistory();
	const ruleCount = getCurrentRuleCount();
	if (ruleCount < 1) return;

	if (variant === 'swap') {
		const nSwaps = Math.max(1, Math.floor(ruleCount * 0.1));
		for (let s = 0; s < nSwaps; s++) {
			const i = Math.floor(Math.random() * ruleCount);
			const j = Math.floor(Math.random() * ruleCount);
			const tmp = rules[i];
			rules[i] = rules[j];
			rules[j] = tmp;
		}
	} else {
		const nPointMutations = Math.max(1, Math.floor(ruleCount * 0.1));
		for (let s = 0; s < nPointMutations; s++) {
			const i = Math.floor(Math.random() * ruleCount);
			rules[i] = Math.random() < cellInertia ? 0 : Math.floor(Math.random() * (nStates + 1));
		}
	}

	applyRulesToShader(ruleCount);
}

function countCellsInRing(innerR, outerR) {
	let count = 0;
	const iOuter = Math.floor(outerR);
	for (let dx = -iOuter; dx <= iOuter; dx++) {
		for (let dy = -iOuter; dy <= iOuter; dy++) {
			if (dx === 0 && dy === 0) continue;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist < innerR || dist > outerR) continue;
			count++;
		}
	}
	return count;
}

function recalcMinNeighborWeight() {
	generateRings();

	const { minWeight, maxWeight } = Array.from(weights.slice(0, nStates)).reduce(
		(acc, weight) => {
			if (weight < acc.minWeight) acc.minWeight = weight;
			if (weight > acc.maxWeight) acc.maxWeight = weight;
			return acc;
		},
		{ minWeight: Infinity, maxWeight: -Infinity },
	);
	let totalMinSum = 0;
	let totalMaxSum = 0;
	for (let i = 0; i < nRings; i++) {
		const cells = countCellsInRing(ringInnerRadii[i], ringOuterRadii[i]);
		const rw = ringWeights[i];
		if (rw >= 0) {
			totalMinSum += minWeight * cells * rw;
			totalMaxSum += maxWeight * cells * rw;
		} else {
			totalMinSum += maxWeight * cells * rw;
			totalMaxSum += minWeight * cells * rw;
		}
	}
	minNeighborWeight = Math.floor(totalMinSum);
	const maxNeighborWeight = Math.floor(totalMaxSum);
	const nRulesNeeded = maxNeighborWeight - minNeighborWeight + 1;
	if (nRulesNeeded > MAX_N_RULES || nRulesNeeded < 1) {
		console.error('Too many rules:', nRulesNeeded, weights);
		showError();
	}
}

function syncShaderUniforms() {
	if (!updateShader) return;
	const ruleCount = getCurrentRuleCount();
	updateShader.updateTextures({
		u_rules: { data: rules, width: MAX_N_RULES, height: 1 },
	});
	updateShader.updateUniforms({
		u_weights: Array.from(weights),
		u_nRules: ruleCount,
		u_minNeighborWeight: minNeighborWeight,
		u_maxNeighborRange: neighborRange,
		u_vonNeumann: isVonNeumann ? 1 : 0,
		u_nRings: nRings,
		u_ringInner: Array.from(ringInnerRadii),
		u_ringOuter: Array.from(ringOuterRadii),
		u_ringWeights: Array.from(ringWeights),
	});
}

const STATE_VERSION = 1;
const WEIGHT_SCALE = 255 / MAX_WEIGHT;

function packState() {
	const ruleCount = getCurrentRuleCount();
	if (ruleCount < 1) return null;
	const n = 1 + 1 + 1 + 1 + 1 + 1 + 3 + 2 + 2 + ruleCount + nStates;
	const buf = new Uint8Array(n);
	const dv = new DataView(buf.buffer);
	let off = 0;
	buf[off++] = STATE_VERSION;
	buf[off++] = nStates;
	buf[off++] = neighborRange;
	buf[off++] = nRings;
	buf[off++] = Math.round(cellInertia * 255);
	buf[off++] = (isVonNeumann ? 1 : 0) | (nextWeightsIdx << 1);
	for (let i = 0; i < 3; i++) buf[off++] = currentPaletteId.charCodeAt(i);
	dv.setInt16(off, minNeighborWeight, true);
	off += 2;
	dv.setUint16(off, ruleCount, true);
	off += 2;
	for (let i = 0; i < ruleCount; i++) buf[off++] = rules[i];
	for (let i = 0; i < nStates; i++) buf[off++] = Math.min(255, Math.round(weights[i] * WEIGHT_SCALE));
	return buf;
}

function unpackState(buf) {
	if (!buf || buf.length < 13) return false;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let off = 0;
	const version = buf[off++];
	if (version !== STATE_VERSION) return false;

	const newNStates = buf[off++];
	const newNeighborRange = buf[off++];
	const newNRings = buf[off++];
	const newCellInertia = buf[off++] / 255;
	const flags = buf[off++];
	const newIsVonNeumann = (flags & 1) !== 0;
	const newNextWeightsIdx = (flags >> 1) & 3;
	const newPaletteId = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2]);
	off += 3;
	const newMinNeighborWeight = dv.getInt16(off, true);
	off += 2;
	const ruleCount = dv.getUint16(off, true);
	off += 2;

	if (buf.length < off + ruleCount + newNStates) return false;

	nStates = newNStates;
	neighborRange = newNeighborRange;
	nRings = newNRings;
	cellInertia = newCellInertia;
	isVonNeumann = newIsVonNeumann;
	nextWeightsIdx = newNextWeightsIdx;
	currentPaletteId = newPaletteId in rawPalettes ? newPaletteId : paletteIds[0];
	paletteOrderIdx = paletteIds.indexOf(currentPaletteId);
	if (paletteOrderIdx === -1) paletteOrderIdx = 0;
	minNeighborWeight = newMinNeighborWeight;

	rules.fill(0);
	for (let i = 0; i < ruleCount; i++) rules[i] = buf[off++];
	for (let i = 0; i < nStates; i++) weights[i] = buf[off++] / WEIGHT_SCALE;

	return { ruleCount };
}

function encodeStateToUrl() {
	const buf = packState();
	return buf ? compressToUrl(buf) : null;
}

function restoreStateFromUrl(encoded) {
	try {
		const buf = decompressFromUrl(encoded);
		const result = unpackState(buf);
		if (!result) return false;

		generateRings();
		const palette = rawPalettes[currentPaletteId] || rawPalettes[paletteIds[0]];
		const normalizedPalette = palette.map(hexToNormalizedRGB);
		for (let i = 0; i < MAX_N_STATES; ++i) {
			const rgbComponents = [...normalizedPalette[i % normalizedPalette.length]];
			if (i >= normalizedPalette.length) {
				for (let j = 0; j < rgbComponents.length; ++j) {
					rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + Math.random() * 0.1 - 0.05));
				}
			}
			const rIdx = i * 3;
			colors[rIdx] = rgbComponents[0];
			colors[rIdx + 1] = rgbComponents[1];
			colors[rIdx + 2] = rgbComponents[2];
		}

		if (updateShader) {
			syncShaderUniforms();
			applyRulesToShader(result.ruleCount);
		}
		if (displayShader) {
			displayShader.updateUniforms({ u_colors: getColorsForUniform() });
		}
		needsDisplayUpdate = true;
		return true;
	} catch {
		return false;
	}
}

function updateUniforms() {
	recalcMinNeighborWeight();
	generateNewRuleset();
	syncShaderUniforms();
}

function updateUniformsKeepRuleset() {
	recalcMinNeighborWeight();
	syncShaderUniforms();
}

function setNeighborRange(newNeighborRange, keepRuleset = false) {
	neighborRange = newNeighborRange;
	if (keepRuleset) {
		updateUniformsKeepRuleset();
	} else {
		updateUniforms();
	}
}

const N_WEIGHT_DISTRIBUTIONS = 4;
function updateWeights(direction = 1) {
	let returnLabel = '';
	nextWeightsIdx = (N_WEIGHT_DISTRIBUTIONS + nextWeightsIdx + direction) % N_WEIGHT_DISTRIBUTIONS;
	switch (nextWeightsIdx) {
		case 0:
			for (let i = 0; i < MAX_N_STATES; ++i) weights[i] = (i % 2) * MAX_WEIGHT;
			returnLabel = '0, 1, 0, 1…';
			break;
		case 1:
			weights.set(generateFurthestSubsequentDistanceArray(MAX_N_STATES, [0, MAX_WEIGHT]));
			returnLabel = '0, 1, ½, ¾…';
			break;
		case 2: {
			const pattern = [0, 0.5, 1, 0.5, 0].map(n => n * MAX_WEIGHT);
			for (let i = 0; i < MAX_N_STATES; ++i) weights[i] = pattern[i % pattern.length];
			returnLabel = '0, ½, 1, ½, 0…';
			break;
		}
		case 3:
			for (let i = 0; i < MAX_N_STATES; ++i) weights[i] = Math.random() * MAX_WEIGHT;
			returnLabel = 'random';
			break;
	}
	updateUniformsKeepRuleset();
	return returnLabel;
}

function updateColors(direction = 1) {
	paletteOrderIdx = (paletteIds.length + paletteOrderIdx + direction) % paletteIds.length;
	currentPaletteId = paletteIds[paletteOrderIdx];
	const palette = rawPalettes[currentPaletteId];
	const normalizedPalette = palette.map(hexToNormalizedRGB);
	for (let i = 0; i < MAX_N_STATES; ++i) {
		const rgbComponents = [...normalizedPalette[i % normalizedPalette.length]];
		if (i >= normalizedPalette.length) {
			for (let j = 0; j < rgbComponents.length; ++j) {
				rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + Math.random() * 0.1 - 0.05));
			}
		}
		const rIdx = i * 3;
		colors[rIdx] = rgbComponents[0];
		colors[rIdx + 1] = rgbComponents[1];
		colors[rIdx + 2] = rgbComponents[2];
	}
	if (displayShader) displayShader.updateUniforms({ u_colors: getColorsForUniform() });
	needsDisplayUpdate = true;
}

let hideErrorTimeout;
const errorContainer = document.getElementById('error');
function showError() {
	clearTimeout(hideErrorTimeout);
	errorContainer.classList.add('show');
	hideErrorTimeout = window.setTimeout(() => errorContainer.classList.remove('show'), 2000);
}

let hideInfoTimeout;
const infoContainer = document.getElementById('info');
function showInfo(text) {
	clearTimeout(hideInfoTimeout);
	infoContainer.textContent = text;
	infoContainer.classList.add('show');
	hideInfoTimeout = window.setTimeout(() => infoContainer.classList.remove('show'), 2000);
}

setNeighborRange(2);
updateWeights(0);
updateColors(0);

const instructionsContainer = document.getElementById('instructions');
instructionsContainer
	.querySelector('button')
	.addEventListener('click', () => instructionsContainer.classList.remove('show'));

function setCanvasSize() {
	const dpr = window.devicePixelRatio || 1;
	const w = Math.max(1, Math.floor(window.innerWidth * dpr * resolutionMultiplier));
	const h = Math.max(1, Math.floor(window.innerHeight * dpr * resolutionMultiplier));
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}
}

let resizeObserver;
function setupResizeObserver() {
	resizeObserver = new ResizeObserver(() => setCanvasSize());
	resizeObserver.observe(canvas.parentElement || document.body);
}

function scramble() {
	const { width, height } = canvas;
	updateShader.reset();
	updateShader.updateTextures({ u_seed: { data: getRandomTextureData(width, height), width, height } });
}

setCanvasSize();
createShaders();
setupResizeObserver();

function tryRestoreFromHash() {
	const hash = location.hash.slice(1);
	if (hash) {
		if (restoreStateFromUrl(hash)) {
			scramble();
			return true;
		}
	}
	return false;
}

tryRestoreFromHash();

window.addEventListener('hashchange', () => {
	if (tryRestoreFromHash()) {
		scramble();
	}
});

function render() {
	if (!isPaused && updateShader) {
		updateShader.step();
		needsDisplayUpdate = true;
	}

	if (needsDisplayUpdate && displayShader) {
		displayShader.updateTextures({ u_stateTexture: updateShader });
		displayShader.draw();
		needsDisplayUpdate = false;
	}
	requestAnimationFrame(render);
}
requestAnimationFrame(render);
