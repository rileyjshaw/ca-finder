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

import {
	createProgramInfo,
	createBufferInfoFromArrays,
	createFramebufferInfo,
	createTexture,
	drawBufferInfo,
	resizeCanvasToDisplaySize,
	setBuffersAndAttributes,
	setUniforms,
} from 'twgl-base.js';
import { tinykeys } from 'tinykeys';

import palettes from './palettes.js';
import { generateFurthestSubsequentDistanceArray, hexToNormalizedRGB, shuffleArray } from './util.js';

// Common vertex shader.
import vsSource from './vertex.glsl';

import './style.css';

// Configurable.
const MAX_WEIGHT = 1.5;
const MAX_N_STATES = 128;
const MAX_NEIGHBOR_RANGE = 11;

// This array gives the option to run multiple update programs per frame. Args
// are [gridSize, canvasOffset].
const stackedUpdates = [[1], [1, 0.25]];

// Derived.
const MAX_N_RULES = Math.floor(MAX_WEIGHT * (Math.pow(MAX_NEIGHBOR_RANGE * 2 + 1, 2) - 1) + 1);

// Display fragment shader.
const displayFsSource = `
#version 300 es
precision mediump float;
precision mediump usampler2D;

uniform usampler2D u_screenTexture;
uniform vec3 u_colors[${MAX_N_STATES}];

in vec2 v_texCoord;
out vec4 FragColor;

void main() {
	uint cellState = texture(u_screenTexture, v_texCoord).r;
	FragColor = vec4(u_colors[cellState].rgb, 1.0);
}
`;

