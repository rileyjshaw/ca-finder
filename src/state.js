/**
 * CA state module: state variables, snapshot (getStateSnapshot), pack/unpack for URL and storage.
 * Main runner and explainer consume state via getStateSnapshot() or getters/setters.
 */

import rawPalettes, { paletteIds } from './palettes.js';
import {
	compressToUrl,
	decompressFromUrl,
	generateFurthestSubsequentDistanceArray,
	hexToNormalizedRGB,
	shuffleArray,
} from './util.js';

// Configurable.
export const MAX_WEIGHT = 1.5;
export const MIN_N_STATES = 2;
export const MAX_N_STATES = 32;
export const MAX_NEIGHBOR_RANGE = 12;
export const MIN_N_RINGS = 1;
export const MAX_N_RINGS = 8;

// Derived.
const MAX_CELLS_PER_RING = Math.pow(MAX_NEIGHBOR_RANGE * 2 + 1, 2);
export const MAX_N_RULES = Math.floor(MAX_WEIGHT * MAX_CELLS_PER_RING * MAX_N_RINGS + 1);
export const MAX_ENCODED_STATE_LENGTH = 240;

export const WRAP_BEHAVIOURS = ['Wrap', 'Reflect', 'Clamp', 'Brick', 'Stair'];
export const N_WRAP_BEHAVIOURS = WRAP_BEHAVIOURS.length;
export const NEIGHBORHOOD_TYPES = ['Moore', 'Von Neumann', 'Cross', 'Star', 'Checkerboard', 'Euclid'];
export const N_NEIGHBORHOOD_TYPES = NEIGHBORHOOD_TYPES.length;

const STATE_VERSION = 6;
const SUPPORTED_STATE_VERSIONS = [1, 2, 3, 4, 5, 6];
const WEIGHT_SCALE = 255 / MAX_WEIGHT;

// State variables (module-level; mutated by unpack/setters).
let nStates = 8;
let cellInertia = 0.8;
let isSemitotalistic = false;
let wrapBehaviour = 0;
let neighborhoodType = 0;
let neighborRange;
let minNeighborWeight = 0;
let nRings = 2;
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
let euclideanRings = false;

export function getEuclideanRings() {
	return euclideanRings;
}
export function setEuclideanRings(v) {
	euclideanRings = !!v;
}
export function getNStates() {
	return nStates;
}
export function setNStates(v) {
	nStates = v;
}
export function getCellInertia() {
	return cellInertia;
}
export function setCellInertia(v) {
	cellInertia = v;
}
export function getIsSemitotalistic() {
	return isSemitotalistic;
}
export function setIsSemitotalistic(v) {
	isSemitotalistic = v;
}
export function getWrapBehaviour() {
	return wrapBehaviour;
}
export function setWrapBehaviour(v) {
	wrapBehaviour = v;
}
export function getNeighborhoodType() {
	return neighborhoodType;
}
export function setNeighborhoodType(v) {
	neighborhoodType = v;
}
export function getNeighborRange() {
	return neighborRange;
}
export function setNeighborRangeValue(v) {
	neighborRange = v;
}
export function getMinNeighborWeight() {
	return minNeighborWeight;
}
export function setMinNeighborWeight(v) {
	minNeighborWeight = v;
}
export function getNRings() {
	return nRings;
}
export function setNRings(v) {
	nRings = v;
}
export function getWeights() {
	return weights;
}
export function getRulesByState() {
	return rulesByState;
}
export function getColors() {
	return colors;
}
export function getCurrentPaletteId() {
	return currentPaletteId;
}
export function getPaletteOrderIdx() {
	return paletteOrderIdx;
}
export function getNextWeightsIdx() {
	return nextWeightsIdx;
}
export function getPaletteOffset() {
	return paletteOffset;
}
export function getRingInnerRadii() {
	return ringInnerRadii;
}
export function getRingOuterRadii() {
	return ringOuterRadii;
}
export function getRingWeights() {
	return ringWeights;
}

function getRulesetStart(stateIndex) {
	return stateIndex * MAX_N_RULES;
}

/** Ring boundary distance: Von Neumann = Manhattan; Euclid = Euclidean; others = Chebyshev. */
export function cellDist(dx, dy, nhType) {
	if (nhType === 1) return Math.abs(dx) + Math.abs(dy);
	if (nhType === 5) return Math.sqrt(dx * dx + dy * dy);
	return Math.max(Math.abs(dx), Math.abs(dy));
}

