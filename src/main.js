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

import './palettes.js';
import {
	MAX_ENCODED_STATE_LENGTH,
	MAX_N_RINGS,
	MAX_NEIGHBOR_CELLS,
	MAX_N_RULES,
	MAX_N_STATES,
	MIN_N_STATES,
	MAX_NEIGHBOR_RANGE,
	NEIGHBORHOOD_TYPES,
	N_NEIGHBORHOOD_TYPES,
	N_WRAP_BEHAVIOURS,
	WRAP_BEHAVIOURS,
	TRANSITION_TYPES,
	RING_WEIGHT_PRESETS,
	applyColorsFromPalette,
	encodeState,
	getColorsForUniform,
	getCurrentRuleCount,
	getMinNeighborWeight,
	getNRings,
	getNeighborRange,
	getNStates,
	setNStates,
	getRulesByState,
	getWeights,
	getStateSnapshot,
	setRuleset,
	createRandomRuleset,
	generateRingRadii,
	getIsSemitotalistic,
	setIsSemitotalistic,
	getWrapBehaviour,
	setWrapBehaviour,
	getNeighborhoodType,
	setNeighborhoodType,
	setNeighborRangeValue,
	getCellInertia,
	setCellInertia,
	setNRings,
	recalcMinNeighborWeight,
	restoreStateFromUrl,
	getCurrentPaletteId,
	getPaletteOffset,
	setPaletteOffset,
	setPaletteFromSnapshot,
	updateWeights,
	updateColorsState,
	getTransitionType,
	swapTransitionType,
	getRingWeightPresetIdx,
	setRingWeightPresetIdx,
	clearInactiveRules,
	clearRuleCountOverride,
	getNextWeightsIdx,
	getRuleCountOverride,
	restoreWeightsState,
	restoreRuleCountOverride,
	buildNeighborKernel,
} from './state.js';
import { renderExplainPanel } from './explain-ruleset.js';

let needsDisplayUpdate = true;
function ifInstructionsHidden(cb) {
	return (...args) => {
		if (!instructionsContainer.classList.contains('show')) cb(...args);
	};
}
function syncUrl(cb) {
	return (...args) => {
		const result = cb(...args);
		if (result !== false) syncUrlFromState();
		return result;
	};
}

function rollbackRulespaceChange(restore, previousRuleCountOverride) {
	restore?.();
	restoreRuleCountOverride(previousRuleCountOverride);
	recalcMinNeighborWeight();
	return false;
}

function applyRulespaceChange({ mutate, restore, regenerateRuleset = false, scrambleState = false }) {
	const previousRuleCount = getCurrentRuleCount();
	const previousRuleCountOverride = getRuleCountOverride();
	const result = mutate();

	clearRuleCountOverride();
	const didUpdate = regenerateRuleset ? updateUniforms() : updateUniformsKeepRuleset(previousRuleCount);
	if (!didUpdate) return rollbackRulespaceChange(restore, previousRuleCountOverride);

	finalizeRuleSemanticsChange();
	if (scrambleState) scramble();
	return result;
}

function changeNeighborRange(direction) {
	const neighborRange = getNeighborRange();
	const next = direction > 0 ? Math.min(MAX_NEIGHBOR_RANGE, neighborRange + 1) : Math.max(neighborRange - 1, 1);
	if (next !== neighborRange && !setNeighborRange(next, true)) return false;
	showInfo(`Neighbor range: ${getNeighborRange()}`);
}

function changeStateCount(direction) {
	const nStates = getNStates();
	const next = direction > 0 ? Math.min(MAX_N_STATES, nStates + 1) : Math.max(MIN_N_STATES, nStates - 1);
	if (next !== nStates) {
		if (
			applyRulespaceChange({
				mutate: () => setNStates(next),
				restore: () => setNStates(nStates),
				regenerateRuleset: getTransitionType() === 1,
				scrambleState: true,
			}) === false
		)
			return false;
	}
	showInfo(`States: ${getNStates()}`);
}

function cycleNeighborhoodType(direction) {
	const neighborhoodType = getNeighborhoodType();
	const next = (neighborhoodType + direction + N_NEIGHBORHOOD_TYPES) % N_NEIGHBORHOOD_TYPES;
	if (
		applyRulespaceChange({
			mutate: () => setNeighborhoodType(next),
			restore: () => setNeighborhoodType(neighborhoodType),
		}) === false
	)
		return false;
	showInfo(`${NEIGHBORHOOD_TYPES[getNeighborhoodType()]} Neighborhood`);
}

