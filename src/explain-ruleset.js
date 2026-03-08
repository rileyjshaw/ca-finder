import { MAX_N_RINGS, cellDist } from './state.js';

const WRAP_EXPLANATIONS = {
	Wrap: 'it wraps around to the opposite edge',
	Reflect: 'it reflects back from the edge',
	Clamp: 'it reads the nearest edge cell',
	Brick: 'it wraps with a half-row offset on alternating rows (like bricks)',
	Stair: 'it wraps with a half-column offset on alternating columns (like stairs)',
};

function rgbToCss(rgb) {
	const [r, g, b] = rgb.map(x => Math.round((x ?? 0) * 255));
	return `rgb(${r},${g},${b})`;
}

const GOLDEN_ANGLE = 360 * (1 - 1 / ((1 + Math.sqrt(5)) / 2)); // ~137.508°

function ringHue(ringIndex) {
	return (ringIndex * GOLDEN_ANGLE + 65) % 360;
}

function getRingForCell(dx, dy, snapshot) {
	const { nRings, ringInnerRadii, ringOuterRadii, neighborhoodType } = snapshot;
	const useEuclidean = !!snapshot.euclideanRings || neighborhoodType === 5;
	const dist2 = dx * dx + dy * dy;
	for (let r = 0; r < nRings; r++) {
		const inner = ringInnerRadii[r];
		const outer = ringOuterRadii[r];
		const iOuter = Math.floor(outer);
		const iInner = Math.floor(inner);
		if (Math.abs(dx) > iOuter || Math.abs(dy) > iOuter) continue;
		if (useEuclidean) {
			const inner2 = inner * inner;
			const outer2 = outer * outer;
			if (dist2 < inner2 || dist2 > outer2) continue;
		} else {
			const d = cellDist(dx, dy, neighborhoodType);
			if (d < iInner || d > iOuter) continue;
		}
		if (neighborhoodType === 1 && Math.abs(dx) + Math.abs(dy) > iOuter) continue;
		if (neighborhoodType === 2 && dx !== 0 && dy !== 0) continue;
		if (neighborhoodType === 3 && Math.abs(dx) !== Math.abs(dy)) continue;
		if (neighborhoodType === 4 && ((dx + dy) & 1) !== 0) continue;
		return r;
	}
	return -1;
}

function getCellType(dx, dy, snapshot) {
	if (dx === 0 && dy === 0) return 'inactive';
	const ring = getRingForCell(dx, dy, snapshot);
	return ring >= 0 ? 'active' : 'inactive';
}