tinykeys(window, {
	// Change colors.
	KeyC: () => updateColors(),
	'Shift+KeyC': () => updateColors(-1),
	// Increase / decrease resolution density.
	KeyD: () => {
		resolutionMultiplier = Math.min(2, resolutionMultiplier * 2);
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	'Shift+KeyD': () => {
		resolutionMultiplier /= 2;
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	// Increase / decrease cell inertia.
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
	// Increase / decrease neighbor range.
	KeyN: () => {
		setNeighborRange(Math.min(MAX_NEIGHBOR_RANGE, neighborRange + 1));
		showInfo(`Neighbor range: ${neighborRange}`);
	},
	'Shift+KeyN': () => {
		setNeighborRange(Math.max(neighborRange - 1, 1));
		showInfo(`Neighbor range: ${neighborRange}`);
	},
	// Change rules.
	KeyR: () => {
		updateUniforms();
		showInfo('Rules changed');
	},
	// Scramble pixels.
	KeyS: () => initBuffers(),
	// Change neighborhood type.
	// TODO: This isn’t well thought out; it should update minNeighborWeight, nRules, etc.
	KeyV: () => {
		isVonNeumann = !isVonNeumann;
		showInfo(isVonNeumann ? 'Von Neumann neighborhood' : 'Moore neighborhood');
	},
	// Change weights.
	KeyW: () => {
		const label = updateWeights();
		showInfo(`Weights: ${label}`);
	},
	'Shift+KeyW': () => {
		const label = updateWeights(-1);
		showInfo(`Weights: ${label}`);
	},
	// Pause / play.
	Space: () => {
		isPaused = !isPaused;
		showInfo(isPaused ? 'Paused' : 'Playing');
	},
	'Shift+?': () => {
		instructionsContainer.classList.toggle('show');
	},
	Escape: () => {
		instructionsContainer.classList.remove('show');
	},
});

const instructionsContainer = document.getElementById('instructions');
instructionsContainer.querySelector('button').addEventListener('click', () => {
	instructionsContainer.classList.remove('show');
});

let hideErrorTimeout;
const errorContainer = document.getElementById('error');
function showError() {
	clearTimeout(hideErrorTimeout);
	errorContainer.classList.add('show');
	hideErrorTimeout = window.setTimeout(() => {
		errorContainer.classList.remove('show');
	}, 2000);
}

let hideInfoTimeout;
const infoContainer = document.getElementById('info');
function showInfo(text) {
	clearTimeout(hideInfoTimeout);
	infoContainer.textContent = text;
	infoContainer.classList.add('show');
	hideInfoTimeout = window.setTimeout(() => {
		infoContainer.classList.remove('show');
	}, 2000);
}

const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl2', { antialias: false });
gl.imageSmoothingEnabled = false;

const weights = new Float32Array(MAX_N_STATES);
const rules = new Uint8Array(MAX_N_RULES);
let nStates = 8;
let cellInertia = 0.8;
let isVonNeumann = false;
let neighborRange, minNeighborWeight;

const displayShaderInfo = createProgramInfo(gl, [vsSource, displayFsSource]);
const updateShaderInfos = stackedUpdates.map(args => createProgramInfo(gl, [vsSource, getUpdateFsSource(...args)]));

const N_WEIGHT_DISTRIBUTIONS = 4;
let nextWeightsIdx = Math.floor(Math.random() * N_WEIGHT_DISTRIBUTIONS);
function updateWeights(direction = 1) {
	let returnLabel = '';
	nextWeightsIdx = (N_WEIGHT_DISTRIBUTIONS + nextWeightsIdx + direction) % N_WEIGHT_DISTRIBUTIONS;
	switch (nextWeightsIdx) {
		case 0:
			for (let i = 0; i < MAX_N_STATES; ++i) {
				weights[i] = (i % 2) * MAX_WEIGHT;
			}
			returnLabel = '0, 1, 0, 1…';
			break;
		case 1:
			weights.set(generateFurthestSubsequentDistanceArray(MAX_N_STATES, [0, MAX_WEIGHT]));
			returnLabel = '0, 1, ½, ¾…';
			break;
		case 2:
			const pattern = [0, 0.5, 1, 0.5, 0].map(n => n * MAX_WEIGHT);
			for (let i = 0; i < MAX_N_STATES; ++i) {
				weights[i] = pattern[i % pattern.length];
			}
			returnLabel = '0, ½, 1, ½, 0…';
			break;
		case 3:
			// Random…
			for (let i = 0; i < MAX_N_STATES; ++i) {
				weights[i] = Math.random() * MAX_WEIGHT;
			}
			returnLabel = 'random';
			break;
	}

	updateUniforms();
	return returnLabel;
}
updateWeights(0);

let colors = new Float32Array(MAX_N_STATES * 3);
let nextPaletteIdx = Math.floor(Math.random() * palettes.length);
function updateColors(direction = 1) {
	nextPaletteIdx = (palettes.length + nextPaletteIdx + direction) % palettes.length;
	const normalizedPalette = palettes[nextPaletteIdx].map(hexToNormalizedRGB);
	for (let i = 0; i < MAX_N_STATES; ++i) {
		const rgbComponents = [...normalizedPalette[i % normalizedPalette.length]];
		if (i >= normalizedPalette.length) {
			// Add a small random offset to the RGB components for variety.
			for (let j = 0; j < rgbComponents.length; ++j) {
				rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + Math.random() * 0.1 - 0.05));
			}
		}
		const rIdx = i * 3;
		colors[rIdx] = rgbComponents[0];
		colors[rIdx + 1] = rgbComponents[1];
		colors[rIdx + 2] = rgbComponents[2];
	}
}
updateColors(0);

function setNeighborRange(newNeighborRange) {
	neighborRange = newNeighborRange;

	updateUniforms();
}
setNeighborRange(2);