export function getRuleset(ruleCount, stateIndex) {
	const start = getRulesetStart(stateIndex);
	return rulesByState.subarray(start, start + ruleCount);
}

export function setRuleset(ruleCount, stateIndex, values) {
	const start = getRulesetStart(stateIndex);
	rulesByState.set(values.subarray(0, ruleCount), start);
}

export function generateRingRadii() {
	const useEuclidean = euclideanRings || neighborhoodType === 5;
	if (nRings === 1) {
		ringInnerRadii[0] = 1;
		ringOuterRadii[0] = neighborRange;
	} else if (useEuclidean) {
		const maxR = neighborRange;
		const step = maxR / nRings;
		for (let i = 0; i < nRings; i++) {
			ringInnerRadii[i] = Math.max(1, i * step);
			ringOuterRadii[i] = Math.max(ringInnerRadii[i], (i + 1) * step);
		}
	} else {
		const maxR = neighborRange;
		const step = maxR / nRings;
		for (let i = 0; i < nRings; i++) {
			const base = Math.floor(i * step);
			ringInnerRadii[i] = Math.max(1, base + 1);
			ringOuterRadii[i] = Math.max(ringInnerRadii[i], Math.floor((i + 1) * step));
		}
	}
	for (let i = nRings; i < MAX_N_RINGS; i++) {
		ringInnerRadii[i] = 0;
		ringOuterRadii[i] = 0;
	}
}

export function generateRings() {
	generateRingRadii();
	if (nRings === 1) {
		ringWeights[0] = 1.0;
	} else {
		for (let i = 0; i < nRings; i++) {
			ringWeights[i] = 1 / Math.pow(2, i);
		}
	}
	for (let i = nRings; i < MAX_N_RINGS; i++) {
		ringWeights[i] = 0;
	}
}

/** v<=5 ring weight formula: alternating 1.0 / -0.5. */
function legacyRingWeightsFor(n) {
	const w = [];
	for (let i = 0; i < n; i++) w.push(i % 2 === 0 ? 1.0 : -0.5);
	return w;
}

export function applyRingWeightsFromSnapshot(snapshotRingWeights) {
	for (let i = 0; i < snapshotRingWeights.length; i++) {
		ringWeights[i] = snapshotRingWeights[i];
	}
	for (let i = snapshotRingWeights.length; i < MAX_N_RINGS; i++) {
		ringWeights[i] = 0;
	}
}

