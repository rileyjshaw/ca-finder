/* Here’s how this program works:

It’s based on my prior CA Finder (https://rileyjshaw.com/glitch-archive/projects/fs-ca-finder/),
and its variants. But this time it uses the GPU.

It is a cellular automaton simulation with the following rules:

- Each cell has a state, which has an associated color and a weight.
- The color is output directly to the screen. Forget about that and let’s focus on the weight.
- Weights are typically low integers. When updating to the next frame, each cell sums the weights of its neighbors.
- Every possible sum has an associated rule that maps it to a new state via a per-state rule array.
- Each per-state rule array is 1-indexed, so a value of 3 means “change to state 3”. A value of 0 means the cell should remain the same.

So for the following pixel in the center:

1 0 1
1 X 1
0 1 0

we sum the neighbor weights (shown) and get 5. We look that up in the current state (X) rule array:

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
const MAX_ENCODED_STATE_LENGTH = 240;

let needsDisplayUpdate = true;
function ifInstructionsHidden(cb) {
	return (...args) => {
		if (!instructionsContainer.classList.contains('show')) cb(...args);
	};
}
tinykeys(window, {
	...Object.fromEntries(
		Object.entries({
			Enter: () => {
				const encoded = syncUrlFromState();
				if (encoded != null && encoded.length <= MAX_ENCODED_STATE_LENGTH) {
					displayShader.save(`ca-${encoded}.png`);
				} else {
					if (encoded?.length > MAX_ENCODED_STATE_LENGTH) {
						window.alert(
							`Encoded state exceeded ${MAX_ENCODED_STATE_LENGTH} characters; filename was truncated.`,
						);
					}
					displayShader.save('ca-export.png');
				}
			},
			KeyS: scramble,
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
			KeyF: () => {
				isSemitotalistic = !isSemitotalistic;
				syncShaderUniforms();
				syncUrlFromState();
				showInfo(isSemitotalistic ? 'Semitotalistic' : 'Totalistic');
			},
			KeyR: () => {
				wrapBehaviour = (wrapBehaviour + 1) % N_WRAP_BEHAVIOURS;
				syncShaderUniforms();
				syncUrlFromState();
				showInfo(`${WRAP_BEHAVIOURS[wrapBehaviour]}`);
			},
			'Shift+KeyR': () => {
				wrapBehaviour = (wrapBehaviour + N_WRAP_BEHAVIOURS - 1) % N_WRAP_BEHAVIOURS;
				syncShaderUniforms();
				syncUrlFromState();
				showInfo(`${WRAP_BEHAVIOURS[wrapBehaviour]}`);
			},
			KeyV: () => {
				setPaletteOffset(paletteOffset + 1);
				showInfo(`Palette offset: ${paletteOffset}`);
			},
			'Shift+KeyV': () => {
				setPaletteOffset(paletteOffset - 1);
				showInfo(`Palette offset: ${paletteOffset}`);
			},
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
					syncUrlFromState();
				}
				showInfo(`Cell inertia: ${Math.round(cellInertia * 100)}%`);
			},
			'Shift+KeyE': () => {
				const next = Math.max(0, cellInertia - 0.05);
				if (next !== cellInertia) {
					cellInertia = next;
					syncUrlFromState();
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
				neighborhoodType = (neighborhoodType + 1) % N_NEIGHBORHOOD_TYPES;
				updateUniformsKeepRuleset();
				showInfo(`${NEIGHBORHOOD_TYPES[neighborhoodType]} Neighborhood`);
			},
			'Shift+KeyX': () => {
				neighborhoodType = (neighborhoodType + N_NEIGHBORHOOD_TYPES - 1) % N_NEIGHBORHOOD_TYPES;
				updateUniformsKeepRuleset();
				showInfo(`${NEIGHBORHOOD_TYPES[neighborhoodType]} Neighborhood`);
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
				if (redoRulesetChange()) {
					showInfo('Redo');
				} else {
					showInfo('No redo history');
				}
			},
			ArrowUp: e => {
				e.preventDefault();
				resetPaletteOffset(false);
				if (generateNewRuleset()) {
					pushRulesetToHistory();
					showInfo('New ruleset');
				}
			},
			ArrowDown: e => {
				e.preventDefault();
				if (mutateRuleset()) {
					pushRulesetToHistory();
					showInfo('Mutate');
				}
			},
			ArrowLeft: e => {
				e.preventDefault();
				if (undoRulesetChange()) {
					showInfo('Undo');
				} else {
					showInfo('No undo history');
				}
			},
			Space: () => {
				isPaused = !isPaused;
				if (!isPaused) needsDisplayUpdate = true;
				showInfo(isPaused ? 'Paused' : 'Playing');
			},
			BracketRight: () => changeBank(1),
			'Shift+BracketRight': () => changeBank(-1),
			BracketLeft: () => changeBank(-1),
			'Shift+BracketLeft': () => changeBank(1),
			'Shift+?': () => instructionsContainer.classList.toggle('show'),
		}).map(([key, cb]) => [key, ifInstructionsHidden(cb)]),
	),
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
let isSemitotalistic = false;
const WRAP_BEHAVIOURS = ['Wrap', 'Reflect', 'Clamp'];
const N_WRAP_BEHAVIOURS = WRAP_BEHAVIOURS.length;
let wrapBehaviour = 0;
const NEIGHBORHOOD_TYPES = ['Moore', 'Von Neumann', 'Cross', 'Star', 'Checkerboard'];
const N_NEIGHBORHOOD_TYPES = NEIGHBORHOOD_TYPES.length;
let neighborhoodType = 0;
let neighborRange;
let minNeighborWeight;
let nRings = 2;
let resolutionMultiplier = 0.25;
let isPaused = false;

const weights = new Float32Array(MAX_N_STATES);
const rulesByState = new Uint8Array(MAX_N_STATES * MAX_N_RULES);
let colors = new Float32Array(MAX_N_STATES * 3);
let currentPaletteId = paletteIds[0];
let paletteOrderIdx = 0;
let nextWeightsIdx = 0;
let paletteOffset = 0;

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

function getRulesetStart(stateIndex) {
	return stateIndex * MAX_N_RULES;
}

function getRuleset(ruleCount, stateIndex) {
	const start = getRulesetStart(stateIndex);
	return rulesByState.subarray(start, start + ruleCount);
}

function setRuleset(ruleCount, stateIndex, values) {
	const start = getRulesetStart(stateIndex);
	rulesByState.set(values.subarray(0, ruleCount), start);
}

function createRandomRuleset(ruleCount) {
	const newRules = Array.from({ length: ruleCount }, (_, i) => {
		if (i < nStates && cellInertia < 1) return i + 1;
		return Math.random() < cellInertia ? 0 : Math.floor(Math.random() * (nStates + 1));
	});
	shuffleArray(newRules);
	return new Uint8Array(newRules);
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
uniform int u_isSemitotalistic;
uniform int u_minNeighborWeight;
uniform int u_maxNeighborRange;
uniform int u_neighborhoodType;
uniform int u_wrapBehaviour;
uniform int u_nRings;
uniform float u_ringInner[${MAX_N_RINGS}];
uniform float u_ringOuter[${MAX_N_RINGS}];
uniform float u_ringWeights[${MAX_N_RINGS}];
uniform uint u_nStates;
uniform int u_frame;

in vec2 v_uv;
out uint outColor;

uint wrapState(uint s) {
	return s % u_nStates;
}

float reflect1(float x) {
	float t = mod(x, 2.0);
	if (t < 0.0) t += 2.0;
	return t <= 1.0 ? t : 2.0 - t;
}

vec2 mapCoord(vec2 coord) {
	if (u_wrapBehaviour == 0) {
		return fract(coord);
	}
	if (u_wrapBehaviour == 1) {
		return vec2(reflect1(coord.x), reflect1(coord.y));
	}
	return clamp(coord, vec2(0.0), vec2(1.0));
}

uint getStateFromHistory(vec2 coord) {
	coord = mapCoord(coord);
	float z = historyZ(u_history, u_historyFrameOffset, 1);
	return wrapState(texture(u_history, vec3(coord, z)).r);
}

uint getState(vec2 coord) {
	if (u_frame == 0) {
		coord = mapCoord(coord);
		return wrapState(texture(u_seed, coord).r);
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
				if (u_neighborhoodType == 1 && (abs(dx) + abs(dy) > iOuter)) continue; // Von Neumann
				if (u_neighborhoodType == 2 && (dx != 0 && dy != 0)) continue; // Cross
				if (u_neighborhoodType == 3 && (abs(dx) != abs(dy))) continue; // Star
				if (u_neighborhoodType == 4 && (((dx + dy) & 1) != 0)) continue; // Checkerboard

				ringSum += u_weights[getState(v_uv + vec2(float(dx), float(dy)) * onePixel)];
			}
		}
		totalSum += ringSum * ringW;
	}

	int iSum = int(floor(totalSum));
	int ruleIndex = iSum - u_minNeighborWeight;
	if (ruleIndex < 0) ruleIndex = 0;
	if (ruleIndex >= u_nRules) ruleIndex = u_nRules - 1;
	uint rulesetState = u_isSemitotalistic == 1 ? state : 0u;
	uint newState = texelFetch(u_rules, ivec2(ruleIndex, int(rulesetState)), 0).r;

	if (newState == 0u) {
		outColor = state;
	} else {
		outColor = wrapState(newState - 1u);
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
	updateShader.initializeTexture(
		'u_rules',
		{ data: rulesByState, width: MAX_N_RULES, height: MAX_N_STATES },
		R8UI_OPTIONS,
	);
	updateShader.initializeUniform('u_nStates', 'uint', nStates);
	updateShader.initializeUniform('u_nRules', 'int', MAX_N_RULES);
	updateShader.initializeUniform('u_isSemitotalistic', 'int', isSemitotalistic ? 1 : 0);
	updateShader.initializeUniform('u_minNeighborWeight', 'int', 0);
	updateShader.initializeUniform('u_maxNeighborRange', 'int', neighborRange);
	updateShader.initializeUniform('u_neighborhoodType', 'int', neighborhoodType);
	updateShader.initializeUniform('u_wrapBehaviour', 'int', wrapBehaviour);
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
	const nColors = rawPalettes[currentPaletteId].length;
	return Array.from({ length: MAX_N_STATES }, (_, i) => {
		const sourceState = (i + paletteOffset) % nColors;
		const sourceIndex = sourceState * 3;
		return [colors[sourceIndex], colors[sourceIndex + 1], colors[sourceIndex + 2]];
	});
}

function setPaletteOffset(nextOffset, shouldSyncUrl = true) {
	const nColors = rawPalettes[currentPaletteId].length;
	const normalizedOffset = ((nextOffset % nColors) + nColors) % nColors;
	if (paletteOffset === normalizedOffset) return false;
	paletteOffset = normalizedOffset;
	if (displayShader) {
		displayShader.updateUniforms({ u_colors: getColorsForUniform() });
	}
	needsDisplayUpdate = true;
	if (shouldSyncUrl) syncUrlFromState();
	return true;
}

function resetPaletteOffset(shouldSyncUrl = true) {
	return setPaletteOffset(0, shouldSyncUrl);
}

const MAX_RULESET_HISTORY = 128;
let rulesetHistoryIndex = -1;

function createRulesetHistoryEntry() {
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
	if (nRulesNeeded < 1) return null;
	const ruleCount = Math.min(nRulesNeeded, MAX_N_RULES);
	const rulesSnapshot = new Uint8Array(MAX_N_STATES * ruleCount);
	for (let stateIndex = 0; stateIndex < MAX_N_STATES; stateIndex++) {
		rulesSnapshot.set(getRuleset(ruleCount, stateIndex), stateIndex * ruleCount);
	}
	return {
		rulesByState: rulesSnapshot,
		ruleCount,
		minNeighborWeight,
	};
}

function applyRulesetHistoryEntry(entry) {
	rulesByState.fill(0);
	const statesToRestore = Math.min(MAX_N_STATES, Math.floor(entry.rulesByState.length / entry.ruleCount));
	for (let stateIndex = 0; stateIndex < statesToRestore; stateIndex++) {
		const srcStart = stateIndex * entry.ruleCount;
		const srcEnd = srcStart + entry.ruleCount;
		setRuleset(entry.ruleCount, stateIndex, entry.rulesByState.subarray(srcStart, srcEnd));
	}
	minNeighborWeight = entry.minNeighborWeight;
	applyRulesToShader(entry.ruleCount);
	syncUrlFromState();
}

function pushRulesetToHistory() {
	const entry = createRulesetHistoryEntry();
	if (!entry) return;
	if (rulesetHistoryIndex < rulesetHistory.length - 1) {
		rulesetHistory.splice(rulesetHistoryIndex + 1);
	}
	rulesetHistory.push(entry);
	if (rulesetHistory.length > MAX_RULESET_HISTORY) {
		rulesetHistory.shift();
	}
	rulesetHistoryIndex = rulesetHistory.length - 1;
}

function resetRulesetHistory() {
	const entry = createRulesetHistoryEntry();
	if (!entry) return;
	rulesetHistory.length = 0;
	rulesetHistory.push(entry);
	rulesetHistoryIndex = 0;
}

function undoRulesetChange() {
	if (rulesetHistoryIndex <= 0) return false;
	rulesetHistoryIndex--;
	applyRulesetHistoryEntry(rulesetHistory[rulesetHistoryIndex]);
	return true;
}

function redoRulesetChange() {
	if (rulesetHistoryIndex >= rulesetHistory.length - 1) return false;
	rulesetHistoryIndex++;
	applyRulesetHistoryEntry(rulesetHistory[rulesetHistoryIndex]);
	return true;
}

function applyRulesToShader(ruleCount) {
	if (updateShader) {
		updateShader.updateTextures({
			u_rules: { data: rulesByState, width: MAX_N_RULES, height: MAX_N_STATES },
		});
		updateShader.updateUniforms({
			u_nRules: ruleCount,
			u_isSemitotalistic: isSemitotalistic ? 1 : 0,
			u_minNeighborWeight: minNeighborWeight,
		});
	}
}

function generateNewRuleset() {
	const ruleCount = getCurrentRuleCount();
	if (ruleCount < 1) return false;
	rulesByState.fill(0);
	for (let stateIndex = 0; stateIndex < MAX_N_STATES; stateIndex++) {
		setRuleset(ruleCount, stateIndex, createRandomRuleset(ruleCount));
	}
	applyRulesToShader(ruleCount);
	syncUrlFromState();
	return true;
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

function mutateRuleset() {
	const ruleCount = getCurrentRuleCount();
	if (ruleCount < 1) return false;
	if (isSemitotalistic) {
		const targetState = Math.floor(Math.random() * nStates);
		setRuleset(ruleCount, targetState, createRandomRuleset(ruleCount));
	} else {
		const i = Math.floor(Math.random() * ruleCount);
		rulesByState[i] = Math.random() < cellInertia ? 0 : Math.floor(Math.random() * (nStates + 1));
	}
	applyRulesToShader(ruleCount);
	syncUrlFromState();
	return true;
}

function countCellsInRing(innerR, outerR) {
	let count = 0;
	const iOuter = Math.floor(outerR);
	for (let dx = -iOuter; dx <= iOuter; dx++) {
		for (let dy = -iOuter; dy <= iOuter; dy++) {
			if (dx === 0 && dy === 0) continue;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist < innerR || dist > outerR) continue;
			if (neighborhoodType === 1 && Math.abs(dx) + Math.abs(dy) > iOuter) continue;
			if (neighborhoodType === 2 && dx !== 0 && dy !== 0) continue;
			if (neighborhoodType === 3 && Math.abs(dx) !== Math.abs(dy)) continue;
			if (neighborhoodType === 4 && ((dx + dy) & 1) !== 0) continue;
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
		u_rules: { data: rulesByState, width: MAX_N_RULES, height: MAX_N_STATES },
	});
	updateShader.updateUniforms({
		u_weights: Array.from(weights),
		u_nStates: nStates,
		u_nRules: ruleCount,
		u_isSemitotalistic: isSemitotalistic ? 1 : 0,
		u_minNeighborWeight: minNeighborWeight,
		u_maxNeighborRange: neighborRange,
		u_neighborhoodType: neighborhoodType,
		u_wrapBehaviour: wrapBehaviour,
		u_nRings: nRings,
		u_ringInner: Array.from(ringInnerRadii),
		u_ringOuter: Array.from(ringOuterRadii),
		u_ringWeights: Array.from(ringWeights),
	});
}

const N_BANKS = 100;
const SLOTS_PER_BANK = 10;
const SLOT_HOLD_MS = 400;
const STORAGE_KEY = 'ca-finder';

let currentBank = 0;
let memory = {};
let slotHoldTimer = null;
let slotHoldN = null;

function loadFromStorage() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const data = JSON.parse(raw);
		if (data.memory && typeof data.memory === 'object') memory = data.memory;
		if (typeof data.bank === 'number') currentBank = Math.max(0, Math.min(N_BANKS - 1, data.bank));
	} catch {
		// ignore
	}
}

function saveToStorage() {
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ bank: currentBank, memory }));
}

function memoryKey(bank, slot) {
	return `${bank}-${slot}`;
}

function saveToSlot(n) {
	const encoded = encodeState();
	if (!encoded) return;
	const key = memoryKey(currentBank, n);
	memory[key] = encoded;
	saveToStorage();
	showInfo(`Memory saved to ${key}`);
	showBankSlots();
}

function applySlot(n) {
	const key = memoryKey(currentBank, n);
	const encoded = memory[key];
	if (!encoded) return;
	restoreStateFromUrl(encoded);
	syncUrlFromState();
}

function changeBank(direction) {
	currentBank = (N_BANKS + currentBank + direction) % N_BANKS;
	saveToStorage();
	showInfo(`Memory bank ${currentBank.toString().padStart(2, '0')}`);
	showBankSlots();
}

function showBankSlots() {
	const dots = Array.from({ length: SLOTS_PER_BANK }, (_, i) =>
		memory[memoryKey(currentBank, (i + 1) % SLOTS_PER_BANK)] ? '●' : '○',
	).join(' ');
	showSecondaryInfo(dots);
}

window.addEventListener(
	'keydown',
	ifInstructionsHidden(({ key, repeat }) => {
		if (repeat || key < '0' || key > '9') return;
		const n = parseInt(key, 10);
		clearTimeout(slotHoldTimer);
		slotHoldN = n;
		slotHoldTimer = setTimeout(() => {
			slotHoldN = null;
			saveToSlot(n);
		}, SLOT_HOLD_MS);
	}),
);

window.addEventListener(
	'keyup',
	ifInstructionsHidden(({ key }) => {
		if (key < '0' || key > '9') return;
		const n = parseInt(key, 10);
		if (slotHoldN !== n) return;
		clearTimeout(slotHoldTimer);
		slotHoldN = null;
		applySlot(n);
	}),
);

const STATE_VERSION = 3;
const SUPPORTED_STATE_VERSIONS = [1, 2, 3];
const WEIGHT_SCALE = 255 / MAX_WEIGHT;

function packState() {
	const ruleCount = getCurrentRuleCount();
	if (ruleCount < 1) return null;
	const storedRulesetCount = isSemitotalistic ? nStates : 1;
	const rulesByteLength = storedRulesetCount * ruleCount;
	const n = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 3 + 2 + 2 + rulesByteLength + nStates;
	const buf = new Uint8Array(n);
	const dv = new DataView(buf.buffer);
	let off = 0;
	buf[off++] = STATE_VERSION;
	buf[off++] = nStates;
	buf[off++] = neighborRange;
	buf[off++] = nRings;
	buf[off++] = Math.round(cellInertia * 255);
	buf[off++] =
		(neighborhoodType & 0x07) |
		((nextWeightsIdx & 0x03) << 3) |
		(isSemitotalistic ? 0x20 : 0) |
		((wrapBehaviour & 0x03) << 6);
	buf[off++] = Math.min(MAX_N_STATES - 1, Math.max(0, paletteOffset));
	for (let i = 0; i < 3; i++) buf[off++] = currentPaletteId.charCodeAt(i);
	dv.setInt16(off, minNeighborWeight, true);
	off += 2;
	dv.setUint16(off, ruleCount, true);
	off += 2;
	for (let stateIndex = 0; stateIndex < storedRulesetCount; stateIndex++) {
		const ruleset = getRuleset(ruleCount, stateIndex);
		for (let i = 0; i < ruleCount; i++) buf[off++] = ruleset[i];
	}
	for (let i = 0; i < nStates; i++) buf[off++] = Math.min(255, Math.round(weights[i] * WEIGHT_SCALE));
	return buf;
}

function unpackState(buf) {
	if (!buf || buf.length < 13) return false;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let off = 0;
	const version = buf[off++];
	if (!SUPPORTED_STATE_VERSIONS.includes(version)) return false;

	const newNStates = buf[off++];
	const newNeighborRange = buf[off++];
	const newNRings = buf[off++];
	const newCellInertia = buf[off++] / 255;
	const flags = buf[off++];
	let newNeighborhoodType, newNextWeightsIdx, newIsSemitotalistic, newWrapBehaviour;
	if (version === 1) {
		newNeighborhoodType = (flags & 1) !== 0 ? 1 : 0;
		newNextWeightsIdx = (flags >> 1) & 3;
		newIsSemitotalistic = false;
		newWrapBehaviour = 0;
	} else {
		newNeighborhoodType = flags & 0x07;
		newNextWeightsIdx = (flags >> 3) & 3;
		newIsSemitotalistic = version === 3 ? (flags & 0x20) !== 0 : false;
		newWrapBehaviour = version === 3 ? (flags >> 6) & 0x03 : 0;
	}
	if (newNStates < MIN_N_STATES || newNStates > MAX_N_STATES) return false;

	let newPaletteOffset = 0;
	let newPaletteId;
	let newMinNeighborWeight;
	let ruleCount;
	if (version === 3) {
		if (off + 8 > buf.length) return false;
		newPaletteOffset = buf[off++];
		if (newPaletteOffset >= MAX_N_STATES) return false;
		newPaletteId = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2]);
		off += 3;
		newMinNeighborWeight = dv.getInt16(off, true);
		off += 2;
		ruleCount = dv.getUint16(off, true);
		off += 2;
		if (ruleCount < 1 || ruleCount > MAX_N_RULES) return false;
	} else {
		newPaletteId = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2]);
		off += 3;
		newMinNeighborWeight = dv.getInt16(off, true);
		off += 2;
		ruleCount = dv.getUint16(off, true);
		off += 2;
		if (ruleCount < 1 || ruleCount > MAX_N_RULES) return false;
	}

	const expectedRulesLength = version >= 3 ? (newIsSemitotalistic ? newNStates : 1) * ruleCount : ruleCount;
	if (buf.length < off + expectedRulesLength + newNStates) return false;

	nStates = newNStates;
	neighborRange = newNeighborRange;
	nRings = newNRings;
	cellInertia = newCellInertia;
	neighborhoodType = newNeighborhoodType;
	nextWeightsIdx = newNextWeightsIdx;
	isSemitotalistic = newIsSemitotalistic;
	wrapBehaviour = newWrapBehaviour < N_WRAP_BEHAVIOURS ? newWrapBehaviour : 0;
	currentPaletteId = newPaletteId in rawPalettes ? newPaletteId : paletteIds[0];
	paletteOrderIdx = paletteIds.indexOf(currentPaletteId);
	if (paletteOrderIdx === -1) paletteOrderIdx = 0;
	paletteOffset = ((newPaletteOffset % nStates) + nStates) % nStates;
	minNeighborWeight = newMinNeighborWeight;

	rulesByState.fill(0);
	if (version >= 3) {
		if (isSemitotalistic) {
			for (let stateIndex = 0; stateIndex < nStates; stateIndex++) {
				setRuleset(ruleCount, stateIndex, buf.subarray(off, off + ruleCount));
				off += ruleCount;
			}
		} else {
			const sharedRuleset = buf.subarray(off, off + ruleCount);
			off += ruleCount;
			for (let stateIndex = 0; stateIndex < nStates; stateIndex++) {
				setRuleset(ruleCount, stateIndex, sharedRuleset);
			}
		}
	} else {
		const sharedRuleset = buf.subarray(off, off + ruleCount);
		off += ruleCount;
		for (let stateIndex = 0; stateIndex < nStates; stateIndex++) {
			setRuleset(ruleCount, stateIndex, sharedRuleset);
		}
	}
	for (let i = 0; i < nStates; i++) weights[i] = buf[off++] / WEIGHT_SCALE;

	return { ruleCount };
}

function encodeState() {
	const buf = packState();
	if (!buf) return null;
	return compressToUrl(buf);
}

function syncUrlFromState() {
	const encoded = encodeState();
	if (encoded == null) return null;
	const hash = '#' + encoded;
	if (location.hash !== hash) {
		history.replaceState(null, '', location.pathname + location.search + hash);
	}
	return encoded;
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
		resetRulesetHistory();
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
	syncUrlFromState();
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
	paletteOffset = 0;
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
	syncUrlFromState();
}

let hideSecondaryInfoTimeout;
const secondaryInfoContainer = document.getElementById('info-secondary');
function showSecondaryInfo(text) {
	clearTimeout(hideSecondaryInfoTimeout);
	secondaryInfoContainer.textContent = text;
	secondaryInfoContainer.classList.add('show');
	hideSecondaryInfoTimeout = window.setTimeout(() => secondaryInfoContainer.classList.remove('show'), 2000);
}

function showError() {
	showSecondaryInfo('!');
}

let hideInfoTimeout;
const infoContainer = document.getElementById('info');
function showInfo(text) {
	clearTimeout(hideInfoTimeout);
	infoContainer.textContent = text;
	infoContainer.classList.add('show');
	hideInfoTimeout = window.setTimeout(() => infoContainer.classList.remove('show'), 2000);
}

setNeighborRange(4);
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

loadFromStorage();
resetRulesetHistory();

window.addEventListener('hashchange', () => {
	if (tryRestoreFromHash()) {
		scramble();
	}
});

const imageSeedFsSource = `#version 300 es
precision mediump float;

uniform sampler2D u_image;
uniform vec3 u_paletteColors[${MAX_N_STATES}];
uniform int u_nStates;

in vec2 v_uv;
out uint outColor;

void main() {
	vec3 pixel = texture(u_image, v_uv).rgb;
	float bestDist = 1e10;
	uint bestState = 0u;
	for (int i = 0; i < ${MAX_N_STATES}; i++) {
		if (i >= u_nStates) break;
		vec3 diff = pixel - u_paletteColors[i];
		float d = dot(diff, diff);
		if (d < bestDist) {
			bestDist = d;
			bestState = uint(i);
		}
	}
	outColor = bestState;
}
`;

let imageSeedShader = null;

function getOrCreateImageSeedShader() {
	if (imageSeedShader) {
		imageSeedShader.destroy();
		imageSeedShader = null;
	}
	imageSeedShader = new ShaderPad(imageSeedFsSource, {
		canvas,
		...R8UI_OPTIONS,
	});
	imageSeedShader.initializeTexture(
		'u_image',
		{ data: new Uint8Array(4), width: 1, height: 1 },
		{
			internalFormat: 'RGBA8',
			format: 'RGBA',
			type: 'UNSIGNED_BYTE',
			minFilter: 'NEAREST',
			magFilter: 'NEAREST',
		},
	);
	imageSeedShader.initializeUniform('u_paletteColors', 'float', getColorsForUniform(), { arrayLength: MAX_N_STATES });
	imageSeedShader.initializeUniform('u_nStates', 'int', nStates);
	return imageSeedShader;
}

const B64URL_CHARS = /^[A-Za-z0-9_-]*/;

