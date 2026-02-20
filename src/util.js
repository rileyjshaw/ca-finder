export function hexToNormalizedRGB(hex) {
	if (hex.startsWith('#')) {
		hex = hex.substring(1);
	}

	let r = parseInt(hex.substring(0, 2), 16) / 255;
	let g = parseInt(hex.substring(2, 4), 16) / 255;
	let b = parseInt(hex.substring(4, 6), 16) / 255;

	return [r, g, b];
}

// Shuffle an array in place.
export function shuffleArray(array) {
	if (array.length <= 1) return;
	for (let i = array.length - 1; i > 0; --i) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
}

export function repeatArrayToLength(array, length) {
	return Array.from({ length }, (_, i) => array[i % array.length]);
}

// Convert a binary fraction to a decimal number.
export function binaryFractionToDecimal(binaryFraction) {
	let decimal = 0;
	// Split the binary string at the decimal point
	let parts = binaryFraction.split('.');
	if (parts.length === 2) {
		let fractionPart = parts[1];
		for (let i = 0; i < fractionPart.length; i++) {
			// For each digit after the decimal, convert and sum up
			decimal += parseInt(fractionPart[i]) * Math.pow(2, -(i + 1));
		}
	}
	return decimal;
}

// Generate an array of length `length`, where each element is within `bounds`.
// The first two elements are the `bounds`, and each subsequent element is the
// furthest possible number from all previous elements. For instance:
// generateFurthestSubsequentDistanceArray(5, [0, 1]) => [0, 1, 0.5, 0.25, 0.75]
export function generateFurthestSubsequentDistanceArray(length, bounds = [0, 1]) {
	const [min, max] = bounds;
	const array = [...bounds];
	const step = (max - min) / (length - 1);

	const prevIndices = [[0, length - 1]];

	for (let i = 2; i < length; i++) {
		const [prevMinIndex, prevMaxIndex] = prevIndices.shift();
		const middleIndex = Math.ceil((prevMinIndex + prevMaxIndex) / 2);
		array[i] = min + step * middleIndex;
		prevIndices.push([prevMinIndex, middleIndex]);
		prevIndices.push([middleIndex, prevMaxIndex]);
	}

	return array;
}

import { deflateSync, inflateSync } from 'fflate';

// Base64url: URL and filename safe, 6 bits per char, no padding.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < B64_CHARS.length; i++) B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;

function toBase64url(bytes) {
	let result = '';
	const len = bytes.length;
	let i = 0;
	while (i < len) {
		const b0 = bytes[i++];
		const b1 = i < len ? bytes[i++] : 0;
		const b2 = i < len ? bytes[i++] : 0;
		result += B64_CHARS[b0 >> 2];
		result += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
		if (i > len + 1) break;
		result += B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)];
		if (i > len) break;
		result += B64_CHARS[b2 & 63];
	}
	return result;
}

function fromBase64url(str) {
	const len = str.length;
	const outLen = (len * 3) >> 2;
	const out = new Uint8Array(outLen);
	let j = 0;
	for (let i = 0; i < len; i += 4) {
		const c0 = B64_LOOKUP[str.charCodeAt(i)];
		const c1 = B64_LOOKUP[str.charCodeAt(i + 1)];
		const c2 = i + 2 < len ? B64_LOOKUP[str.charCodeAt(i + 2)] : 0;
		const c3 = i + 3 < len ? B64_LOOKUP[str.charCodeAt(i + 3)] : 0;
		out[j++] = (c0 << 2) | (c1 >> 4);
		if (j < outLen) out[j++] = ((c1 & 15) << 4) | (c2 >> 2);
		if (j < outLen) out[j++] = ((c2 & 3) << 6) | c3;
	}
	return out;
}

export function compressToUrl(bytes) {
	const compressed = deflateSync(bytes, { level: 9 });
	return toBase64url(compressed);
}

export function decompressFromUrl(str) {
	const compressed = fromBase64url(str);
	return inflateSync(compressed);
}