export function countCellsInRing(innerR, outerR) {
	let count = 0;
	const iOuter = Math.floor(outerR);
	for (let dx = -iOuter; dx <= iOuter; dx++) {
		for (let dy = -iOuter; dy <= iOuter; dy++) {
			if (dx === 0 && dy === 0) continue;
			const useEuclidean = euclideanRings || neighborhoodType === 5;
			const dist = useEuclidean
				? Math.sqrt(dx * dx + dy * dy)
				: cellDist(dx, dy, neighborhoodType);
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

export function recalcMinNeighborWeight() {
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
		return false;
	}
	return true;
}

export function getCurrentRuleCount() {
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

export function getColorsForUniform() {
	const nColors = rawPalettes[currentPaletteId].length;
	return Array.from({ length: MAX_N_STATES }, (_, i) => {
		const sourceState = (i + paletteOffset) % nColors;
		const sourceIndex = sourceState * 3;
		return [colors[sourceIndex], colors[sourceIndex + 1], colors[sourceIndex + 2]];
	});
}

export function setPaletteOffset(nextOffset) {
	const nColors = rawPalettes[currentPaletteId].length;
	const normalizedOffset = ((nextOffset % nColors) + nColors) % nColors;
	if (paletteOffset === normalizedOffset) return false;
	paletteOffset = normalizedOffset;
	return true;
}

export function resetPaletteOffset() {
	return setPaletteOffset(0);
}

export function createRandomRuleset(ruleCount) {
	const newRules = Array.from({ length: ruleCount }, (_, i) => {
		if (i < nStates && cellInertia < 1) return i + 1;
		return Math.random() < cellInertia ? 0 : Math.floor(Math.random() * (nStates + 1));
	});
	shuffleArray(newRules);
	return new Uint8Array(newRules);
}

const N_WEIGHT_DISTRIBUTIONS = 4;
export function updateWeights(direction = 1) {
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
			const pattern = [0, 0.5, 1, 0.5, 0].map((n) => n * MAX_WEIGHT);
			for (let i = 0; i < MAX_N_STATES; ++i) weights[i] = pattern[i % pattern.length];
			returnLabel = '0, ½, 1, ½, 0…';
			break;
		}
		case 3:
			for (let i = 0; i < MAX_N_STATES; ++i) weights[i] = Math.random() * MAX_WEIGHT;
			returnLabel = 'random';
			break;
	}
	return returnLabel;
}

export function getStateSnapshot() {
	const ruleCount = getCurrentRuleCount();
	const storedRulesetCount = isSemitotalistic ? nStates : 1;
	const rulesList = [];
	for (let stateIndex = 0; stateIndex < storedRulesetCount; stateIndex++) {
		rulesList.push(Array.from(getRuleset(ruleCount, stateIndex)));
	}
	return {
		nStates,
		weights: Array.from(weights.slice(0, nStates)),
		neighborRange,
		nRings,
		ringInnerRadii: Array.from(ringInnerRadii.slice(0, nRings)),
		ringOuterRadii: Array.from(ringOuterRadii.slice(0, nRings)),
		ringWeights: Array.from(ringWeights.slice(0, nRings)),
		euclideanRings,
		neighborhoodType,
		neighborhoodTypeName: NEIGHBORHOOD_TYPES[neighborhoodType],
		wrapBehaviour,
		wrapBehaviourName: WRAP_BEHAVIOURS[wrapBehaviour],
		isSemitotalistic,
		minNeighborWeight,
		ruleCount,
		rulesByState: rulesList,
		colors: getColorsForUniform().slice(0, nStates),
		currentPaletteId,
		paletteOffset,
		nextWeightsIdx,
	};
}

const RING_WEIGHT_SCALE = 127;

function serializeSnapshot(snapshot) {
	const { nStates: ns, ruleCount, isSemitotalistic: semi, nRings: nr } = snapshot;
	const storedRulesetCount = semi ? ns : 1;
	const rulesByteLength = storedRulesetCount * ruleCount;
	// v6 appends nRings ring-weight bytes (signed int8, value = byte / 127)
	const n = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 3 + 2 + 2 + rulesByteLength + ns + nr;
	const buf = new Uint8Array(n);
	const dv = new DataView(buf.buffer);
	let off = 0;
	buf[off++] = STATE_VERSION;
	buf[off++] = ns;
	buf[off++] = snapshot.neighborRange;
	buf[off++] = nr;
	buf[off++] = Math.round(snapshot.cellInertia * 255);
	buf[off++] =
		(snapshot.neighborhoodType & 0x07) |
		((snapshot.nextWeightsIdx & 0x03) << 3) |
		(semi ? 0x20 : 0) |
		((snapshot.wrapBehaviour & 0x03) << 6);
	const po = Math.min(MAX_N_STATES - 1, Math.max(0, snapshot.paletteOffset));
	buf[off++] = (po & 31) | ((snapshot.wrapBehaviour >> 2) << 5);
	const pid = snapshot.currentPaletteId || paletteIds[0];
	for (let i = 0; i < 3; i++) buf[off++] = pid.charCodeAt(i);
	dv.setInt16(off, snapshot.minNeighborWeight, true);
	off += 2;
	dv.setUint16(off, ruleCount, true);
	off += 2;
	for (let stateIndex = 0; stateIndex < storedRulesetCount; stateIndex++) {
		const ruleset = snapshot.rulesByState[stateIndex];
		for (let i = 0; i < ruleCount; i++) buf[off++] = ruleset[i];
	}
	const w = snapshot.weights;
	for (let i = 0; i < ns; i++) buf[off++] = Math.min(255, Math.round((w[i] ?? 0) * WEIGHT_SCALE));
	const rw = snapshot.ringWeights;
	for (let i = 0; i < nr; i++) {
		const clamped = Math.max(-1, Math.min(1, rw[i] ?? 0));
		dv.setInt8(off++, Math.round(clamped * RING_WEIGHT_SCALE));
	}
	return buf;
}

function applySnapshot(snapshot) {
	nStates = snapshot.nStates;
	neighborRange = snapshot.neighborRange;
	nRings = snapshot.nRings;
	euclideanRings = snapshot.euclideanRings ?? false;
	cellInertia = snapshot.cellInertia ?? cellInertia;
	neighborhoodType = snapshot.neighborhoodType;
	nextWeightsIdx = snapshot.nextWeightsIdx ?? 0;
	isSemitotalistic = snapshot.isSemitotalistic;
	wrapBehaviour =
		snapshot.wrapBehaviour < N_WRAP_BEHAVIOURS ? snapshot.wrapBehaviour : 0;
	currentPaletteId =
		snapshot.currentPaletteId in rawPalettes ? snapshot.currentPaletteId : paletteIds[0];
	paletteOrderIdx = paletteIds.indexOf(currentPaletteId);
	if (paletteOrderIdx === -1) paletteOrderIdx = 0;
	const nColors = rawPalettes[currentPaletteId].length;
	paletteOffset = ((snapshot.paletteOffset % nColors) + nColors) % nColors;
	minNeighborWeight = snapshot.minNeighborWeight;
	const ruleCount = snapshot.ruleCount;
	const storedRulesetCount = snapshot.isSemitotalistic ? snapshot.nStates : 1;
	rulesByState.fill(0);
	for (let stateIndex = 0; stateIndex < storedRulesetCount; stateIndex++) {
		const ruleset = new Uint8Array(snapshot.rulesByState[stateIndex]);
		setRuleset(ruleCount, stateIndex, ruleset);
	}
	if (!snapshot.isSemitotalistic) {
		const shared = new Uint8Array(snapshot.rulesByState[0]);
		for (let stateIndex = 1; stateIndex < nStates; stateIndex++) {
			setRuleset(ruleCount, stateIndex, shared);
		}
	}
	const w = snapshot.weights;
	for (let i = 0; i < nStates; i++) weights[i] = w[i] ?? 0;
	if (snapshot.ringWeights) {
		applyRingWeightsFromSnapshot(snapshot.ringWeights);
	}
}

function deserializeToSnapshot(buf) {
	const fail = (reason, details = {}) => ({ ok: false, reason, ...details });
	if (!buf || buf.length < 13) return fail('buffer too short', { length: buf?.length });
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let off = 0;
	const version = buf[off++];
	if (!SUPPORTED_STATE_VERSIONS.includes(version))
		return fail('unsupported state version', { version, supported: SUPPORTED_STATE_VERSIONS });

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
		newIsSemitotalistic = version >= 3 ? (flags & 0x20) !== 0 : false;
		newWrapBehaviour = version >= 3 ? (flags >> 6) & 0x03 : 0;
	}
	if (newNStates < MIN_N_STATES || newNStates > MAX_N_STATES)
		return fail('nStates out of range', { newNStates, min: MIN_N_STATES, max: MAX_N_STATES });

	let newPaletteOffset = 0;
	let newPaletteId;
	let newMinNeighborWeight;
	let ruleCount;
	if (version >= 3) {
		if (off + 8 > buf.length) return fail('buffer too short for v3+ header', { off, length: buf.length });
		const paletteByte = buf[off++];
		newPaletteOffset = paletteByte & 31;
		newWrapBehaviour |= (paletteByte >> 5) << 2;
		if (newPaletteOffset >= MAX_N_STATES)
			return fail('paletteOffset out of range', { newPaletteOffset, max: MAX_N_STATES });
		newPaletteId = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2]);
		off += 3;
		newMinNeighborWeight = dv.getInt16(off, true);
		off += 2;
		ruleCount = dv.getUint16(off, true);
		off += 2;
		if (ruleCount < 1 || ruleCount > MAX_N_RULES)
			return fail('ruleCount out of range', { ruleCount, min: 1, max: MAX_N_RULES });
	} else {
		newPaletteId = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2]);
		off += 3;
		newMinNeighborWeight = dv.getInt16(off, true);
		off += 2;
		ruleCount = dv.getUint16(off, true);
		off += 2;
		if (ruleCount < 1 || ruleCount > MAX_N_RULES)
			return fail('ruleCount out of range', { ruleCount, min: 1, max: MAX_N_RULES });
	}

	const expectedRulesLength = version >= 3 ? (newIsSemitotalistic ? newNStates : 1) * ruleCount : ruleCount;
	if (buf.length < off + expectedRulesLength + newNStates)
		return fail('buffer too short for rules+weights', {
			bufLength: buf.length,
			off,
			expectedRulesLength,
			newNStates,
			need: off + expectedRulesLength + newNStates,
		});

	const rulesList = [];
	if (version >= 3 && newIsSemitotalistic) {
		for (let stateIndex = 0; stateIndex < newNStates; stateIndex++) {
			rulesList.push(Array.from(buf.subarray(off, off + ruleCount)));
			off += ruleCount;
		}
	} else {
		const shared = Array.from(buf.subarray(off, off + ruleCount));
		off += ruleCount;
		for (let stateIndex = 0; stateIndex < newNStates; stateIndex++) {
			rulesList.push(shared);
		}
	}
	const weightsArr = [];
	for (let i = 0; i < newNStates; i++) weightsArr.push(buf[off++] / WEIGHT_SCALE);

	let ringWeightsArr;
	if (version >= 6) {
		if (buf.length < off + newNRings)
			return fail('buffer too short for ring weights', { off, newNRings, bufLength: buf.length });
		ringWeightsArr = [];
		for (let i = 0; i < newNRings; i++) ringWeightsArr.push(dv.getInt8(off++) / RING_WEIGHT_SCALE);
	} else {
		ringWeightsArr = newNRings <= 1 ? [1.0] : legacyRingWeightsFor(newNRings);
	}

	const snapshot = {
		nStates: newNStates,
		neighborRange: newNeighborRange,
		nRings: newNRings,
		cellInertia: newCellInertia,
		neighborhoodType: newNeighborhoodType,
		neighborhoodTypeName: NEIGHBORHOOD_TYPES[newNeighborhoodType],
		wrapBehaviour: newWrapBehaviour < N_WRAP_BEHAVIOURS ? newWrapBehaviour : 0,
		wrapBehaviourName: WRAP_BEHAVIOURS[newWrapBehaviour < N_WRAP_BEHAVIOURS ? newWrapBehaviour : 0],
		nextWeightsIdx: newNextWeightsIdx,
		isSemitotalistic: newIsSemitotalistic,
		minNeighborWeight: newMinNeighborWeight,
		ruleCount,
		rulesByState: rulesList,
		weights: weightsArr,
		ringWeights: ringWeightsArr,
		colors: [],
		currentPaletteId: newPaletteId in rawPalettes ? newPaletteId : paletteIds[0],
		paletteOffset: 0,
	};
	const nColors = rawPalettes[snapshot.currentPaletteId].length;
	snapshot.paletteOffset = ((newPaletteOffset % nColors) + nColors) % nColors;
	snapshot.euclideanRings = version <= 4;
	return { ok: true, snapshot, ruleCount };
}