function handleImageDrop(file) {
	const filename = file.name.replace(/\.[^.]+$/, '');
	if (!filename.startsWith('ca-')) return;

	const encoded = filename.slice(3).match(B64URL_CHARS)?.[0] ?? '';
	if (!encoded) {
		showError();
		return;
	}

	if (!restoreStateFromUrl(encoded)) {
		showError();
		return;
	}

	const img = new Image();
	const objectUrl = URL.createObjectURL(file);
	img.onerror = () => {
		URL.revokeObjectURL(objectUrl);
		showError();
	};
	img.onload = () => {
		URL.revokeObjectURL(objectUrl);

		const shader = getOrCreateImageSeedShader();
		shader.updateUniforms({ u_nStates: nStates });
		shader.updateUniforms({ u_paletteColors: getColorsForUniform() });
		shader.updateTextures({ u_image: img });
		shader.draw();

		updateShader.reset();
		updateShader.updateTextures({ u_seed: shader });
		if (displayShader) displayShader.updateTextures({ u_stateTexture: updateShader });
		needsDisplayUpdate = true;
		syncUrlFromState();

		showInfo('Loaded from image');
	};
	img.src = objectUrl;
}

window.addEventListener('dragover', e => {
	e.preventDefault();
});

window.addEventListener('drop', e => {
	e.preventDefault();
	const file = e.dataTransfer?.files?.[0];
	if (file && file.type.startsWith('image/')) {
		handleImageDrop(file);
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

tryRestoreFromHash();
requestAnimationFrame(render);
