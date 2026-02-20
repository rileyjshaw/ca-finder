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

import palettes from './palettes.js';
import { generateFurthestSubsequentDistanceArray, hexToNormalizedRGB, shuffleArray } from './util.js';

import './style.css';

// Configurable.
const MAX_WEIGHT = 1.5;
const MAX_N_STATES = 128;
const MAX_NEIGHBOR_RANGE = 11;
const MIN_STACKED_UPDATES = 1;
const MAX_STACKED_UPDATES = 8;

// Derived.
const MAX_N_RULES = Math.floor(MAX_WEIGHT * (Math.pow(MAX_NEIGHBOR_RANGE * 2 + 1, 2) - 1) + 1);
const STACKED_OFFSETS = Array.from({ length: MAX_STACKED_UPDATES }, (_, i) => i && 1 / (i + 1));

tinykeys(window, {
	KeyB: () => {
		if (displayShader?.save) displayShader.save('ca-finder-export.png');
	},
	KeyC: () => updateColors(),
	'Shift+KeyC': () => updateColors(-1),
	KeyD: () => {
		resolutionMultiplier = Math.min(2, resolutionMultiplier * 2);
		setCanvasSize();
		showInfo(`Density: ${Math.round(resolutionMultiplier * 100)}%`);
	},
	'Shift+KeyD': () => {
		resolutionMultiplier /= 2;
		setCanvasSize();
		showInfo(`Density: ${Math.round(resolutionMultiplier * 100)}%`);
	},
	KeyI: () => {
		cellInertia = Math.min(1, cellInertia + 0.05);
		updateUniforms();
		showInfo(`Cell inertia: ${Math.round(cellInertia * 100)}%`);
	},
	'Shift+KeyI': () => {
		cellInertia = Math.max(0, cellInertia - 0.05);
		updateUniforms();
		showInfo(`Cell inertia: ${Math.round(cellInertia * 100)}%`);
	},
	KeyN: () => {
		setNeighborRange(Math.min(MAX_NEIGHBOR_RANGE, neighborRange + 1));
		showInfo(`Neighbor range: ${neighborRange}`);
	},
	'Shift+KeyN': () => {
		setNeighborRange(Math.max(neighborRange - 1, 1));
		showInfo(`Neighbor range: ${neighborRange}`);
	},
	KeyR: () => {
		updateUniforms();
	},
	KeyS: () => scramble(),
	KeyT: () => {
		stackedUpdateCount = Math.min(MAX_STACKED_UPDATES, stackedUpdateCount + 1);
		showInfo(`Stacked updates: ${stackedUpdateCount}`);
	},
	'Shift+KeyT': () => {
		stackedUpdateCount = Math.max(MIN_STACKED_UPDATES, stackedUpdateCount - 1);
		showInfo(`Stacked updates: ${stackedUpdateCount}`);
	},
	KeyV: () => {
		isVonNeumann = !isVonNeumann;
		updateUniforms();
		showInfo(isVonNeumann ? 'Von Neumann neighborhood' : 'Moore neighborhood');
	},
	KeyW: () => {
		showInfo(`Weights: ${updateWeights()}`);
	},
	'Shift+KeyW': () => {
		showInfo(`Weights: ${updateWeights(-1)}`);
	},
	Space: () => {
		isPaused = !isPaused;
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
let stackedUpdateCount = 1;
let resolutionMultiplier = 0.25;
let isPaused = false;

const weights = new Float32Array(MAX_N_STATES);
const rules = new Uint8Array(MAX_N_RULES);
let colors = new Float32Array(MAX_N_STATES * 3);
let nextPaletteIdx = 0;
let nextWeightsIdx = 0;

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
uniform float u_canvasOffset;
uniform float u_weights[${MAX_N_STATES}];
uniform uint u_rules[${MAX_N_RULES}];
uniform uint u_minNeighborWeight;
uniform int u_neighborRange;
uniform int u_vonNeumann;
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
	vec2 canvasOffsetPx = u_resolution * u_canvasOffset;
	uint state = getState(v_uv);

	float sum = 0.0;
	for (int dx = -u_neighborRange; dx <= u_neighborRange; dx++) {
		for (int dy = -u_neighborRange; dy <= u_neighborRange; dy++) {
			if (dx == 0 && dy == 0) continue;
			if (u_vonNeumann != 0 && (abs(dx) + abs(dy) > u_neighborRange)) continue;
			sum += u_weights[getState(v_uv + (canvasOffsetPx + vec2(float(dx), float(dy))) * onePixel)];
		}
	}
	uint ruleIndex = uint(sum) - u_minNeighborWeight;
	uint newState = u_rules[ruleIndex];

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
	updateShader.initializeUniform('u_rules', 'uint', Array.from(rules), { arrayLength: MAX_N_RULES });
	updateShader.initializeUniform('u_minNeighborWeight', 'uint', 0);
	updateShader.initializeUniform('u_neighborRange', 'int', neighborRange);
	updateShader.initializeUniform('u_vonNeumann', 'int', isVonNeumann ? 1 : 0);
	updateShader.initializeUniform('u_canvasOffset', 'float', 0);
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

function updateUniforms() {
	const nNeighbors = Math.pow(neighborRange * 2 + 1, 2) - 1;
	const { minWeight, maxWeight } = Array.from(weights.slice(0, nStates)).reduce(
		(acc, weight) => {
			if (weight < acc.minWeight) acc.minWeight = weight;
			if (weight > acc.maxWeight) acc.maxWeight = weight;
			return acc;
		},
		{ minWeight: Infinity, maxWeight: -Infinity },
	);
	minNeighborWeight = Math.floor(minWeight * nNeighbors);
	const maxNeighborWeight = Math.floor(maxWeight * nNeighbors);
	const nRules = maxNeighborWeight - minNeighborWeight + 1;
	if (nRules > MAX_N_RULES) {
		console.error('Too many rules:', nRules, weights);
		showError();
	}
	const newRules = Array.from({ length: nRules }, (_, i) => {
		if (i < nStates && cellInertia < 1) return i + 1;
		return Math.random() < cellInertia ? 0 : Math.floor(Math.random() * (nStates + 1));
	});
	shuffleArray(newRules);
	rules.set(newRules, 0);

	if (updateShader) {
		updateShader.updateUniforms({
			u_weights: Array.from(weights),
			u_rules: Array.from(rules),
			u_minNeighborWeight: minNeighborWeight,
			u_neighborRange: neighborRange,
			u_vonNeumann: isVonNeumann ? 1 : 0,
		});
	}
}

function setNeighborRange(newNeighborRange) {
	neighborRange = newNeighborRange;
	updateUniforms();
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
	updateUniforms();
	return returnLabel;
}

function updateColors(direction = 1) {
	nextPaletteIdx = (palettes.length + nextPaletteIdx + direction) % palettes.length;
	const normalizedPalette = palettes[nextPaletteIdx].map(hexToNormalizedRGB);
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

function render() {
	setCanvasSize();

	if (!isPaused && updateShader) {
		for (let i = 0; i < stackedUpdateCount; i++) {
			updateShader.updateUniforms({ u_canvasOffset: STACKED_OFFSETS[i] });
			updateShader.step();
		}
	}

	if (displayShader) {
		displayShader.updateTextures({ u_stateTexture: updateShader });
		displayShader.draw();
	}
	requestAnimationFrame(render);
}
requestAnimationFrame(render);