export function renderExplainPanel(snapshot) {
	const panel = document.createElement('div');
	panel.className = 'explain-panel';

	const nStates = snapshot.nStates;
	const nRings = snapshot.nRings;
	const range = snapshot.neighborRange;
	const gridExtent = range + 1;
	const side = 2 * gridExtent + 1;

	const header = document.createElement('h1');
	header.textContent = 'You found one!';
	panel.appendChild(header);
	const nStatesText = document.createElement('p');
	nStatesText.innerHTML = `Each cellular automaton cell exists in one of <strong>${nStates}</strong> states:`;
	panel.appendChild(nStatesText);

	const statesList = document.createElement('ul');
	statesList.className = 'explain-panel-states-list';
	for (let i = 0; i < nStates; i++) {
		const li = document.createElement('li');
		li.className = 'explain-panel-state-item';
		const box = document.createElement('div');
		box.className = 'explain-panel-state-box';
		box.style.backgroundColor = rgbToCss(snapshot.colors[i]);
		const label = document.createElement('span');
		label.textContent = i + 1;
		li.appendChild(box);
		li.appendChild(label);
		statesList.appendChild(li);
	}
	panel.appendChild(statesList);

	const weightsLabel = document.createElement('p');
	weightsLabel.textContent = 'With the following weights:';
	panel.appendChild(weightsLabel);
	const weightsList = document.createElement('ul');
	weightsList.className = 'explain-panel-states-list';
	for (let i = 0; i < nStates; i++) {
		const li = document.createElement('li');
		li.className = 'explain-panel-state-item';
		const box = document.createElement('div');
		box.className = 'explain-panel-state-box';
		box.style.backgroundColor = rgbToCss(snapshot.colors[i]);
		const label = document.createElement('span');
		label.textContent = String(snapshot.weights[i]);
		li.appendChild(box);
		li.appendChild(label);
		weightsList.appendChild(li);
	}
	panel.appendChild(weightsList);

	const neighLabel = document.createElement('p');
	neighLabel.innerHTML = `Each automaton sums the weights of its neighbors within a <strong>${snapshot.neighborhoodTypeName}</strong> neighborhood. The neighborhood has a radius of <strong>${range}</strong>${nRings > 1 ? ` and <strong>${nRings}</strong> weight rings` : ''}, which looks like this:`;
	panel.appendChild(neighLabel);

	const neighWrap = document.createElement('div');
	neighWrap.className = 'explain-panel-neighborhood-wrap';

	const grid = document.createElement('div');
	grid.className = 'explain-panel-neighborhood-grid';
	grid.style.gridTemplateColumns = `repeat(${side}, 1fr)`;
	grid.style.gridTemplateRows = `repeat(${side}, 1fr)`;
	for (let dy = -gridExtent; dy <= gridExtent; dy++) {
		for (let dx = -gridExtent; dx <= gridExtent; dx++) {
			const cell = document.createElement('div');
			cell.className = 'explain-panel-neighborhood-cell';
			const ring = dx === 0 && dy === 0 ? -2 : getRingForCell(dx, dy, snapshot);
			const cellType = getCellType(dx, dy, snapshot);
			if (ring === -2) {
				cell.classList.add('explain-panel-neighborhood-center');
				cell.style.background = '#444';
			} else if (ring >= 0) {
				const hue = ringHue(ring);
				cell.style.background = `oklch(85% 0.15 ${hue})`;
				cell.style.borderColor = `oklch(60% 0.15 ${hue})`;
			} else {
				cell.style.background = '#999';
				cell.style.borderColor = '#555';
			}
			const neighbors = [
				{ dx: dx, dy: dy - 1, side: 'top' },
				{ dx: dx + 1, dy: dy, side: 'right' },
				{ dx: dx, dy: dy + 1, side: 'bottom' },
				{ dx: dx - 1, dy: dy, side: 'left' },
			];
			for (const { dx: nx, dy: ny, side } of neighbors) {
				if (nx < -gridExtent || nx > gridExtent || ny < -gridExtent || ny > gridExtent) continue;
				const neighborType = getCellType(nx, ny, snapshot);
				if (cellType !== neighborType) {
					cell.classList.add(`explain-panel-cell-border-${side}-white`);
				}
			}
			grid.appendChild(cell);
		}
	}
	neighWrap.appendChild(grid);

	const legend = document.createElement('ul');
	legend.className = 'explain-panel-ring-legend';
	legend.setAttribute('aria-label', 'Ring weights');
	for (let r = 0; r < nRings; r++) {
		const li = document.createElement('li');
		li.className = 'explain-panel-ring-legend-item';
		const swatch = document.createElement('div');
		swatch.className = 'explain-panel-ring-swatch';
		swatch.style.background = `oklch(85% 0.15 ${ringHue(r)})`;
		const text = document.createElement('span');
		const ringWeight = snapshot.ringWeights[r];
		const displayWeight = Number.isInteger(ringWeight)
			? String(ringWeight)
			: ringWeight.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
		text.textContent = `Weight × ${displayWeight}`;
		li.appendChild(swatch);
		li.appendChild(text);
		legend.appendChild(li);
	}
	neighWrap.appendChild(legend);
	panel.appendChild(neighWrap);

	const wrapP = document.createElement('p');
	wrapP.innerHTML = `If a neighbor is out-of-frame, ${WRAP_EXPLANATIONS[snapshot.wrapBehaviourName] ?? WRAP_EXPLANATIONS.Wrap}.`;
	panel.appendChild(wrapP);

	const tableLabel = document.createElement('p');
	tableLabel.textContent = 'The sum of all neighbor weights determines what state the automaton transitions to:';
	panel.appendChild(tableLabel);

	const minSum = snapshot.minNeighborWeight;
	const ruleCount = snapshot.ruleCount;

	function formatSumList(sums) {
		if (sums.length === 0) return '';
		if (sums.length === 1) return String(sums[0]);
		if (sums.length === 2) return `${sums[0]} or ${sums[1]}`;
		return sums.slice(0, -1).join(', ') + ', or ' + sums[sums.length - 1];
	}

	function buildTransitionSentences(rulesRow) {
		const byState = new Map();
		for (let i = 0; i < ruleCount; i++) {
			const rule = rulesRow[i];
			if (rule === 0) continue;
			const sum = minSum + i;
			const stateIndex = rule - 1;
			if (!byState.has(stateIndex)) byState.set(stateIndex, []);
			byState.get(stateIndex).push(sum);
		}
		const wrap = document.createElement('div');
		wrap.className = 'explain-panel-transition-sentences';
		const entries = [...byState.entries()].sort((a, b) => a[0] - b[0]);
		for (const [stateIndex, sums] of entries) {
			sums.sort((a, b) => a - b);
			const p = document.createElement('p');
			p.className = 'explain-panel-transition-sentence';
			const box = document.createElement('span');
			box.className = 'explain-panel-state-box';
			box.style.backgroundColor = rgbToCss(snapshot.colors[stateIndex]);
			const list = formatSumList(sums);
			p.appendChild(document.createTextNode('Become '));
			p.appendChild(box);
			p.appendChild(document.createTextNode(` State ${stateIndex + 1} if the sum is ${list}.`));
			wrap.appendChild(p);
		}
		return { wrap, hasNoChange: rulesRow.some(r => r === 0) };
	}

	if (snapshot.isSemitotalistic) {
		for (let s = 0; s < nStates; s++) {
			const section = document.createElement('section');
			section.className = 'explain-panel-transition-section';
			const h3 = document.createElement('h3');
			h3.textContent = `When in State ${s + 1}:`;
			section.appendChild(h3);
			const { wrap, hasNoChange } = buildTransitionSentences(snapshot.rulesByState[s]);
			section.appendChild(wrap);
			if (hasNoChange) {
				const noChangeP = document.createElement('p');
				noChangeP.textContent = 'Any other sum leaves the state unchanged.';
				section.appendChild(noChangeP);
			}
			panel.appendChild(section);
		}
	} else {
		const { wrap, hasNoChange } = buildTransitionSentences(snapshot.rulesByState[0]);
		panel.appendChild(wrap);
		if (hasNoChange) {
			const noChangeP = document.createElement('p');
			noChangeP.textContent = 'Any other sum leaves the state unchanged.';
			panel.appendChild(noChangeP);
		}
	}

	const frameP = document.createElement('p');
	frameP.textContent = 'On each frame, these rules are applied to every cell, producing emergent structures.';
	panel.appendChild(frameP);

	const footer = document.createElement('div');
	footer.className = 'explain-panel-footer';
	const backBtn = document.createElement('button');
	backBtn.type = 'button';
	backBtn.className = 'explain-panel-btn explain-panel-btn-secondary';
	backBtn.textContent = 'Back to controls';
	const takeLookBtn = document.createElement('button');
	takeLookBtn.type = 'button';
	takeLookBtn.className = 'explain-panel-btn explain-panel-btn-primary';
	takeLookBtn.textContent = 'Take a look';
	footer.appendChild(backBtn);
	footer.appendChild(takeLookBtn);
	panel.appendChild(footer);

	panel._backBtn = backBtn;
	panel._takeLookBtn = takeLookBtn;

	return panel;
}