function updateUniforms() {
	const nNeighbors = Math.pow(neighborRange * 2 + 1, 2) - 1;

	const { minWeight, maxWeight } = Array.from(weights.slice(0, nStates)).reduce(
		(acc, weight) => {
			if (weight < acc.minWeight) acc.minWeight = weight;
			if (weight > acc.maxWeight) acc.maxWeight = weight;
			return acc;
		},
		{ minWeight: Infinity, maxWeight: -Infinity }
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
}

// Update fragment shader.
function getUpdateFsSource(gridSize = 1, canvasOffset = '0.0') {
	return `
	#version 300 es
	precision mediump float;
	precision mediump usampler2D;

	uniform usampler2D u_currentStateTexture;
	uniform vec2 u_resolution;
	uniform float u_weights[${MAX_N_STATES}];
	uniform uint u_rules[${MAX_N_RULES}];
	uniform uint u_minNeighborWeight;
	uniform int u_neighborRange;
	uniform bool u_von_neumann;

	in vec2 v_texCoord;
	out uint State;

	// Function to compute the state of a cell
	uint getState(vec2 coord) {
		coord = fract(coord); // Wrap the texture coordinates around [0, 1].
		return texture(u_currentStateTexture, coord).r;
	}

	void main() {
		vec2 onePixel = vec2(${gridSize}.0) / u_resolution;
		vec2 canvasOffset = u_resolution * ${canvasOffset};
		uint state = getState(v_texCoord);

		// Count alive neighbors
		float sum = 0.0;
		for (int dx = -u_neighborRange; dx <= u_neighborRange; dx++) {
			for (int dy = -u_neighborRange; dy <= u_neighborRange; dy++) {
				if (dx == 0 && dy == 0) continue;
				if (u_von_neumann && (abs(dx) + abs(dy) > u_neighborRange)) continue; // Skip corners.
				sum += u_weights[getState(v_texCoord + canvasOffset + vec2(dx, dy) * onePixel)];
			}
		}
		uint ruleIndex = uint(sum) - u_minNeighborWeight; // Normalize to [0, maxNeighborWeight - minNeighborWeight].
		uint newState = u_rules[ruleIndex];

		if (newState == 0u) {
			State = state;
		} else {
			State = newState - 1u;
		}
	}
	`;
}

const arrays = {
	position: {
		numComponents: 2,
		data: [
			-1.0,
			-1.0, // Bottom left.
			1.0,
			-1.0, // Bottom right.
			-1.0,
			1.0, // Top left.
			1.0,
			1.0, // Top right.
		],
	},
};
const bufferInfo = createBufferInfoFromArrays(gl, arrays);

function getRandomTextureData(width, height) {
	const size = width * height;
	const data = new Uint8Array(size);
	for (let i = 0; i < size; ++i) {
		// Generate a random state.
		const state = Math.floor(Math.random() * nStates);
		data[i] = state;
	}
	return data;
}

function createRandomTexture(gl, width, height) {
	return createTexture(gl, {
		width,
		height,
		type: gl.UNSIGNED_BYTE,
		format: gl.RED_INTEGER,
		internalFormat: gl.R8UI,
		minMag: gl.NEAREST,
		wrap: gl.CLAMP_TO_EDGE,
		src: getRandomTextureData(width, height),
	});
}

// Ping-Pong setup.
let textures = [];
let fbos = [];
function initBuffers() {
	textures.forEach(texture => gl.deleteTexture(texture));
	textures = [
		createRandomTexture(gl, canvas.width, canvas.height),
		createRandomTexture(gl, canvas.width, canvas.height),
	];

	fbos.forEach(fbo => gl.deleteFramebuffer(fbo.framebuffer));
	fbos = textures.map(texture => createFramebufferInfo(gl, [{ attachment: texture }]));
}

let resolutionMultiplier = 0.5;
function resize() {
	if (resizeCanvasToDisplaySize(gl.canvas, resolutionMultiplier)) {
		initBuffers(); // Reinitialize textures and FBOs on resize.
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
	}
}

function runUpdateShader(programInfo) {
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[nextStateTextureIndex].framebuffer);
	gl.useProgram(programInfo.program);
	setBuffersAndAttributes(gl, programInfo, bufferInfo);

	// Pass data to the shader.
	setUniforms(programInfo, {
		u_weights: weights,
		u_rules: rules,
		u_minNeighborWeight: minNeighborWeight,
		u_neighborRange: neighborRange,
		u_currentStateTexture: textures[1 - nextStateTextureIndex], // Send the current state for feedback.
		u_resolution: [gl.canvas.width, gl.canvas.height],
		u_von_neumann: isVonNeumann,
	});
	drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);
}

let nextStateTextureIndex = 0;
let isPaused = false;
function render(time) {
	time /= 1000; // Convert time to seconds.
	resize();

	// 1. Update the game state: Render to off-screen texture.
	if (!isPaused) {
		updateShaderInfos.forEach(updateShaderInfo => {
			runUpdateShader(updateShaderInfo);

			// Ping pong!
			nextStateTextureIndex = 1 - nextStateTextureIndex;
		});
	}

	// 2. Display the updated state: Render to the screen.
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Bind the default framebuffer (the screen).
	gl.useProgram(displayShaderInfo.program);
	setBuffersAndAttributes(gl, displayShaderInfo, bufferInfo);

	// Pass data to the display shader.
	setUniforms(displayShaderInfo, {
		u_screenTexture: textures[1 - nextStateTextureIndex], // Send the updated state.
		u_colors: colors,
	});
	drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);
	requestAnimationFrame(render);
}
requestAnimationFrame(render);