function changeRingCount(direction) {
	const nRings = getNRings();
	const next = direction > 0 ? Math.min(MAX_N_RINGS, nRings + 1) : Math.max(1, nRings - 1);
	if (next !== nRings) {
		const neighborRange = getNeighborRange();
		if (
			applyRulespaceChange({
				mutate: () => {
					setNRings(next);
					if (next > nRings) {
						const minRange = next * 2;
						if (getNeighborRange() < minRange) {
							setNeighborRangeValue(Math.min(MAX_NEIGHBOR_RANGE, minRange));
						}
					}
				},
				restore: () => {
					setNRings(nRings);
					setNeighborRangeValue(neighborRange);
				},
				scrambleState: true,
			}) === false
		)
			return false;
	}
	showInfo(`Weight rings: ${getNRings()}`);
}

function cycleWeightDistribution(direction = 1) {
	const previousWeights = new Float32Array(getWeights());
	const previousWeightsIdx = getNextWeightsIdx();
	const label = applyRulespaceChange({
		mutate: () => updateWeights(direction),
		restore: () => restoreWeightsState(previousWeightsIdx, previousWeights),
	});
	if (label === false) return false;
	showInfo(`Weights: ${label}`);
}

function cycleRingWeightPreset(direction = 1) {
	const nPresets = RING_WEIGHT_PRESETS.length;
	const previousPresetIdx = getRingWeightPresetIdx();
	const nextPresetIdx = (previousPresetIdx + direction + nPresets) % nPresets;
	const label = applyRulespaceChange({
		mutate: () => {
			setRingWeightPresetIdx(nextPresetIdx);
			return RING_WEIGHT_PRESETS[nextPresetIdx].label;
		},
		restore: () => setRingWeightPresetIdx(previousPresetIdx),
		regenerateRuleset: true,
		scrambleState: true,
	});
	if (label === false) return false;
	showInfo(`Ring weights: ${label}`);
}