export function packState() {
	const snapshot = getStateSnapshot();
	if (snapshot.ruleCount < 1) return null;
	return serializeSnapshot({ ...snapshot, cellInertia: getCellInertia() });
}

export function unpackState(buf) {
	const result = deserializeToSnapshot(buf);
	if (!result.ok) return result;
	applySnapshot(result.snapshot);
	return { ok: true, ruleCount: result.ruleCount };
}

export function encodeState() {
	const buf = packState();
	if (!buf) return null;
	return compressToUrl(buf);
}

export function restoreStateFromUrl(encoded, onApplied) {
	try {
		const buf = decompressFromUrl(encoded);
		const result = unpackState(buf);
		if (!result.ok) {
			console.error('restoreStateFromUrl: unpack failed', result.reason, result);
			return false;
		}
		onApplied(result.ruleCount);
		return true;
	} catch (err) {
		console.error('restoreStateFromUrl:', err);
		return false;
	}
}

export function applyColorsFromPalette() {
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
}

export function setPaletteFromSnapshot(currentPaletteIdIn, paletteOffsetIn) {
	currentPaletteId = currentPaletteIdIn in rawPalettes ? currentPaletteIdIn : paletteIds[0];
	paletteOrderIdx = paletteIds.indexOf(currentPaletteId);
	if (paletteOrderIdx === -1) paletteOrderIdx = 0;
	const nColors = rawPalettes[currentPaletteId].length;
	paletteOffset = ((paletteOffsetIn % nColors) + nColors) % nColors;
}

export function setColorsFromPaletteAndOffset() {
	applyColorsFromPalette();
}

export function updateColorsState(direction = 1) {
	paletteOffset = 0;
	paletteOrderIdx = (paletteIds.length + paletteOrderIdx + direction) % paletteIds.length;
	currentPaletteId = paletteIds[paletteOrderIdx];
	applyColorsFromPalette();
}
