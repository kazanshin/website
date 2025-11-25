// puzzle.js
//
// Renders an accessible puzzle overlay when the door is opened. The
// default puzzle is a set of three range sliders representing glyphs
// that must be aligned to specific values. When the user aligns the
// sliders within a tolerance, or chooses to skip, the puzzle is marked
// as solved in localStorage and a 'vault:puzzleSolved' event is
// dispatched. The overlay respects the prefers‑reduced‑motion setting
// by using simple opacity transitions.

export function initPuzzle() {
  const overlay = document.getElementById('puzzle-overlay');
  const puzzleArea = document.getElementById('puzzle-area');
  const skipLink = document.getElementById('skip-puzzle');

  if (!overlay || !puzzleArea || !skipLink) return;

  /**
   * Complete the puzzle, persist state and emit a completion event.
   */
  function completePuzzle() {
    localStorage.setItem('puzzleSolved', 'true');
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    document.dispatchEvent(new CustomEvent('vault:puzzleSolved'));
  }

  /**
   * Build and display the puzzle. If already solved, skip display and
   * immediately emit the solved event.
   */
  function showPuzzle() {
    // If solved previously, bypass puzzle and dispatch solved event
    if (localStorage.getItem('puzzleSolved') === 'true') {
      document.dispatchEvent(new CustomEvent('vault:puzzleSolved'));
      return;
    }

    // Reveal the overlay
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');

    // Clear any previous puzzle content
    puzzleArea.innerHTML = '';

    // Define target values for each glyph slider and an array for current values
    const targets = [30, 60, 90];
    const values = [0, 0, 0];

    // Create a slider for each target
    targets.forEach((target, index) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'puzzle-input-wrapper';

      const label = document.createElement('label');
      label.textContent = `Glyph ${index + 1}`;
      label.setAttribute('for', `puzzle-input-${index}`);

      const input = document.createElement('input');
      input.id = `puzzle-input-${index}`;
      input.type = 'range';
      input.min = 0;
      input.max = 100;
      input.value = 0;
      input.setAttribute('aria-label', `Set glyph ${index + 1} to ${target}`);
      // When the slider changes, update the value and check if solved
      input.addEventListener('input', () => {
        values[index] = parseInt(input.value);
        checkSolved();
      });

      wrapper.appendChild(label);
      wrapper.appendChild(input);
      puzzleArea.appendChild(wrapper);
    });

    // Provide a skip link for users unable to complete the visual puzzle
    skipLink.addEventListener('click', (e) => {
      e.preventDefault();
      completePuzzle();
    });

    /**
     * Check whether all sliders are within a tolerance of their targets.
     * If so, mark puzzle as complete.
     */
    function checkSolved() {
      const solved = values.every((v, i) => Math.abs(v - targets[i]) <= 2);
      if (solved) {
        completePuzzle();
      }
    }
  }

  // Listen for the door opening to show the puzzle
  document.addEventListener('vault:doorOpen', showPuzzle);

  // On initial load, hide the overlay if the puzzle has already been solved
  if (localStorage.getItem('puzzleSolved') === 'true') {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }
}