function toggleTransitionType() {
	const hadInactive = swapTransitionType();
	if (!recalcMinNeighborWeight()) {
		swapTransitionType();
		if (!hadInactive) clearInactiveRules();
		showError();
		return false;
	}

	if (!hadInactive) {
		clearRuleCountOverride();
		generateNewRuleset();
	} else {
		applyRulesToShader(getCurrentRuleCount());
	}
	syncShaderUniforms();
	resetRulesetHistory();
	scramble();
	showInfo(`Transition: ${TRANSITION_TYPES[getTransitionType()]}`);
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
			KeyC: syncUrl(() => updateColors()),
			'Shift+KeyC': syncUrl(() => updateColors(-1)),
			KeyF: syncUrl(() => {
				setIsSemitotalistic(!getIsSemitotalistic());
				syncShaderUniforms();
				finalizeRuleSemanticsChange();
				showInfo(getIsSemitotalistic() ? 'Semitotalistic' : 'Totalistic');
			}),
			KeyR: syncUrl(() => {
				setWrapBehaviour((getWrapBehaviour() + 1) % N_WRAP_BEHAVIOURS);
				syncShaderUniforms();
				showInfo(`${WRAP_BEHAVIOURS[getWrapBehaviour()]}`);
			}),
			'Shift+KeyR': syncUrl(() => {
				setWrapBehaviour((getWrapBehaviour() + N_WRAP_BEHAVIOURS - 1) % N_WRAP_BEHAVIOURS);
				syncShaderUniforms();
				showInfo(`${WRAP_BEHAVIOURS[getWrapBehaviour()]}`);
			}),
			KeyV: syncUrl(() => {
				if (setPaletteOffset(getPaletteOffset() + 1) && displayShader)
					displayShader.updateUniforms({ u_colors: getColorsForUniform() });
				needsDisplayUpdate = true;
				showInfo(`Palette offset: ${getPaletteOffset()}`);
			}),
			'Shift+KeyV': syncUrl(() => {
				if (setPaletteOffset(getPaletteOffset() - 1) && displayShader)
					displayShader.updateUniforms({ u_colors: getColorsForUniform() });
				needsDisplayUpdate = true;
				showInfo(`Palette offset: ${getPaletteOffset()}`);
			}),
			KeyQ: syncUrl(() => {
				return changeNeighborRange(1);
			}),
			'Shift+KeyQ': syncUrl(() => {
				return changeNeighborRange(-1);
			}),
			KeyE: syncUrl(() => {
				const cellInertia = getCellInertia();
				const next = Math.min(1, cellInertia + 0.05);
				if (next !== cellInertia) {
					setCellInertia(next);
				}
				showInfo(`Cell inertia: ${Math.round(getCellInertia() * 100)}%`);
			}),
			'Shift+KeyE': syncUrl(() => {
				const cellInertia = getCellInertia();
				const next = Math.max(0, cellInertia - 0.05);
				if (next !== cellInertia) {
					setCellInertia(next);
				}
				showInfo(`Cell inertia: ${Math.round(getCellInertia() * 100)}%`);
			}),
			KeyZ: syncUrl(() => changeStateCount(1)),
			'Shift+KeyZ': syncUrl(() => changeStateCount(-1)),
			KeyX: syncUrl(() => cycleNeighborhoodType(1)),
			'Shift+KeyX': syncUrl(() => cycleNeighborhoodType(-1)),
			KeyA: syncUrl(() => changeRingCount(1)),
			'Shift+KeyA': syncUrl(() => changeRingCount(-1)),
			KeyW: syncUrl(() => cycleWeightDistribution(1)),
			'Shift+KeyW': syncUrl(() => cycleWeightDistribution(-1)),
			KeyG: syncUrl(() => cycleRingWeightPreset(1)),
			'Shift+KeyG': syncUrl(() => cycleRingWeightPreset(-1)),
			KeyT: syncUrl(toggleTransitionType),
			ArrowRight: syncUrl(e => {
				e.preventDefault();
				redoRulesetChange();
			}),
			ArrowUp: syncUrl(e => {
				e.preventDefault();
				if (generateNewRuleset()) {
					pushRulesetToHistory();
				}
			}),
			ArrowDown: syncUrl(e => {
				e.preventDefault();
				if (mutateRuleset()) {
					pushRulesetToHistory();
				}
			}),
			ArrowLeft: syncUrl(e => {
				e.preventDefault();
				undoRulesetChange();
			}),
			Space: () => {
				isPaused = !isPaused;
				if (!isPaused) needsDisplayUpdate = true;
				showInfo(isPaused ? 'Paused' : 'Playing');
			},
			BracketRight: () => changeBank(1),
			'Shift+BracketRight': () => changeBank(-1),
			BracketLeft: () => changeBank(-1),
			'Shift+BracketLeft': () => changeBank(1),
			'Shift+?': () => {
				instructionsContainer.classList.add('show');
				instructionsView?.classList.remove('hide');
				explainView?.classList.add('hide');
			},
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
const KERNEL_TEXTURE_OPTIONS = {
	internalFormat: 'RGBA32F',
	format: 'RGBA',
	type: 'FLOAT',
	minFilter: 'NEAREST',
	magFilter: 'NEAREST',
	wrapS: 'CLAMP_TO_EDGE',
	wrapT: 'CLAMP_TO_EDGE',
};

function getNeighborKernelTexture() {
	const { data, count } = buildNeighborKernel();
	return {
		count,
		texture: {
			data,
			width: MAX_NEIGHBOR_CELLS,
			height: 1,
		},
	};
}

let updateShader;
let displayShader;
let resolutionMultiplier = 0.25;
let isPaused = false;

const rulesetHistory = [];

function getRandomTextureData(width, height) {
	const size = width * height;
	const data = new Uint8Array(size);
	for (let i = 0; i < size; ++i) {
		data[i] = Math.floor(Math.random() * getNStates());
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
uniform sampler2D u_neighborKernel;
uniform float u_weights[${MAX_N_STATES}];
uniform usampler2D u_rules;
uniform int u_nRules;
uniform int u_isSemitotalistic;
uniform int u_minNeighborWeight;
uniform int u_neighborCount;
uniform int u_wrapBehaviour;
uniform uint u_nStates;
uniform int u_frame;
uniform int u_transitionType;

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
	if (u_wrapBehaviour == 2) {
		return clamp(coord, vec2(0.0), vec2(1.0));
	}
	if (u_wrapBehaviour == 3) {
		return vec2(fract(coord.x + floor(coord.y) * 0.5), fract(coord.y));
	}
	if (u_wrapBehaviour == 4) {
		return vec2(fract(coord.x), fract(coord.y + floor(coord.x) * 0.5));
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

	int ruleIndex = 0;

	if (u_transitionType == 1) {
		// Sum order: count neighbors per state, weighted by ring weights.
		float stateSums[${MAX_N_STATES}];
		for (int i = 0; i < ${MAX_N_STATES}; i++) stateSums[i] = 0.0;

		for (int i = 0; i < ${MAX_NEIGHBOR_CELLS}; i++) {
			if (i >= u_neighborCount) break;
			vec4 neighbor = texelFetch(u_neighborKernel, ivec2(i, 0), 0);
			uint nState = getState(v_uv + neighbor.xy * onePixel);
			stateSums[nState] += neighbor.z;
		}

		// Find top 3 states by sum (ties go to lower index).
		int top1 = 0, top2 = 0, top3 = 0;
		float s1 = -3.402823e38, s2 = -3.402823e38, s3 = -3.402823e38;
		for (int i = 0; i < ${MAX_N_STATES}; i++) {
			if (i >= int(u_nStates)) break;
			float sv = stateSums[i];
			if (sv > s1) {
				s3 = s2; top3 = top2;
				s2 = s1; top2 = top1;
				s1 = sv; top1 = i;
			} else if (sv > s2) {
				s3 = s2; top3 = top2;
				s2 = sv; top2 = i;
			} else if (sv > s3) {
				s3 = sv; top3 = i;
			}
		}

		int ns = int(u_nStates);
		if (ns == 2) {
			ruleIndex = top1;
		} else {
			int top2Rank = top2;
			if (top1 < top2) top2Rank -= 1;
			int top3Rank = top3;
			if (top1 < top3) top3Rank -= 1;
			if (top2 < top3) top3Rank -= 1;
			ruleIndex = top1 * (ns - 1) * (ns - 2) + top2Rank * (ns - 2) + top3Rank;
		}
	} else {
		// Exact sum: sum neighbor weights, look up rule by sum.
		float totalSum = 0.0;
		for (int i = 0; i < ${MAX_NEIGHBOR_CELLS}; i++) {
			if (i >= u_neighborCount) break;
			vec4 neighbor = texelFetch(u_neighborKernel, ivec2(i, 0), 0);
			uint nState = getState(v_uv + neighbor.xy * onePixel);
			totalSum += neighbor.z * u_weights[nState];
		}

		int iSum = int(floor(totalSum));
		ruleIndex = iSum - u_minNeighborWeight;
	}

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
	const neighborKernel = getNeighborKernelTexture();
	updateShader.initializeTexture('u_neighborKernel', neighborKernel.texture, KERNEL_TEXTURE_OPTIONS);
	updateShader.initializeUniform('u_weights', 'float', Array.from(getWeights()), { arrayLength: MAX_N_STATES });
	updateShader.initializeTexture(
		'u_rules',
		{ data: getRulesByState(), width: MAX_N_RULES, height: MAX_N_STATES },
		R8UI_OPTIONS,
	);
	updateShader.initializeUniform('u_nStates', 'uint', getNStates());
	updateShader.initializeUniform('u_nRules', 'int', MAX_N_RULES);
	updateShader.initializeUniform('u_isSemitotalistic', 'int', getIsSemitotalistic() ? 1 : 0);
	updateShader.initializeUniform('u_minNeighborWeight', 'int', 0);
	updateShader.initializeUniform('u_neighborCount', 'int', neighborKernel.count);
	updateShader.initializeUniform('u_wrapBehaviour', 'int', getWrapBehaviour());
	updateShader.initializeUniform('u_transitionType', 'int', getTransitionType());
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

const MAX_RULESET_HISTORY = 128;
let rulesetHistoryIndex = -1;

function clearRuleRange(ruleCountA, ruleCountB) {
	if (ruleCountA === ruleCountB) return;
	const start = Math.min(ruleCountA, ruleCountB);
	const end = Math.max(ruleCountA, ruleCountB);
	const rules = getRulesByState();
	for (let stateIndex = 0; stateIndex < MAX_N_STATES; stateIndex++) {
		const offset = stateIndex * MAX_N_RULES;
		rules.fill(0, offset + start, offset + end);
	}
}

function finalizeRuleSemanticsChange() {
	clearInactiveRules();
	pushRulesetToHistory();
}

function createRulesetHistoryEntry() {
	return encodeState();
}

function applyRulesetHistoryEntry(encoded) {
	if (!encoded) return false;
	const didRestore = restoreStateFromUrl(encoded, ruleCount => {
		applyAfterUnpack(ruleCount, { resetHistory: false });
	});
	if (!didRestore) return false;
	syncUrlFromState();
	return true;
}

function pushRulesetToHistory() {
	const entry = createRulesetHistoryEntry();
	if (!entry) return false;
	if (rulesetHistory[rulesetHistoryIndex] === entry) return false;
	if (rulesetHistoryIndex < rulesetHistory.length - 1) {
		rulesetHistory.splice(rulesetHistoryIndex + 1);
	}
	rulesetHistory.push(entry);
	if (rulesetHistory.length > MAX_RULESET_HISTORY) {
		rulesetHistory.shift();
	}
	rulesetHistoryIndex = rulesetHistory.length - 1;
	return true;
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
	const previousIndex = rulesetHistoryIndex;
	const nextIndex = rulesetHistoryIndex - 1;
	rulesetHistoryIndex = nextIndex;
	if (!applyRulesetHistoryEntry(rulesetHistory[nextIndex])) {
		rulesetHistoryIndex = previousIndex;
		return false;
	}
	return true;
}

function redoRulesetChange() {
	if (rulesetHistoryIndex >= rulesetHistory.length - 1) return false;
	const previousIndex = rulesetHistoryIndex;
	const nextIndex = rulesetHistoryIndex + 1;
	rulesetHistoryIndex = nextIndex;
	if (!applyRulesetHistoryEntry(rulesetHistory[nextIndex])) {
		rulesetHistoryIndex = previousIndex;
		return false;
	}
	return true;
}

function applyRulesToShader(ruleCount) {
	if (updateShader) {
		updateShader.updateTextures({
			u_rules: { data: getRulesByState(), width: MAX_N_RULES, height: MAX_N_STATES },
		});
		updateShader.updateUniforms({
			u_nRules: ruleCount,
			u_isSemitotalistic: getIsSemitotalistic() ? 1 : 0,
			u_minNeighborWeight: getMinNeighborWeight(),
			u_transitionType: getTransitionType(),
		});
	}
}

function generateNewRuleset() {
	const canonCount = getCurrentRuleCount();
	if (canonCount < 1) return false;
	getRulesByState().fill(0);
	for (let stateIndex = 0; stateIndex < MAX_N_STATES; stateIndex++) {
		setRuleset(canonCount, stateIndex, createRandomRuleset(canonCount));
	}
	applyRulesToShader(getCurrentRuleCount());
	return true;
}

function mutateRuleset() {
	const canonCount = getCurrentRuleCount();
	if (canonCount < 1) return false;
	if (getIsSemitotalistic()) {
		const targetState = Math.floor(Math.random() * getNStates());
		setRuleset(canonCount, targetState, createRandomRuleset(canonCount));
	} else {
		const rules = getRulesByState();
		const i = Math.floor(Math.random() * canonCount);
		rules[i] = Math.random() < getCellInertia() ? 0 : Math.floor(Math.random() * (getNStates() + 1));
	}
	applyRulesToShader(getCurrentRuleCount());
	return true;
}

function syncShaderUniforms() {
	if (!updateShader) return;
	const ruleCount = getCurrentRuleCount();
	const neighborKernel = getNeighborKernelTexture();
	updateShader.updateTextures({
		u_rules: { data: getRulesByState(), width: MAX_N_RULES, height: MAX_N_STATES },
		u_neighborKernel: neighborKernel.texture,
	});
	updateShader.updateUniforms({
		u_weights: Array.from(getWeights()),
		u_nStates: getNStates(),
		u_nRules: ruleCount,
		u_isSemitotalistic: getIsSemitotalistic() ? 1 : 0,
		u_minNeighborWeight: getMinNeighborWeight(),
		u_neighborCount: neighborKernel.count,
		u_wrapBehaviour: getWrapBehaviour(),
		u_transitionType: getTransitionType(),
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

function applySlot(n, { preservePalette = false } = {}) {
	const key = memoryKey(currentBank, n);
	const encoded = memory[key];
	if (!encoded) return false;
	const currentPaletteId = getCurrentPaletteId();
	const paletteOffset = getPaletteOffset();
	const didRestore = restoreStateFromUrl(encoded, ruleCount => {
		if (preservePalette) setPaletteFromSnapshot(currentPaletteId, paletteOffset);
		applyAfterUnpack(ruleCount, { resetHistory: false });
	});
	if (!didRestore) {
		showError();
		return false;
	}
	pushRulesetToHistory();
	return true;
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

function getNumberKeySlot(event) {
	const digitMatch = event.code.match(/^Digit([0-9])$/) || event.code.match(/^Numpad([0-9])$/);
	if (digitMatch) return parseInt(digitMatch[1], 10);
	if (event.key >= '0' && event.key <= '9') return parseInt(event.key, 10);
	return null;
}

window.addEventListener(
	'keydown',
	ifInstructionsHidden(event => {
		const slot = getNumberKeySlot(event);
		if (event.repeat || slot == null) return;
		clearTimeout(slotHoldTimer);
		slotHoldN = slot;
		slotHoldTimer = setTimeout(() => {
			slotHoldN = null;
			saveToSlot(slot);
		}, SLOT_HOLD_MS);
	}),
);

window.addEventListener(
	'keyup',
	ifInstructionsHidden(event => {
		const slot = getNumberKeySlot(event);
		if (slot == null) return;
		if (slotHoldN !== slot) return;
		clearTimeout(slotHoldTimer);
		slotHoldN = null;
		if (applySlot(slot, { preservePalette: event.shiftKey })) syncUrlFromState();
	}),
);

function syncUrlFromState() {
	const encoded = encodeState();
	if (encoded == null) return null;
	if (rulesetHistoryIndex >= 0) rulesetHistory[rulesetHistoryIndex] = encoded;
	const hash = '#' + encoded;
	if (location.hash !== hash) {
		history.replaceState(null, '', location.pathname + location.search + hash);
	}
	return encoded;
}

function applyAfterUnpack(ruleCount, { resetHistory = true } = {}) {
	generateRingRadii();
	applyColorsFromPalette();
	if (updateShader) {
		syncShaderUniforms();
		applyRulesToShader(ruleCount);
	}
	if (displayShader) {
		displayShader.updateUniforms({ u_colors: getColorsForUniform() });
	}
	if (resetHistory) resetRulesetHistory();
	needsDisplayUpdate = true;
}

function updateUniforms() {
	if (!recalcMinNeighborWeight()) {
		showError();
		return false;
	}
	generateNewRuleset();
	syncShaderUniforms();
	return true;
}

function updateUniformsKeepRuleset(previousRuleCount = getCurrentRuleCount()) {
	if (!recalcMinNeighborWeight()) {
		showError();
		return false;
	}
	clearRuleRange(previousRuleCount, getCurrentRuleCount());
	syncShaderUniforms();
	return true;
}

function setNeighborRange(newNeighborRange, keepRuleset = false) {
	const previousNeighborRange = getNeighborRange();
	const previousRuleCount = getCurrentRuleCount();
	const previousRuleCountOverride = getRuleCountOverride();
	setNeighborRangeValue(newNeighborRange);
	clearRuleCountOverride();
	const didUpdate = keepRuleset ? updateUniformsKeepRuleset(previousRuleCount) : updateUniforms();
	if (!didUpdate) {
		setNeighborRangeValue(previousNeighborRange);
		return rollbackRulespaceChange(undefined, previousRuleCountOverride);
	}
	finalizeRuleSemanticsChange();
	return true;
}

function updateColors(direction = 1) {
	updateColorsState(direction);
	if (displayShader) displayShader.updateUniforms({ u_colors: getColorsForUniform() });
	needsDisplayUpdate = true;
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

updateWeights(0);
updateColors(0);
setNeighborRange(4);

const instructionsContainer = document.getElementById('instructions');
const instructionsView = document.querySelector('.instructions-view');
const explainView = document.querySelector('.explain-view');

instructionsContainer.querySelector('.start-button')?.addEventListener('click', () => {
	instructionsContainer.classList.remove('show');
});

document.getElementById('explain-ruleset-btn')?.addEventListener('click', () => {
	const snapshot = getStateSnapshot();
	if (!snapshot) return;
	const panel = renderExplainPanel(snapshot);
	explainView.innerHTML = '';
	explainView.appendChild(panel);
	instructionsView?.classList.add('hide');
	explainView?.classList.remove('hide');

	panel._backBtn?.addEventListener('click', () => {
		explainView?.classList.add('hide');
		instructionsView?.classList.remove('hide');
	});
	panel._takeLookBtn?.addEventListener('click', () => {
		instructionsContainer.classList.remove('show');
	});
});

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
		if (restoreStateFromUrl(hash, applyAfterUnpack)) {
			scramble();
			return true;
		}
	}
	return false;
}

loadFromStorage();
resetRulesetHistory();

window.addEventListener('hashchange', () => {
	tryRestoreFromHash();
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
	imageSeedShader.initializeUniform('u_nStates', 'int', getNStates());
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

	if (!restoreStateFromUrl(encoded, applyAfterUnpack)) {
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
		shader.updateUniforms({ u_nStates: getNStates() });
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
