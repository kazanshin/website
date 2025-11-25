// door.js
//
// Handles the interaction with the vault door. When the user clicks
// or presses Enter/Space on the door, a custom 'vault:doorOpen' event
// is dispatched to trigger the puzzle overlay. Once the puzzle is
// solved, a 'vault:puzzleSolved' event listener animates the door to
// an open state.

export function initDoor() {
  const doorButton = document.getElementById('vault-door');
  if (!doorButton) return;

  /**
   * Handle activation of the door via click or keyboard.
   * Dispatch a custom event to signal that the puzzle should appear.
   */
  const handleActivate = (event) => {
    if (
      event.type === 'click' ||
      (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' '))
    ) {
      event.preventDefault();
      // Emit a custom event on the document to trigger puzzle overlay
      document.dispatchEvent(new CustomEvent('vault:doorOpen'));
    }
  };

  doorButton.addEventListener('click', handleActivate);
  doorButton.addEventListener('keydown', handleActivate);

  // When the puzzle has been solved, animate the door open
  document.addEventListener('vault:puzzleSolved', () => {
    doorButton.classList.add('opened');
  });
}